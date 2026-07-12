import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createRuntimeHost,
  DefaultStrategyGuard,
  InMemoryAgentRegistry,
  InMemoryToolRegistry,
  renderStageAgentPrompt,
  renderStageReviewPrompt,
  StageContractRunner,
  ToolRuntime
} from "@jiuwen-sci/core";
import { getLiteratureConnectorRegistry, literaturePack, normalizeLiteratureDatabaseIds, toArxivSearchQuery } from "@jiuwen-sci/literature-pack";

async function tempRuntime() {
  const cwd = await mkdtemp(path.join(tmpdir(), "jiuwen-sci-test-"));
  const runtime = await createRuntimeHost({ cwd, model: "mock:deterministic" });
  await runtime.start();
  return { cwd, runtime, cleanup: async () => { await runtime.stop(); await rm(cwd, { recursive: true, force: true }); } };
}

test("registries reject duplicates and list tools", () => {
  const agents = new InMemoryAgentRegistry();
  agents.register({ id: "a", name: "A", description: "A", mode: "subagent", prompt: "p", permissions: [] });
  assert.equal(agents.canRunAs("a", "subagent"), true);
  assert.throws(() => agents.register({ id: "a", name: "A", description: "A", mode: "subagent", prompt: "p", permissions: [] }), /AGENT_DUPLICATE/);

  const tools = new InMemoryToolRegistry();
  tools.register({ id: "t", name: "T", description: "T", inputSchema: {}, outputSchema: {}, permission: {}, execute: async () => ({ ok: true }) });
  assert.equal(tools.list().length, 1);
  assert.throws(() => tools.register({ id: "t", name: "T", description: "T", inputSchema: {}, outputSchema: {}, permission: {}, execute: async () => ({ ok: true }) }), /TOOL_DUPLICATE/);
});

test("runtime guard downgrades unsupported strategies", async () => {
  const { runtime, cleanup } = await tempRuntime();
  try {
    const guard = new DefaultStrategyGuard(runtime.services);
    const result = await guard.validate({ decision: { strategy: "best_of_n", reason: "x", confidence: 1 } });
    assert.equal(result.finalDecision.strategy, "direct");
    assert.equal(result.warnings.length, 1);
  } finally {
    await cleanup();
  }
});

test("exec direct creates session and final artifact", async () => {
  const { runtime, cleanup } = await tempRuntime();
  try {
    const result = await runtime.run({ input: "hello", strategy: "direct", model: { provider: "mock", model: "deterministic" } });
    assert.equal(result.status, "completed");
    assert.equal(result.artifactIds.length, 1);
    const session = await runtime.services.sessionStore.get(result.sessionId);
    assert.equal(session.status, "completed");
    const artifact = await runtime.services.artifactStore.get(result.artifactIds[0]);
    assert.equal(artifact.type, "markdown");
  } finally {
    await cleanup();
  }
});

test("task tool creates child session", async () => {
  const { runtime, cleanup } = await tempRuntime();
  try {
    const parent = await runtime.services.sessionStore.create({ agentId: "research-orchestrator", input: "parent", cwd: runtime.services.config.cwd });
    const result = await new ToolRuntime(runtime.services).execute({ sessionId: parent.id, agentId: "research-orchestrator", toolId: "task", input: { agentId: "task-agent", description: "child", input: "child work" } });
    const output = result.output;
    assert.match(output.childSessionId, /^ses_/);
    const children = await runtime.services.sessionStore.children(parent.id);
    assert.equal(children.length, 1);
  } finally {
    await cleanup();
  }
});

test("blocking review finding blocks finalize", async () => {
  const { runtime, cleanup } = await tempRuntime();
  try {
    const session = await runtime.services.sessionStore.create({ agentId: "task-agent", input: "final", cwd: runtime.services.config.cwd });
    await runtime.services.reviewStore.create({ sessionId: session.id, severity: "blocking", category: "test", targetType: "session", targetRef: session.id, description: "block" });
    const result = await new ToolRuntime(runtime.services).execute({ sessionId: session.id, agentId: "task-agent", toolId: "finalize", input: { finalText: "x" } });
    assert.equal(result.output.status, "blocked");
  } finally {
    await cleanup();
  }
});

test("artifact_write serializes structured JSON input when content is omitted", async () => {
  const { runtime, cleanup } = await tempRuntime();
  try {
    const session = await runtime.services.sessionStore.create({ agentId: "task-agent", input: "artifact", cwd: runtime.services.config.cwd });
    const result = await new ToolRuntime(runtime.services).execute({
      sessionId: session.id,
      agentId: "task-agent",
      toolId: "artifact_write",
      input: { type: "json", mediaType: "application/json", name: "Protocol", stage: "protocol", question: "AI4S" }
    });
    const artifact = JSON.parse((await runtime.services.artifactStore.read(result.output.artifactId)).toString("utf8"));
    assert.equal(artifact.stage, "protocol");
    assert.equal(artifact.question, "AI4S");
  } finally {
    await cleanup();
  }
});

test("literature workflow runs with fake connector and creates traceable report", async () => {
  const { runtime, cleanup } = await tempRuntime();
  try {
    runtime.registerPack(literaturePack);
    getLiteratureConnectorRegistry(runtime.services).register({
      id: "fake",
      name: "Fake",
      description: "Fake test connector",
      async search() {
        return [
          { id: "p1", title: "AI agents for scientific discovery", authors: ["A"], year: 2026, venue: "Test", url: "https://example.test/p1", sourceDb: "fake", abstract: "Agents can help scientific discovery." }
        ];
      }
    });
    const result = await runtime.run({ input: "AI agents for scientific discovery", strategy: "workflow_controlled", metadata: { workflow: "literature-review", dbs: ["fake"], limit: 1 } });
    assert.equal(result.status, "completed");
    assert.ok(result.artifactIds.length >= 15);
    const artifacts = await Promise.all(result.artifactIds.map(async (id) => ({ id, text: (await runtime.services.artifactStore.read(id)).toString("utf8") })));
    const jsonByStage = (stage) => {
      for (const artifact of artifacts) {
        try {
          const parsed = JSON.parse(artifact.text);
          if (parsed.stage === stage) return parsed;
        } catch {}
      }
      return null;
    };
    const prisma = jsonByStage("prisma_flow");
    assert.equal(prisma.recordsIdentifiedThroughDatabaseSearching, 1);
    assert.equal(prisma.recordsAfterDeduplication, 1);
    assert.equal(prisma.studiesIncludedInSynthesis, 1);
    const searchEvent = runtime.services.eventBus.events.find((event) => event.type === "literature.search.completed" && event.db === "fake");
    assert.equal(searchEvent.query.includes("AI agents"), true);
    assert.equal(searchEvent.count, 1);
    assert.equal(searchEvent.papers[0].title, "AI agents for scientific discovery");
    const screening = jsonByStage("screening_log");
    assert.equal(screening.decisions.length, 1);
    assert.ok(screening.decisions[0].reason);
    const verification = jsonByStage("citation_verification");
    assert.equal(verification.results.length, 1);
    assert.ok(artifacts.some((a) => a.text.includes("@misc") || a.text.includes("@article")));
    const finalId = artifacts.find((a) => a.text.includes("# PRISMA-Style Literature Review"))?.id;
    assert.ok(finalId);
    const trace = await runtime.services.provenanceStore.trace(finalId);
    assert.equal(trace.nodes.length, 1);
  } finally {
    await cleanup();
  }
});

