import { mkdir } from "node:fs/promises";
import path from "node:path";
import { AgentSessionRunner } from "./agent-session-runner.js";
import { createInternalToolContext, createWorkflowContext as createWorkflowContextWithTaskTool } from "./contexts.js";
import { artifactReadTool, artifactWriteTool, coreTools, finalizeTool, reviewFindingWriteTool, taskTool } from "./core-tools.js";
import { RuntimeError } from "./errors.js";
import { CriticReviseRunner, DefaultStrategyGuard, DirectRunner, ExecutionEngine, PackWorkflowSelector, RetryRunner, StrategySelector, WorkflowRunner, type ExecutionRunner } from "./execution.js";
import { createId } from "./ids.js";
import { j, parseJson } from "./json.js";
import { parseModelRef } from "./model-ref.js";
import { MockProvider, OpenAICompatibleProvider, readArkHelperApiKey } from "./providers.js";
import { InMemoryAgentRegistry, InMemoryPackRegistry, InMemoryReviewerRegistry, InMemoryStageVerifierRegistry, InMemoryToolRegistry } from "./registries.js";
import { DefaultEventBus, DefaultPermissionService, DefaultPromptAssembler, DefaultProviderRouter } from "./services.js";
import { StageContractRunner } from "./stage-contract-runner.js";
import { countMatchingArtifacts, createArtifactManifest, decideGateAction, effectiveGate, renderStageAgentPrompt, renderStageReviewPrompt, resolveStageTransition } from "./stage-helpers.js";
import { FilesystemArtifactStore, SqliteMessageStore, SqliteProvenanceStore, SqliteReviewStore, SqliteSessionStore, SqliteStorageConnection, SqliteToolCallStore } from "./storage.js";
import { ToolRuntime } from "./tool-runtime.js";
import type { AgentDefinition, CapabilityPack, ModelRef, ReviewerDefinition, RuntimeConfig, RuntimeEvent, RuntimeRunInput, RuntimeRunResult, RuntimeServices, StageVerifierDefinition, ToolDefinition, WorkflowContext } from "./types.js";
export type * from "./types.js";

export { RuntimeError } from "./errors.js";
export { createId } from "./ids.js";
export { j, parseJson } from "./json.js";
export { parseModelRef } from "./model-ref.js";

export { FilesystemArtifactStore, SqliteMessageStore, SqliteProvenanceStore, SqliteReviewStore, SqliteSessionStore, SqliteStorageConnection, SqliteToolCallStore } from "./storage.js";

export { InMemoryAgentRegistry, InMemoryPackRegistry, InMemoryReviewerRegistry, InMemoryStageVerifierRegistry, InMemoryToolRegistry } from "./registries.js";

export { DefaultEventBus, DefaultPermissionService, DefaultPromptAssembler, DefaultProviderRouter } from "./services.js";

export async function createRuntimeConfig(input: { cwd?: string; model?: string | ModelRef } = {}): Promise<RuntimeConfig> {
  const cwd = path.resolve(input.cwd ?? process.cwd());
  const root = path.join(cwd, ".jiuwen-sci");
  const arkHelperApiKey = readArkHelperApiKey();
  return {
    cwd,
    paths: { root, database: path.join(root, "runtime.db"), artifacts: path.join(root, "artifacts"), logs: path.join(root, "logs"), cache: path.join(root, "cache") },
    defaultModel: parseModelRef(input.model) ?? { provider: "mock", model: "deterministic" },
    providers: { openaiCompatible: { baseUrl: process.env.OPENAI_BASE_URL ?? (arkHelperApiKey ? "https://ark.cn-beijing.volces.com/api/coding/v3" : "https://ark.cn-beijing.volces.com/api/v3"), apiKeyEnv: "OPENAI_API_KEY", apiKey: arkHelperApiKey } },
    limits: { maxRetries: 2, maxReviewRounds: 2 },
    permissions: {}
  };
}

