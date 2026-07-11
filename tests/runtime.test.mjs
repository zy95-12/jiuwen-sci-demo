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
  StageContractRunner,
  ToolRuntime
} from "@jiuwen-sci/core";
import { getLiteratureConnectorRegistry, literaturePack } from "@jiuwen-sci/literature-pack";

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
    const result = await runtime.run({ input: "AI4S literature agents", strategy: "workflow_controlled", metadata: { workflow: "literature-review", dbs: ["fake-stage"], limit: 1 } });
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
    const result = await runtime.run({ input: "AI4S的发展现状和趋势", strategy: "workflow_controlled", metadata: { workflow: "literature-review", dbs: ["fake-ai4s-quality"], limit: 2 } });
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

test("stage contract retries a failed stage with verifier feedback", async () => {
  const { runtime, cleanup } = await tempRuntime();
  try {
    runtime.services.verifierRegistry.register({
      id: "test_ready",
      description: "Pass only after the stage used verifier feedback.",
      async verify(ctx) {
        return ctx.state.ready === true
          ? { ok: true, message: "ready" }
          : { ok: false, message: "not ready", severity: "major", category: "test" };
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
    assert.ok(runtime.services.eventBus.events.some((event) => event.type === "stage.failed" && event.stageId === "draft"));
    assert.ok(runtime.services.eventBus.events.some((event) => event.type === "stage.completed" && event.stageId === "draft" && event.attempt === 2));
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