test("literature tools expose source capabilities and structured source errors", async () => {
  const { runtime, cleanup } = await tempRuntime();
  try {
    runtime.registerPack(literaturePack);
    getLiteratureConnectorRegistry(runtime.services).register({
      id: "fake-error-source",
      name: "Fake Error Source",
      description: "Fake connector for source error tests",
      metadata: {
        capabilities: { search: true, fetch: false, citationGraph: "none", abstracts: false, doi: false, fullTextLinks: false },
        queryHints: ["Use this only in tests."],
        bestFor: ["testing"]
      },
      async search() {
        throw new Error("upstream unavailable");
      }
    });
    const session = await runtime.services.sessionStore.create({ agentId: "research-orchestrator", input: "source errors", cwd: runtime.services.config.cwd });
    const toolRuntime = new ToolRuntime(runtime.services);
    const dbs = await toolRuntime.execute({ sessionId: session.id, agentId: "research-orchestrator", toolId: "science_list_dbs", input: {} });
    const fakeDb = dbs.output.databases.find((db) => db.id === "fake-error-source");
    assert.equal(fakeDb.capabilities.search, true);
    assert.deepEqual(fakeDb.queryHints, ["Use this only in tests."]);

    const search = await toolRuntime.execute({ sessionId: session.id, agentId: "research-orchestrator", toolId: "science_search", input: { db: "fake-error-source", query: "x", limit: 1 } });
    assert.equal(search.output.ok, false);
    assert.equal(search.output.operation, "search");
    assert.equal(typeof search.output.errorType, "string");
    assert.equal(typeof search.output.guidance, "string");
    assert.equal(search.output.count, 0);
  } finally {
    await cleanup();
  }
});

test("citation chain fetches connector citation graph metadata", async () => {
  const { runtime, cleanup } = await tempRuntime();
  try {
    runtime.registerPack(literaturePack);
    getLiteratureConnectorRegistry(runtime.services).register({
      id: "fake-citation-graph",
      name: "Fake Citation Graph",
      description: "Fake connector for citation chaining",
      async search() {
        return [];
      },
      async fetch(id) {
        return {
          id,
          references: [{ paperId: "ref-1", title: "Reference paper", year: 2020, externalIds: { DOI: "10.1/ref" } }],
          citations: [{ paperId: "cite-1", title: "Citing paper", year: 2025, externalIds: { DOI: "10.1/cite" } }]
        };
      }
    });
    const session = await runtime.services.sessionStore.create({ agentId: "research-orchestrator", input: "citation graph", cwd: runtime.services.config.cwd });
    const result = await new ToolRuntime(runtime.services).execute({
      sessionId: session.id,
      agentId: "research-orchestrator",
      toolId: "citation_chain",
      input: { papers: [{ id: "seed-1", title: "Seed", sourceDb: "fake-citation-graph" }], limit: 1 }
    });
    assert.equal(result.output.ok, true);
    assert.equal(result.output.records[0].fetched, true);
    assert.equal(result.output.records[0].referenceCount, 1);
    assert.equal(result.output.records[0].citationCount, 1);
    assert.equal(result.output.records[0].references[0].doi, "10.1/ref");
  } finally {
    await cleanup();
  }
});

test("literature PRISMA separates citation-chain hints from screened records", async () => {
  const { runtime, cleanup } = await tempRuntime();
  try {
    runtime.registerPack(literaturePack);
    getLiteratureConnectorRegistry(runtime.services).register({
      id: "fake-chain-review",
      name: "Fake Chain Review",
      description: "Fake connector with citation graph hints",
      async search() {
        return [
          { id: "chain-seed", title: "AI for Science materials discovery review", authors: ["A"], year: 2026, venue: "Test", url: "https://example.test/chain-seed", sourceDb: "fake-chain-review", abstract: "AI for Science accelerates materials discovery and autonomous laboratories." }
        ];
      },
      async fetch(id) {
        return {
          id,
          references: [{ id: "ref-a", title: "Reference A" }, { id: "ref-b", title: "Reference B" }],
          citations: [{ id: "cite-a", title: "Citation A" }]
        };
      }
    });
    const result = await runtime.run({
      input: "AI4S materials discovery trends",
      strategy: "workflow_controlled",
      metadata: {
        workflow: "literature-review",
        dbs: ["fake-chain-review"],
        limit: 1,
        topicProfile: {
          topicLabel: "AI4S",
          coreTerms: ["AI4S", "AI for Science", "scientific discovery"],
          domainTerms: ["materials discovery", "autonomous laboratories"],
          modifierTerms: ["trends", "review"]
        }
      }
    });
    assert.equal(result.status, "completed");
    const artifacts = await Promise.all(result.artifactIds.map(async (id) => ({ id, text: (await runtime.services.artifactStore.read(id)).toString("utf8") })));
    const parsed = artifacts.map((artifact) => {
      try { return JSON.parse(artifact.text); } catch { return null; }
    });
    const identification = parsed.find((item) => item?.stage === "identification");
    const prisma = parsed.find((item) => item?.stage === "prisma_flow");
    assert.equal(identification.recordsIdentifiedThroughDatabaseSearching, 1);
    assert.equal(identification.recordsIdentifiedThroughCitationChaining, 0);
    assert.equal(identification.citationChainHintsFound, 3);
    assert.equal(identification.citationChainHandling.mode, "hints_only");
    assert.equal(identification.citationChainHandling.recordsPromotedToScreening, false);
    assert.equal(prisma.recordsIdentifiedThroughCitationChaining, 0);
    assert.equal(prisma.citationChainHintsFound, 3);
    assert.equal(prisma.citationChainHandling.mode, "hints_only");
    assert.equal(prisma.citationChainHandling.recordsPromotedToScreening, false);
    assert.equal(prisma.totalRecordsIdentified, 1);
    const final = artifacts.find((artifact) => artifact.text.includes("# PRISMA-Style Literature Review"));
    assert.match(final.text, /Citation-chain handling: hints only/);
  } finally {
    await cleanup();
  }
});