export async function createRuntimeServices(config: RuntimeConfig, eventSink?: (event: RuntimeEvent) => void): Promise<RuntimeServices> {
  await mkdir(config.paths.artifacts, { recursive: true });
  await mkdir(config.paths.logs, { recursive: true });
  await mkdir(config.paths.cache, { recursive: true });
  const storage = new SqliteStorageConnection(config.paths.database);
  const services: RuntimeServices = {
    config,
    storage,
    sessionStore: new SqliteSessionStore(storage),
    messageStore: new SqliteMessageStore(storage),
    toolCallStore: new SqliteToolCallStore(storage),
    artifactStore: new FilesystemArtifactStore(config.paths.artifacts, storage),
    provenanceStore: new SqliteProvenanceStore(storage),
    reviewStore: new SqliteReviewStore(storage),
    agentRegistry: new InMemoryAgentRegistry(),
    toolRegistry: new InMemoryToolRegistry(),
    reviewerRegistry: new InMemoryReviewerRegistry(),
    verifierRegistry: new InMemoryStageVerifierRegistry(),
    packRegistry: new InMemoryPackRegistry(),
    providerRouter: new DefaultProviderRouter(),
    promptAssembler: new DefaultPromptAssembler(),
    permissionService: new DefaultPermissionService(),
    eventBus: new DefaultEventBus(eventSink),
    extensions: new Map()
  };
  services.providerRouter.register(new MockProvider());
  services.providerRouter.register(new OpenAICompatibleProvider("openai", config.providers.openaiCompatible));
  services.providerRouter.register(new OpenAICompatibleProvider("volcengine", config.providers.openaiCompatible));
  services.providerRouter.register(new OpenAICompatibleProvider("ark", config.providers.openaiCompatible));
  registerCoreAgents(services.agentRegistry);
  registerCoreTools(services.toolRegistry);
  registerCoreStageVerifiers(services.verifierRegistry);
  return services;
}

export function registerCoreAgents(registry: InMemoryAgentRegistry): void {
  registry.register({ id: "research-orchestrator", name: "Research Orchestrator", description: "General-purpose controller for research tasks.", mode: "primary", supportsStrategySelection: true, prompt: "You coordinate bounded research tasks and produce artifact-backed outputs.", permissions: [], allowedTools: ["task", "artifact_read", "artifact_write", "finalize"], maxTurns: 8 });
  registry.register({ id: "task-agent", name: "Task Agent", description: "General-purpose subagent for bounded delegated tasks.", mode: "subagent", prompt: "You complete a bounded delegated task and finalize with a concise artifact-backed result.", permissions: [], allowedTools: ["artifact_read", "artifact_write", "finalize"], maxTurns: 6 });
  registry.register({ id: "reviewer", name: "Reviewer", description: "Read-only reviewer for checking consistency.", mode: "subagent", prompt: "Review current artifacts and record findings. Do not write new source artifacts. When recording a finding, review_finding_write.description is mandatory and must explain the issue concretely. If there are no findings, finalize without calling review_finding_write.", permissions: [], allowedTools: ["artifact_read", "review_finding_write", "finalize"], maxTurns: 6 });
}

export function registerCoreTools(registry: InMemoryToolRegistry): void {
  for (const tool of coreTools) registry.register(tool);
}

export function registerCoreStageVerifiers(registry: InMemoryStageVerifierRegistry): void {
  registry.register({
    id: "artifact_requirements_met",
    description: "Verify that the stage required artifact declarations are satisfied.",
    async verify(ctx) {
      for (const req of ctx.stage.requiredArtifacts ?? []) {
        const count = await countMatchingArtifacts(ctx.services, ctx.artifactIds, req);
        const minCount = req.minCount ?? (req.required === false ? 0 : 1);
        if (count < minCount) return { ok: false, message: `Required artifact not found: ${JSON.stringify(req)}`, severity: "major", category: "missing_artifact" };
      }
      return { ok: true, message: "Artifact requirements met." };
    }
  });
  registry.register({
    id: "no_open_blocking_findings",
    description: "Verify that the current session tree has no open blocking review findings.",
    async verify(ctx) {
      const blocking = await ctx.services.reviewStore.listOpenBlockingBySessionTree(ctx.sessionId);
      return blocking.length
        ? { ok: false, message: `Open blocking findings remain: ${blocking.map((f) => f.id).join(", ")}`, severity: "blocking", category: "blocking_findings" }
        : { ok: true, message: "No open blocking findings." };
    }
  });
}

export { artifactReadTool, artifactWriteTool, coreTools, finalizeTool, reviewFindingWriteTool, taskTool } from "./core-tools.js";

