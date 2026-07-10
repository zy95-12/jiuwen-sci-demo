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
    const finalId = result.artifactIds.at(-1);
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