test("literature protocol verifier prefers latest artifacts and accepts common field aliases", async () => {
  const { runtime, cleanup } = await tempRuntime();
  try {
    runtime.registerPack(literaturePack);
    const contract = runtime.services.packRegistry.getStageContract("literature-review-prisma-v1");
    const stage = contract.stages.find((item) => item.id === "protocol_query");
    const session = await runtime.services.sessionStore.create({ agentId: "research-orchestrator", input: "AI4S", cwd: runtime.services.config.cwd });
    const oldProtocol = await runtime.services.artifactStore.create({
      sessionId: session.id,
      createdBy: { sessionId: session.id, agentId: "test", toolId: "test" },
      type: "json",
      mediaType: "application/json",
      content: JSON.stringify({ stage: "protocol", databases: ["old"] })
    });
    const oldQueries = await runtime.services.artifactStore.create({
      sessionId: session.id,
      createdBy: { sessionId: session.id, agentId: "test", toolId: "test" },
      type: "json",
      mediaType: "application/json",
      content: JSON.stringify({ stage: "queries", selectedQueries: [] })
    });
    const latestProtocol = await runtime.services.artifactStore.create({
      sessionId: session.id,
      createdBy: { sessionId: session.id, agentId: "test", toolId: "test" },
      type: "json",
      mediaType: "application/json",
      content: JSON.stringify({ stage: "protocol", research_question: "AI4S status", databases: [{ name: "OpenAlex" }] })
    });
    const latestQueries = await runtime.services.artifactStore.create({
      sessionId: session.id,
      createdBy: { sessionId: session.id, agentId: "test", toolId: "test" },
      type: "json",
      mediaType: "application/json",
      content: JSON.stringify({
        stage: "queries",
        question: "AI4S status",
        concepts: [{ label: "AI for Science", synonyms: ["AI4S", "Artificial Intelligence for Science", "AI-driven scientific discovery"] }],
        selected_queries: [{ database: "OpenAlex", query_string: "\"AI for Science\" OR \"AI-driven scientific discovery\" OR \"foundation models for science\"" }]
      })
    });
    const artifactIds = [oldProtocol.id, oldQueries.id, latestProtocol.id, latestQueries.id];
    const protocolVerifier = runtime.services.verifierRegistry.get("literature_protocol_valid");
    const conceptVerifier = runtime.services.verifierRegistry.get("literature_query_concepts_valid");
    assert.equal((await protocolVerifier.verify({ sessionId: session.id, services: runtime.services, contract, stage, artifactIds, state: {} })).ok, true);
    assert.equal((await conceptVerifier.verify({ sessionId: session.id, services: runtime.services, contract, stage, artifactIds, state: {} })).ok, true);
  } finally {
    await cleanup();
  }
});

test("literature protocol query prompt includes canonical field contract", async () => {
  const { runtime, cleanup } = await tempRuntime();
  try {
    runtime.registerPack(literaturePack);
    const contract = runtime.services.packRegistry.getStageContract("literature-review-prisma-v1");
    const stage = contract.stages.find((item) => item.id === "protocol_query");
    const prompt = renderStageAgentPrompt({ contract, stage, userGoal: "AI4S", attempt: 1, feedback: [], artifactManifest: { artifacts: [], byStage: {}, byRole: {} } });
    assert.match(prompt, /Stage-specific output contract/);
    assert.match(prompt, /selectedQueries\[\]\.string/);
    assert.match(prompt, /Use query, not string/);
    assert.match(prompt, /coreTerms/);
    assert.match(prompt, /topicExpansion/);
  } finally {
    await cleanup();
  }
});

test("stage review prompt includes finding schema and retry feedback", async () => {
  const { runtime, cleanup } = await tempRuntime();
  try {
    runtime.registerPack(literaturePack);
    const contract = runtime.services.packRegistry.getStageContract("literature-review-prisma-v1");
    const stage = contract.stages.find((item) => item.id === "screening");
    const prompt = renderStageReviewPrompt({
      stage,
      artifactManifest: { artifacts: [{ id: "art_screen", stage: "screening_log" }], byStage: { screening_log: ["art_screen"] }, byRole: {} },
      feedback: ["stage_review_failed: TOOL_INPUT_INVALID: review_finding_write.description is required"]
    });
    assert.match(prompt, /review_finding_write\.description is required/);
    assert.match(prompt, /severity/);
    assert.match(prompt, /targetRef/);
    assert.match(prompt, /Example finding tool call content/);
    assert.match(prompt, /Stage-specific review checklist/);
    assert.match(prompt, /PRISMA screening completeness/);
    assert.match(prompt, /TOOL_INPUT_INVALID/);
  } finally {
    await cleanup();
  }
});

test("core stage review prompt stays domain-neutral without pack checklist", () => {
  const prompt = renderStageReviewPrompt({
    stage: { id: "generic", goal: "Review a generic stage." },
    artifactManifest: { artifacts: [], byStage: {}, byRole: {} },
    feedback: []
  });
  assert.match(prompt, /Review output contract/);
  assert.match(prompt, /process gaps/);
  assert.doesNotMatch(prompt, /PRISMA/);
  assert.doesNotMatch(prompt, /citation-chain/);
});

test("literature database normalization keeps only executable connector ids", async () => {
  const { runtime, cleanup } = await tempRuntime();
  try {
    runtime.registerPack(literaturePack);
    const registry = getLiteratureConnectorRegistry(runtime.services);
    registry.register({
      id: "fake-executable",
      name: "Fake Executable",
      description: "Fake connector for db normalization",
      async search() {
        return [];
      }
    });
    const dbs = normalizeLiteratureDatabaseIds([
      { name: "OpenAlex" },
      { database: "Semantic Scholar" },
      { name: "Web of Science" },
      "fake-executable",
      { db: "Scopus" }
    ], registry);
    assert.deepEqual(dbs, ["openalex", "semantic-scholar", "fake-executable"]);
  } finally {
    await cleanup();
  }
});

test("arXiv query profile converts broad boolean queries into short fielded terms", () => {
  const query = toArxivSearchQuery('("protein design" OR "molecular generation" OR "structure prediction") AND (review OR survey OR roadmap OR trend)');
  assert.equal(query, 'all:"protein design" OR all:"molecular generation" OR all:"structure prediction"');
  assert.ok(query.length < 120);
});