export { ToolRuntime } from "./tool-runtime.js";

export { CriticReviseRunner, DefaultStrategyGuard, DirectRunner, ExecutionEngine, PackWorkflowSelector, RetryRunner, StrategySelector, WorkflowRunner };
export type { ExecutionRunner } from "./execution.js";

export { StageContractRunner } from "./stage-contract-runner.js";

export { countMatchingArtifacts, createArtifactManifest, decideGateAction, effectiveGate, renderStageAgentPrompt, renderStageReviewPrompt, resolveStageTransition } from "./stage-helpers.js";

export { AgentSessionRunner } from "./agent-session-runner.js";

export { createInternalToolContext } from "./contexts.js";

export function createWorkflowContext(services: RuntimeServices, sessionId: string): WorkflowContext {
  return createWorkflowContextFactory(services, sessionId);
}

function createWorkflowContextFactory(services: RuntimeServices, sessionId: string): WorkflowContext {
  return createWorkflowContextWithTaskTool(services, sessionId, taskTool);
}

export class DefaultRuntimeHost {
  constructor(readonly services: RuntimeServices, private executionEngine: ExecutionEngine) {}
  async start(): Promise<void> {
    await this.services.storage.connect();
    await this.services.eventBus.emit({ type: "runtime.started" });
  }
  async stop(): Promise<void> {
    await this.services.eventBus.emit({ type: "runtime.stopped" });
    await this.services.storage.close();
  }
  registerAgent(agent: AgentDefinition): void { this.services.agentRegistry.register(agent); }
  registerTool(tool: ToolDefinition): void { this.services.toolRegistry.register(tool); }
  registerReviewer(reviewer: ReviewerDefinition): void { this.services.reviewerRegistry.register(reviewer); }
  registerPack(pack: CapabilityPack): void {
    if (this.services.packRegistry.get(pack.id)) return;
    for (const agent of pack.agents ?? []) this.registerAgent(agent);
    for (const tool of pack.tools ?? []) this.registerTool(tool);
    for (const reviewer of pack.reviewers ?? []) this.registerReviewer(reviewer);
    this.services.packRegistry.register(pack);
    pack.activate?.(this.services);
  }
  async run(input: RuntimeRunInput): Promise<RuntimeRunResult> {
    const metadata = { ...(input.metadata ?? {}) };
    let strategy = input.strategy ?? "auto";
    if (!metadata.workflow) {
      const route = await new PackWorkflowSelector(this.services).select({
        userGoal: input.input,
        model: input.model,
        allowedPackIds: input.packIds
      });
      if (route.workflowId) {
        metadata.workflow = route.workflowId;
        metadata.selectedPack = route.packId;
        metadata.packSelection = route;
        strategy = "workflow_controlled";
        await this.services.eventBus.emit({ type: "pack.workflow.selected", workflowId: route.workflowId, packId: route.packId, reason: route.reason });
      }
    }
    const session = await this.services.sessionStore.create({ agentId: input.agentId ?? "research-orchestrator", input: input.input, cwd: input.cwd ?? this.services.config.cwd, model: input.model, metadata });
    await this.services.eventBus.emit({ type: "session.created", sessionId: session.id });
    return this.executionEngine.run({ sessionId: session.id, input: input.input, requestedStrategy: strategy });
  }
  async resume(sessionId: string): Promise<RuntimeRunResult> { return this.executionEngine.resume({ sessionId }); }
}

export async function createRuntimeHost(input: { cwd?: string; model?: string | ModelRef; eventSink?: (event: RuntimeEvent) => void } = {}): Promise<DefaultRuntimeHost> {
  const config = await createRuntimeConfig(input);
  const services = await createRuntimeServices(config, input.eventSink);
  const engine = new ExecutionEngine(services, new StrategySelector(services), new DefaultStrategyGuard(services));
  engine.registerRunner(new DirectRunner(services));
  engine.registerRunner(new RetryRunner(services));
  engine.registerRunner(new CriticReviseRunner(services));
  engine.registerRunner(new WorkflowRunner(services));
  return new DefaultRuntimeHost(services, engine);
}

export { MockProvider, OpenAICompatibleProvider, readArkHelperApiKey } from "./providers.js";