test("literature search scaffold retries retryable source errors with fallback queries", async () => {
  const { runtime, cleanup } = await tempRuntime();
  try {
    runtime.registerPack(literaturePack);
    let calls = 0;
    getLiteratureConnectorRegistry(runtime.services).register({
      id: "fake-fallback",
      name: "Fake Fallback",
      description: "Fake connector for search fallback",
      async search(input) {
        calls += 1;
        if (calls === 1) throw new Error("temporary network failure");
        assert.notEqual(input.query, "AI4S的发展现状和趋势");
        return [
          { id: "fallback-1", title: "AI for Science fallback query success", authors: ["A"], year: 2026, venue: "Test", url: "https://example.test/fallback-1", sourceDb: "fake-fallback", abstract: "AI for Science and scientific machine learning support discovery trends." }
        ];
      }
    });
    const result = await runtime.run({
      input: "AI4S的发展现状和趋势",
      strategy: "workflow_controlled",
      metadata: {
        workflow: "literature-review",
        dbs: ["fake-fallback"],
        limit: 1,
        topicProfile: {
          topicLabel: "AI4S",
          coreTerms: ["AI4S", "AI for Science", "scientific machine learning"],
          domainTerms: ["scientific discovery"],
          modifierTerms: ["现状", "趋势"]
        }
      }
    });
    assert.equal(result.status, "completed");
    assert.ok(calls >= 2);
    const artifacts = await Promise.all(result.artifactIds.map(async (id) => ({ id, text: (await runtime.services.artifactStore.read(id)).toString("utf8") })));
    const identification = artifacts.map((artifact) => {
      try { return JSON.parse(artifact.text); } catch { return null; }
    }).find((parsed) => parsed?.stage === "identification");
    assert.equal(identification.searchCounts["fake-fallback"], 1);
    assert.equal(identification.sourceErrors[0].fallbackAvailable, true);
  } finally {
    await cleanup();
  }
});

test("registered pack workflow is selected for literature-like exec input", async () => {
  const { runtime, cleanup } = await tempRuntime();
  try {
    runtime.registerPack(literaturePack);
    getLiteratureConnectorRegistry(runtime.services).register({
      id: "fake-route",
      name: "Fake Route",
      description: "Fake test connector for pack routing",
      async search() {
        return [
          { id: "p-route", title: "Traceable literature review agents", authors: ["A"], year: 2026, venue: "Test", doi: "10.0000/test", url: "https://example.test/p-route", sourceDb: "fake-route", abstract: "Literature review agents can perform traceable screening and synthesis." }
        ];
      }
    });
    const result = await runtime.run({ input: "请调研 traceable literature review agents 的论文", strategy: "auto", packIds: ["literature"], metadata: { dbs: ["fake-route"], limit: 1 } });
    assert.equal(result.status, "completed");
    assert.match(result.output, /PRISMA-style literature review complete/);
    const session = await runtime.services.sessionStore.get(result.sessionId);
    assert.equal(session.metadata.workflow, "literature-review");
    assert.equal(session.metadata.selectedPack, "literature");
  } finally {
    await cleanup();
  }
});

test("literature pack registers and runs a stage contract", async () => {
  const { runtime, cleanup } = await tempRuntime();
  try {
    runtime.registerPack(literaturePack);
    assert.equal(runtime.services.packRegistry.getStageContract("literature-review-prisma-v1").stages.length, 5);
    getLiteratureConnectorRegistry(runtime.services).register({
      id: "fake-stage",
      name: "Fake Stage",
      description: "Fake test connector for stage contracts",
      async search() {
        return [
          { id: "p-stage", title: "Stage contracts for AI4S literature agents", authors: ["A"], year: 2026, venue: "Test", url: "https://example.test/p-stage", sourceDb: "fake-stage", abstract: "AI4S literature agents need stage contracts, verifiers, evidence, and citation checks." }
        ];
      }
    });
    const result = await runtime.run({
      input: "AI4S literature agents",
      strategy: "workflow_controlled",
      metadata: {
        workflow: "literature-review",
        dbs: ["fake-stage"],
        limit: 1,
        topicProfile: {
          topicLabel: "AI4S literature agents",
          coreTerms: ["AI4S", "literature agents", "stage contracts"],
          domainTerms: ["stage contracts", "verifiers", "evidence", "citation checks"],
          modifierTerms: ["review"]
        }
      }
    });
    assert.equal(result.status, "completed");
    assert.ok(runtime.services.eventBus.events.some((event) => event.type === "stage.started" && event.stageId === "protocol_query"));
    assert.ok(runtime.services.eventBus.events.some((event) => event.type === "stage.completed" && event.stageId === "citation_synthesis_review"));
    const stages = new Set();
    for (const id of result.artifactIds) {
      try {
        const parsed = JSON.parse((await runtime.services.artifactStore.read(id)).toString("utf8"));
        if (parsed.stage) stages.add(parsed.stage);
      } catch {}
    }
    assert.ok(stages.has("protocol"));
    assert.ok(stages.has("screening_log"));
    assert.ok(stages.has("prisma_flow"));
  } finally {
    await cleanup();
  }
});

test("AI4S literature screening excludes modifier-only trend papers", async () => {
  const { runtime, cleanup } = await tempRuntime();
  try {
    runtime.registerPack(literaturePack);
    getLiteratureConnectorRegistry(runtime.services).register({
      id: "fake-ai4s-quality",
      name: "Fake AI4S Quality",
      description: "Fake connector for AI4S screening quality",
      async search() {
        return [
          { id: "ai4s-1", title: "AI for Science and AI-driven scientific discovery trends", authors: ["A"], year: 2026, venue: "Test", url: "https://example.test/ai4s-1", sourceDb: "fake-ai4s-quality", abstract: "AI for Science uses foundation models and autonomous laboratories to accelerate scientific discovery." },
          { id: "wind-1", title: "风力发电技术的现状与发展趋势简析", authors: ["B"], year: 2025, venue: "Test", url: "https://example.test/wind-1", sourceDb: "fake-ai4s-quality", abstract: "本文总结风力发电技术的发展现状和趋势。" }
        ];
      }
    });
    const result = await runtime.run({
      input: "AI4S的发展现状和趋势",
      strategy: "workflow_controlled",
      metadata: {
        workflow: "literature-review",
        dbs: ["fake-ai4s-quality"],
        limit: 2,
        topicProfile: {
          topicLabel: "AI4S",
          coreTerms: ["AI4S", "AI for Science", "AI-driven scientific discovery"],
          domainTerms: ["foundation models", "autonomous laboratories", "scientific discovery"],
          modifierTerms: ["现状", "趋势", "发展"]
        }
      }
    });
    assert.equal(result.status, "completed");
    const artifacts = await Promise.all(result.artifactIds.map(async (id) => ({ id, text: (await runtime.services.artifactStore.read(id)).toString("utf8") })));
    const screening = artifacts.map((artifact) => {
      try { return JSON.parse(artifact.text); } catch { return null; }
    }).find((parsed) => parsed?.stage === "screening_log");
    assert.equal(screening.decisions.find((d) => d.paperId === "ai4s-1").decision, "include");
    assert.equal(screening.decisions.find((d) => d.paperId === "wind-1").decision, "exclude");
  } finally {
    await cleanup();
  }
});

test("literature research brief preferences are audited and enforced", async () => {
  const { runtime, cleanup } = await tempRuntime();
  try {
    runtime.registerPack(literaturePack);
    getLiteratureConnectorRegistry(runtime.services).register({
      id: "fake-brief-pref",
      name: "Fake Brief Preferences",
      description: "Fake connector for research brief preference tests",
      async search() {
        return [
          { id: "brief-good", title: "AI for Science review from DeepMind on foundation models", authors: ["DeepMind Research"], year: 2025, venue: "Nature Reviews", doi: "10.0000/good", url: "https://example.test/good", sourceDb: "fake-brief-pref", citationCount: 120, abstract: "This review surveys AI for Science, foundation models, scientific discovery, and autonomous laboratories." },
          { id: "brief-old", title: "AI for Science early survey", authors: ["A"], year: 2018, venue: "Journal", doi: "10.0000/old", url: "https://example.test/old", sourceDb: "fake-brief-pref", abstract: "AI for Science and scientific discovery before the requested date range." },
          { id: "brief-no-doi", title: "AI for Science foundation model benchmark", authors: ["B"], year: 2024, venue: "arXiv", url: "https://example.test/no-doi", sourceDb: "fake-brief-pref", abstract: "A benchmark for foundation models in scientific discovery." }
        ];
      }
    });
    const result = await runtime.run({
      input: "AI4S的发展现状和趋势",
      strategy: "workflow_controlled",
      metadata: {
        workflow: "literature-review",
        dbs: ["fake-brief-pref"],
        limit: 3,
        researchBrief: {
          topic: "AI4S的发展现状和趋势",
          questions: ["AI for Science foundation models", "autonomous laboratories"],
          scope: { include: ["foundation models"], exclude: ["policy commentary"] }
        },
        topicProfile: {
          topicLabel: "AI4S",
          coreTerms: ["AI4S", "AI for Science", "scientific discovery"],
          domainTerms: ["foundation models", "autonomous laboratories"],
          modifierTerms: ["review", "survey", "趋势"]
        },
        sourcePreferences: {
          dateRange: { from: 2020, to: 2026 },
          institutions: ["DeepMind"],
          preferredSources: ["Nature", "fake-brief-pref"],
          domains: ["foundation models"]
        },
        evidencePreferences: {
          requireDoi: true,
          requireAbstract: true,
          minQuality: "Tier 2",
          studyTypes: ["review", "benchmark"]
        },
        outputPreferences: { language: "zh", include: ["preference impact"] }
      }
    });
    assert.equal(result.status, "completed");
    const artifacts = await Promise.all(result.artifactIds.map(async (id) => ({ id, text: (await runtime.services.artifactStore.read(id)).toString("utf8") })));
    const jsonByStage = (stage) => artifacts.map((artifact) => {
      try { return JSON.parse(artifact.text); } catch { return null; }
    }).find((parsed) => parsed?.stage === stage);
    const brief = jsonByStage("research_brief");
    const scores = jsonByStage("preference_scores");
    const screening = jsonByStage("screening_log");
    const included = jsonByStage("included_studies");
    assert.equal(brief.compiledMetadata.sourcePreferences.dateRange.from, 2020);
    assert.equal(scores.summary.recordsScored, 3);
    assert.equal(screening.decisions.find((d) => d.paperId === "brief-good").decision, "include");
    assert.equal(screening.decisions.find((d) => d.paperId === "brief-old").hardExcluded, true);
    assert.equal(screening.decisions.find((d) => d.paperId === "brief-no-doi").hardExcluded, true);
    assert.deepEqual(included.papers.map((paper) => paper.id), ["brief-good"]);
    const final = artifacts.find((artifact) => artifact.text.includes("# PRISMA-Style Literature Review") && artifact.text.includes("preference_scores.json"));
    assert.ok(final);
    assert.match(final.text, /User Preferences/);
  } finally {
    await cleanup();
  }
});

test("literature topic expansion uses facet anchors instead of institution-only matches", async () => {
  const { runtime, cleanup } = await tempRuntime();
  try {
    runtime.registerPack(literaturePack);
    getLiteratureConnectorRegistry(runtime.services).register({
      id: "fake-ai-infra-expansion",
      name: "Fake AI Infra Expansion",
      description: "Fake connector for topic expansion tests",
      async search() {
        return [
          { id: "bytedance-training", title: "Robust LLM Training Infrastructure at ByteDance", authors: ["Seed Team"], year: 2025, venue: "arXiv", url: "https://example.test/bytedance", sourceDb: "fake-ai-infra-expansion", abstract: "This paper describes large-scale LLM training infrastructure, distributed training reliability, checkpointing, and GPU cluster operations at ByteDance." },
          { id: "openai-agents", title: "Infrastructure for AI Agents", authors: ["OpenAI"], year: 2025, venue: "TMLR", doi: "10.0000/agents", url: "https://example.test/agents", sourceDb: "fake-ai-infra-expansion", abstract: "This paper discusses agent application infrastructure and product integration patterns at OpenAI." },
          { id: "kv-serving", title: "KV Cache Scheduling for LLM Serving Systems", authors: ["A"], year: 2025, venue: "Test", doi: "10.0000/kv", url: "https://example.test/kv", sourceDb: "fake-ai-infra-expansion", abstract: "KV cache scheduling, continuous batching, and inference serving improve large language model serving systems." }
        ];
      }
    });
    const result = await runtime.run({
      input: "AI-Infra的发展现状和未来趋势，关注Seed、DeepSeek、OpenAI",
      strategy: "workflow_controlled",
      metadata: {
        workflow: "literature-review",
        dbs: ["fake-ai-infra-expansion"],
        limit: 3,
        researchBrief: {
          topic: "AI-Infra的发展现状和未来趋势",
          intent: "literature_review",
          scope: { include: ["AI infrastructure", "distributed training", "inference serving"], exclude: [] },
          focus: {
            domains: ["distributed training", "inference serving", "KV cache", "GPU cluster reliability"],
            institutions: ["Seed", "ByteDance", "DeepSeek", "OpenAI"]
          },
          sources: { databases: ["fake-ai-infra-expansion"], preferred_sources: [], exclude_sources: [], date_range: { from: 2020, to: 2026 } },
          evidence: { requireAbstract: true, minQuality: "Tier 3" },
          output: { language: "zh", max_papers: 10 }
        },
        topicProfile: {
          topicLabel: "AI-Infra",
          coreTerms: ["AI infrastructure", "AI Infra"],
          domainTerms: ["distributed training", "inference serving", "KV cache", "ByteDance", "OpenAI"],
          modifierTerms: ["trend", "review"]
        }
      }
    });
    assert.equal(result.status, "completed");
    const artifacts = await Promise.all(result.artifactIds.map(async (id) => ({ id, text: (await runtime.services.artifactStore.read(id)).toString("utf8") })));
    const parsed = artifacts.map((artifact) => {
      try { return JSON.parse(artifact.text); } catch { return null; }
    }).filter(Boolean);
    const expansion = parsed.find((item) => item.stage === "topic_expansion");
    const screening = parsed.find((item) => item.stage === "screening_log");
    assert.ok(expansion.facets.some((facet) => facet.terms.includes("distributed training")));
    assert.equal(screening.decisions.find((d) => d.paperId === "bytedance-training").decision, "include");
    assert.equal(screening.decisions.find((d) => d.paperId === "kv-serving").decision, "include");
    assert.equal(screening.decisions.find((d) => d.paperId === "openai-agents").decision, "exclude");
  } finally {
    await cleanup();
  }
});

test("stage contract retries a failed stage with verifier feedback", async () => {
  const { runtime, cleanup } = await tempRuntime();
  try {
    const retryFeedback = [];
    runtime.services.verifierRegistry.register({
      id: "test_ready",
      description: "Pass only after the stage used verifier feedback.",
      async verify(ctx) {
        return ctx.state.ready === true
          ? { ok: true, message: "ready" }
          : {
              ok: false,
              message: "not ready",
              severity: "major",
              category: "test",
              targetRef: "draft",
              diagnostics: {
                target: "draft artifact",
                missing: ["draft.ready"],
                found: ["draft.started"],
                requiredFixes: ["Create a draft artifact with ready=true."]
              }
            };
      }
    });
    const contract = {
      id: "retry-contract",
      name: "Retry Contract",
      description: "Retry verifier feedback contract",
      initialStageId: "draft",
      stages: [{
        id: "draft",
        goal: "Create a draft only after feedback is available.",
        requiredArtifacts: [{ type: "json", stage: "draft" }],
        verifiers: ["artifact_requirements_met", "test_ready"],
        retryPolicy: { maxAttempts: 2, onFailure: "retry_stage" },
        run: async (ctx) => {
          if (ctx.feedback.length) retryFeedback.push(...ctx.feedback);
          if (!ctx.feedback.length) return { statePatch: { ready: false } };
          const artifact = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "draft", fixed: true }) });
          return { artifactIds: [artifact.id], statePatch: { ready: true } };
        }
      }]
    };
    runtime.registerPack({ id: "retry-pack", name: "Retry Pack", version: "0.0.0", stageContracts: [contract] });
    const session = await runtime.services.sessionStore.create({ agentId: "research-orchestrator", input: "retry", cwd: runtime.services.config.cwd });
    const result = await new StageContractRunner(runtime.services).run({ sessionId: session.id, contractId: "retry-contract", userGoal: "retry" });
    assert.equal(result.status, "completed");
    const stages = [];
    for (const id of result.artifactIds) {
      try {
        stages.push(JSON.parse((await runtime.services.artifactStore.read(id)).toString("utf8")).stage);
      } catch {}
    }
    assert.ok(stages.includes("draft"));
    assert.ok(stages.includes("verifier_report"));
    assert.ok(retryFeedback.some((message) => message.includes("test_ready failed on draft")));
    assert.ok(retryFeedback.some((message) => message.includes("Missing fields:\n  - draft.ready")));
    assert.ok(retryFeedback.some((message) => message.includes("Required fixes:\n  - Create a draft artifact with ready=true.")));
    const reports = [];
    for (const id of result.artifactIds) {
      try {
        const parsed = JSON.parse((await runtime.services.artifactStore.read(id)).toString("utf8"));
        if (parsed.stage === "verifier_report") reports.push(parsed);
      } catch {}
    }
    assert.ok(reports.some((report) => report.deterministicChecks.some((check) => check.verifierId === "test_ready" && check.diagnostics?.missing?.includes("draft.ready"))));
    assert.ok(runtime.services.eventBus.events.some((event) => event.type === "stage.failed" && event.stageId === "draft"));
    assert.ok(runtime.services.eventBus.events.some((event) => event.type === "stage.completed" && event.stageId === "draft" && event.attempt === 2));
  } finally {
    await cleanup();
  }
});

test("stage retry isolates current-attempt artifacts from failed attempts", async () => {
  const { runtime, cleanup } = await tempRuntime();
  try {
    runtime.services.verifierRegistry.register({
      id: "attempt_ready",
      description: "Pass only on the second attempt.",
      async verify(ctx) {
        return ctx.state.ready === true
          ? { ok: true, message: "ready" }
          : { ok: false, message: "not ready", severity: "major", category: "attempt_not_ready" };
      }
    });
    const contract = {
      id: "attempt-isolation-contract",
      name: "Attempt Isolation Contract",
      description: "Retry attempts should not validate against failed-attempt artifacts.",
      initialStageId: "draft",
      stages: [{
        id: "draft",
        goal: "Create a draft artifact on each attempt.",
        requiredArtifacts: [{ type: "json", stage: "draft" }],
        verifiers: ["artifact_requirements_met", "attempt_ready"],
        retryPolicy: { maxAttempts: 2, onFailure: "retry_stage" },
        run: async (ctx) => {
          let previousDraftsVisible = 0;
          for (const id of ctx.artifactIds) {
            try {
              const parsed = JSON.parse((await ctx.services.artifactStore.read(id)).toString("utf8"));
              if (parsed.stage === "draft") previousDraftsVisible += 1;
            } catch {}
          }
          const artifact = await ctx.createArtifact({
            type: "json",
            mediaType: "application/json",
            content: JSON.stringify({ stage: "draft", attempt: ctx.attempt, previousDraftsVisible })
          });
          return { artifactIds: [artifact.id], statePatch: { ready: ctx.attempt === 2 } };
        }
      }]
    };
    runtime.registerPack({ id: "attempt-isolation-pack", name: "Attempt Isolation Pack", version: "0.0.0", stageContracts: [contract] });
    const session = await runtime.services.sessionStore.create({ agentId: "research-orchestrator", input: "attempt isolation", cwd: runtime.services.config.cwd });
    const result = await new StageContractRunner(runtime.services).run({ sessionId: session.id, contractId: "attempt-isolation-contract", userGoal: "attempt isolation" });
    assert.equal(result.status, "completed");
    const drafts = [];
    for (const id of result.artifactIds) {
      try {
        const parsed = JSON.parse((await runtime.services.artifactStore.read(id)).toString("utf8"));
        if (parsed.stage === "draft") drafts.push(parsed);
      } catch {}
    }
    assert.equal(drafts.length, 2);
    assert.equal(drafts.find((draft) => draft.attempt === 2).previousDraftsVisible, 0);
  } finally {
    await cleanup();
  }
});

test("literature query concept verifier returns structured diagnostics", async () => {
  const { runtime, cleanup } = await tempRuntime();
  try {
    runtime.registerPack(literaturePack);
    const contract = runtime.services.packRegistry.getStageContract("literature-review-prisma-v1");
    const stage = contract.stages.find((item) => item.id === "protocol_query");
    const session = await runtime.services.sessionStore.create({ agentId: "research-orchestrator", input: "AI4S", cwd: runtime.services.config.cwd });
    const queries = await runtime.services.artifactStore.create({
      sessionId: session.id,
      createdBy: { sessionId: session.id, agentId: "test", toolId: "test" },
      type: "json",
      mediaType: "application/json",
      content: JSON.stringify({
        stage: "queries",
        question: "AI4S",
        selectedQueries: [{ database: "openalex", query: "AI4S" }],
        conceptsCoverage: "AI4S includes AI for scientific discovery and scientific foundation models."
      })
    });
    const verifier = runtime.services.verifierRegistry.get("literature_query_concepts_valid");
    const result = await verifier.verify({ sessionId: session.id, services: runtime.services, contract, stage, artifactIds: [queries.id], state: {} });
    assert.equal(result.ok, false);
    assert.equal(result.targetRef, "queries");
    assert.ok(result.diagnostics.missing.some((item) => item.includes("conceptDefinition")));
    assert.ok(result.diagnostics.found.includes("queries.conceptsCoverage"));
    assert.ok(result.diagnostics.requiredFixes.some((item) => item.includes("stage=\"queries\"")));
  } finally {
    await cleanup();
  }
});

test("stage gate policy can redirect to a pack-defined stage", async () => {
  const { runtime, cleanup } = await tempRuntime();
  try {
    runtime.services.verifierRegistry.register({
      id: "test_redirect",
      description: "Force redirect once.",
      async verify(ctx) {
        return ctx.state.planned ? { ok: true, message: "planned" } : { ok: false, message: "needs planning", severity: "major", category: "needs_planning" };
      }
    });
    const contract = {
      id: "redirect-contract",
      name: "Redirect Contract",
      description: "Gate redirect contract",
      initialStageId: "work",
      maxStages: 4,
      stages: [
        {
          id: "work",
          goal: "Do work after planning.",
          gate: {
            deterministic: [{ id: "test_redirect", hardGate: false }],
            rules: [
              { when: "verifier_failed:needs_planning", action: "go_to_stage", stageId: "plan" },
              { when: "passed", action: "next" }
            ]
          },
          next: [{ when: "passed" }],
          run: async () => ({})
        },
        {
          id: "plan",
          goal: "Plan then stop.",
          next: [{ when: "passed" }],
          run: async (ctx) => {
            const artifact = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "plan" }) });
            return { artifactIds: [artifact.id], statePatch: { planned: true } };
          }
        }
      ]
    };
    runtime.registerPack({ id: "redirect-pack", name: "Redirect Pack", version: "0.0.0", stageContracts: [contract] });
    const session = await runtime.services.sessionStore.create({ agentId: "research-orchestrator", input: "redirect", cwd: runtime.services.config.cwd });
    const result = await new StageContractRunner(runtime.services).run({ sessionId: session.id, contractId: "redirect-contract", userGoal: "redirect" });
    assert.equal(result.status, "completed");
    assert.ok(runtime.services.eventBus.events.some((event) => event.type === "stage.redirected" && event.stageId === "work" && event.nextStageId === "plan"));
  } finally {
    await cleanup();
  }
});

test("stage gate treats high severity review findings as major failures", async () => {
  const { runtime, cleanup } = await tempRuntime();
  try {
    runtime.services.reviewerRegistry.register({
      id: "high-reviewer",
      name: "High Reviewer",
      description: "Writes a high severity finding.",
      async review(ctx) {
        const finding = await ctx.services.reviewStore.create({
          sessionId: ctx.sessionId,
          severity: "high",
          category: "semantic_inconsistency",
          targetType: "stage",
          targetRef: "draft",
          description: "High severity issue."
        });
        return { findingIds: [finding.id], blockingFindingIds: [], summary: "high issue" };
      }
    });
    const contract = {
      id: "high-review-contract",
      name: "High Review Contract",
      description: "High severity review should not pass.",
      initialStageId: "draft",
      stages: [{
        id: "draft",
        goal: "Draft with high review issue.",
        gate: {
          semantic: { reviewerId: "high-reviewer", mode: "always" },
          rules: [
            { when: "review_major", action: "partial" },
            { when: "passed", action: "next" }
          ]
        },
        run: async (ctx) => {
          const artifact = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "draft" }) });
          return { artifactIds: [artifact.id] };
        }
      }]
    };
    runtime.registerPack({ id: "high-review-pack", name: "High Review Pack", version: "0.0.0", stageContracts: [contract] });
    const session = await runtime.services.sessionStore.create({ agentId: "research-orchestrator", input: "high", cwd: runtime.services.config.cwd });
    const result = await new StageContractRunner(runtime.services).run({ sessionId: session.id, contractId: "high-review-contract", userGoal: "high" });
    assert.equal(result.status, "partial");
    const findings = await runtime.services.reviewStore.listBySessionTree(session.id);
    assert.ok(findings.some((finding) => finding.severity === "high" && finding.category === "semantic_inconsistency"));
  } finally {
    await cleanup();
  }
});

test("stage verifier sees open blocking findings in child sessions", async () => {
  const { runtime, cleanup } = await tempRuntime();
  try {
    const contract = {
      id: "child-blocking-contract",
      name: "Child Blocking Contract",
      description: "Child blocking finding should fail root gate.",
      initialStageId: "draft",
      stages: [{
        id: "draft",
        goal: "Create a child blocking finding.",
        gate: {
          deterministic: [{ id: "no_open_blocking_findings", hardGate: true }],
          rules: [
            { when: "hard_gate_failed", action: "partial" },
            { when: "passed", action: "next" }
          ]
        },
        run: async (ctx) => {
          const child = await ctx.services.sessionStore.create({ parentId: ctx.sessionId, agentId: "task-agent", input: "child", cwd: runtime.services.config.cwd });
          await ctx.services.reviewStore.create({ sessionId: child.id, severity: "blocking", category: "child_block", targetType: "session", targetRef: child.id, description: "Child session blocks the stage." });
          const artifact = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "draft" }) });
          return { artifactIds: [artifact.id] };
        }
      }]
    };
    runtime.registerPack({ id: "child-blocking-pack", name: "Child Blocking Pack", version: "0.0.0", stageContracts: [contract] });
    const session = await runtime.services.sessionStore.create({ agentId: "research-orchestrator", input: "child blocking", cwd: runtime.services.config.cwd });
    const result = await new StageContractRunner(runtime.services).run({ sessionId: session.id, contractId: "child-blocking-contract", userGoal: "child blocking" });
    assert.equal(result.status, "partial");
    assert.ok(result.reviewFindingIds.length >= 1);
  } finally {
    await cleanup();
  }
});

test("stage runner falls back when stage agent fails before scaffold", async () => {
  const { runtime, cleanup } = await tempRuntime();
  try {
    const contract = {
      id: "fallback-contract",
      name: "Fallback Contract",
      description: "Fallback after agent failure",
      initialStageId: "fallback",
      stages: [{
        id: "fallback",
        goal: "Fallback after agent failure.",
        agentId: "missing-stage-agent",
        requiredArtifacts: [{ type: "json", stage: "fallback" }],
        gate: {
          deterministic: [{ id: "artifact_requirements_met", hardGate: true }],
          rules: [{ when: "hard_gate_failed", action: "retry_stage" }, { when: "passed", action: "next" }]
        },
        run: async (ctx) => {
          const artifact = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "fallback", recovered: Boolean(ctx.state["stage.fallback.agentError"]) }) });
          return { artifactIds: [artifact.id] };
        }
      }]
    };
    runtime.registerPack({ id: "fallback-pack", name: "Fallback Pack", version: "0.0.0", stageContracts: [contract] });
    const session = await runtime.services.sessionStore.create({ agentId: "research-orchestrator", input: "fallback", cwd: runtime.services.config.cwd });
    const result = await new StageContractRunner(runtime.services).run({ sessionId: session.id, contractId: "fallback-contract", userGoal: "fallback" });
    assert.equal(result.status, "completed");
    assert.ok(runtime.services.eventBus.events.some((event) => event.type === "stage.agent_failed" && event.stageId === "fallback"));
    const findings = await runtime.services.reviewStore.listBySession(session.id);
    assert.ok(findings.some((finding) => finding.category === "stage_agent_failed"));
  } finally {
    await cleanup();
  }
});

test("successful stage review resolves stale review execution failures", async () => {
  const { runtime, cleanup } = await tempRuntime();
  try {
    const contract = {
      id: "stale-review-failure-contract",
      name: "Stale Review Failure Contract",
      description: "A successful reviewer attempt should clear old transient review failures.",
      initialStageId: "screening",
      stages: [{
        id: "screening",
        goal: "Create a screening artifact and review it.",
        review: { agentId: "reviewer", mode: "always" },
        retryPolicy: { maxAttempts: 1 },
        gate: {
          rules: [
            { when: "review_major", action: "partial" },
            { when: "passed", action: "next" }
          ]
        },
        run: async (ctx) => {
          const artifact = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "screening_log" }) });
          return { artifactIds: [artifact.id] };
        }
      }]
    };
    runtime.registerPack({ id: "stale-review-failure-pack", name: "Stale Review Failure Pack", version: "0.0.0", stageContracts: [contract] });
    const session = await runtime.services.sessionStore.create({ agentId: "research-orchestrator", input: "screening", cwd: runtime.services.config.cwd });
    const stale = await runtime.services.reviewStore.create({
      sessionId: session.id,
      severity: "major",
      category: "stage_review_failed",
      targetType: "stage",
      targetRef: "screening",
      description: "Previous reviewer tool call failed."
    });

    const result = await new StageContractRunner(runtime.services).run({ sessionId: session.id, contractId: "stale-review-failure-contract", userGoal: "screening" });

    assert.equal(result.status, "completed");
    const findings = await runtime.services.reviewStore.listBySession(session.id);
    assert.equal(findings.find((finding) => finding.id === stale.id)?.status, "resolved");
  } finally {
    await cleanup();
  }
});

test("stage reviewer receives previous review failure feedback", async () => {
  const { runtime, cleanup } = await tempRuntime();
  try {
    const contract = {
      id: "review-feedback-contract",
      name: "Review Feedback Contract",
      description: "Reviewer prompt should include prior review execution failures.",
      initialStageId: "screening",
      stages: [{
        id: "screening",
        goal: "Create a screening artifact and review it.",
        review: { agentId: "reviewer", mode: "always" },
        retryPolicy: { maxAttempts: 1 },
        gate: {
          rules: [
            { when: "review_major", action: "partial" },
            { when: "passed", action: "next" }
          ]
        },
        run: async (ctx) => {
          const artifact = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "screening_log" }) });
          return { artifactIds: [artifact.id] };
        }
      }]
    };
    runtime.registerPack({ id: "review-feedback-pack", name: "Review Feedback Pack", version: "0.0.0", stageContracts: [contract] });
    const session = await runtime.services.sessionStore.create({ agentId: "research-orchestrator", input: "screening", cwd: runtime.services.config.cwd });
    await runtime.services.reviewStore.create({
      sessionId: session.id,
      severity: "major",
      category: "stage_review_failed",
      targetType: "stage",
      targetRef: "screening",
      description: "Stage review agent failed; continuing with deterministic gate only: TOOL_INPUT_INVALID: review_finding_write.description is required"
    });

    const result = await new StageContractRunner(runtime.services).run({ sessionId: session.id, contractId: "review-feedback-contract", userGoal: "screening" });

    assert.equal(result.status, "completed");
    const children = await runtime.services.sessionStore.children(session.id);
    const reviewer = children.find((child) => child.agentId === "reviewer");
    assert.ok(reviewer);
    assert.match(reviewer.input, /Previous review feedback\/errors/);
    assert.match(reviewer.input, /review_finding_write\.description is required/);
  } finally {
    await cleanup();
  }
});
