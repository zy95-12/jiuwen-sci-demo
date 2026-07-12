import type { AgentSessionRunner } from "./agent-session-runner.js";
import type { ToolRuntime } from "./tool-runtime.js";
import type { DefaultEventBus, DefaultPermissionService, DefaultPromptAssembler, DefaultProviderRouter } from "./services.js";
import type { FilesystemArtifactStore, SqliteMessageStore, SqliteProvenanceStore, SqliteReviewStore, SqliteSessionStore, SqliteStorageConnection, SqliteToolCallStore } from "./storage.js";
import type { InMemoryAgentRegistry, InMemoryPackRegistry, InMemoryReviewerRegistry, InMemoryStageVerifierRegistry, InMemoryToolRegistry } from "./registries.js";

export type ModelRef = { provider: string; model: string };
export type RuntimeStatus = "completed" | "failed" | "partial";
export type Strategy = "direct" | "retry" | "critic_revise" | "workflow_controlled" | (string & {});
export type MessageRole = "system" | "user" | "assistant" | "tool";

export type Session = {
  id: string;
  parentId?: string;
  title: string;
  agentId: string;
  status: string;
  input: string;
  cwd: string;
  model?: ModelRef;
  permissions: unknown[];
  strategyRecordId?: string;
  artifactIds: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type Message = {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  toolCallId?: string;
  artifactIds: string[];
  model?: ModelRef;
  tokenUsage?: Record<string, number>;
  createdAt: string;
};

export type Artifact = {
  id: string;
  sessionId: string;
  type: string;
  mediaType: string;
  path: string;
  sha256: string;
  size: number;
  createdBy: Record<string, unknown>;
  createdAt: string;
};

export type ReviewFinding = {
  id: string;
  sessionId: string;
  severity: "blocking" | "high" | "major" | "minor" | "info";
  category: string;
  targetType: string;
  targetRef: string;
  description: string;
  suggestedAction?: string;
  status: "open" | "resolved" | "accepted_risk";
  createdAt: string;
};

export type AgentDefinition = {
  id: string;
  name: string;
  description: string;
  mode: "primary" | "subagent" | "all" | "system";
  prompt: string;
  model?: ModelRef;
  permissions: unknown[];
  allowedTools?: string[];
  maxTurns?: number;
  temperature?: number;
  supportsStrategySelection?: boolean;
  metadata?: Record<string, unknown>;
};

export type ToolDefinition<I = unknown, O = unknown> = {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  permission: Record<string, unknown>;
  execute(ctx: ToolContext, input: I): Promise<O>;
};

export type ToolContext = {
  runtime: RuntimeServices;
  sessionId: string;
  agentId: string;
  toolCallId: string;
  emit(event: RuntimeEvent): Promise<void>;
  createArtifact(input: CreateArtifactInput): Promise<Artifact>;
  recordProvenance(input: RecordProvenanceInput): Promise<void>;
};

export type CapabilityPack = {
  id: string;
  name: string;
  version: string;
  description?: string;
  agents?: AgentDefinition[];
  tools?: ToolDefinition[];
  reviewers?: ReviewerDefinition[];
  workflows?: WorkflowDefinition[];
  stageContracts?: StageContractDefinition[];
  activate?(services: RuntimeServices): void;
};

export type WorkflowDefinition = {
  id: string;
  name: string;
  description: string;
  defaultStrategy: "workflow_controlled";
  run(ctx: WorkflowContext, input: { input: string; metadata?: Record<string, unknown> }): Promise<RunnerResult>;
};

export type WorkflowContext = {
  sessionId: string;
  services: RuntimeServices;
  task(input: TaskInput): Promise<TaskOutput>;
  createArtifact(input: CreateArtifactInput): Promise<Artifact>;
  recordProvenance(input: RecordProvenanceInput): Promise<void>;
};

export type ReviewerDefinition = {
  id: string;
  name: string;
  description: string;
  review(ctx: { sessionId: string; artifactIds: string[]; services: RuntimeServices }): Promise<{ findingIds: string[]; blockingFindingIds: string[]; summary: string }>;
};

export type ArtifactRequirement = {
  type?: string;
  mediaType?: string;
  stage?: string;
  minCount?: number;
  required?: boolean;
};

export type StageVerifierResult = {
  ok: boolean;
  message: string;
  severity?: "blocking" | "high" | "major" | "minor" | "info";
  category?: string;
  targetRef?: string;
  diagnostics?: {
    target?: string;
    missing?: string[];
    invalid?: string[];
    found?: string[];
    requiredFixes?: string[];
    hints?: string[];
    details?: Record<string, unknown>;
  };
};

export type StageVerifierContext = {
  sessionId: string;
  services: RuntimeServices;
  contract: StageContractDefinition;
  stage: StageSpec;
  artifactIds: string[];
  state: Record<string, unknown>;
};

export type StageVerifierDefinition = {
  id: string;
  description: string;
  verify(ctx: StageVerifierContext): Promise<StageVerifierResult>;
};

export type StageExecutionContext = {
  sessionId: string;
  services: RuntimeServices;
  contract: StageContractDefinition;
  stage: StageSpec;
  attempt: number;
  feedback: string[];
  agentTask?: TaskOutput;
  input: string;
  metadata: Record<string, unknown>;
  artifactIds: string[];
  state: Record<string, unknown>;
  task(input: TaskInput): Promise<TaskOutput>;
  tool(input: { toolId: string; input: unknown }): Promise<{ toolCallId: string; output: unknown }>;
  createArtifact(input: CreateArtifactInput): Promise<Artifact>;
  recordProvenance(input: RecordProvenanceInput): Promise<void>;
};

export type StageExecutionResult = {
  output?: string;
  artifactIds?: string[];
  statePatch?: Record<string, unknown>;
  nextStageId?: string;
  status?: "completed" | "partial" | "failed";
};

export type StageTransition = {
  when: "passed" | "failed" | "always";
  stageId?: string;
};

export type StageReviewPolicy = {
  reviewerId?: string;
  agentId?: string;
  mode?: "always" | "on_failure" | "never";
};

export type StageGateVerifierPolicy = {
  id: string;
  hardGate?: boolean;
};

export type StageGateDecisionRule = {
  when: "passed" | "failed" | "hard_gate_failed" | "verifier_failed" | "review_blocking" | "review_major" | (string & {});
  action: "next" | "retry_stage" | "go_to_stage" | "partial" | "fail" | "continue";
  stageId?: string;
};

export type StageGatePolicy = {
  deterministic?: StageGateVerifierPolicy[];
  semantic?: StageReviewPolicy;
  rules?: StageGateDecisionRule[];
};

export type StageSpec = {
  id: string;
  name?: string;
  goal: string;
  agentId?: string;
  allowedTools?: string[];
  requiredInputs?: string[];
  requiredArtifacts?: ArtifactRequirement[];
  verifiers?: string[];
  review?: StageReviewPolicy;
  retryPolicy?: { maxAttempts?: number; onFailure?: "retry_stage" | "fail" | "continue" };
  gate?: StageGatePolicy;
  next?: StageTransition[];
  run?(ctx: StageExecutionContext): Promise<StageExecutionResult>;
};

export type StageContractDefinition = {
  id: string;
  name: string;
  description: string;
  initialStageId: string;
  stages: StageSpec[];
  maxStages?: number;
};

export type RuntimeConfig = {
  cwd: string;
  paths: { root: string; database: string; artifacts: string; logs: string; cache: string };
  defaultModel: ModelRef;
  providers: { openaiCompatible?: { baseUrl?: string; apiKeyEnv?: string; apiKey?: string } };
  limits: { maxRetries: number; maxReviewRounds: number };
  permissions: Record<string, unknown>;
};

export type RuntimeRunInput = {
  input: string;
  agentId?: string;
  strategy?: Strategy | "auto";
  model?: ModelRef;
  cwd?: string;
  packIds?: string[];
  metadata?: Record<string, unknown>;
};

export type RuntimeRunResult = {
  sessionId: string;
  status: RuntimeStatus;
  output: string;
  artifactIds: string[];
  reviewFindingIds: string[];
};

export type RunnerResult = RuntimeRunResult;
export type RuntimeEvent = Record<string, unknown> & { type: string };
export type ModelMessage = { role: MessageRole; content: string };
export type ModelToolCall = { id?: string; toolId: string; input: unknown };
export type ModelResponse = { content: string; toolCalls?: ModelToolCall[]; usage?: Record<string, number> };
export type ModelRequest = { provider: string; model: string; messages: ModelMessage[]; tools?: unknown[]; temperature?: number; maxTokens?: number; metadata?: Record<string, unknown> };
export type ModelProvider = { id: string; complete(request: ModelRequest): Promise<ModelResponse> };
export type CreateArtifactInput = { sessionId?: string; type: string; mediaType: string; content: string | Buffer; createdBy?: Record<string, unknown> };
export type RecordProvenanceInput = { nodes?: { type: string; refId: string; label: string; metadata?: Record<string, unknown> }[]; edges?: { type: string; fromRef: string; toRef: string; metadata?: Record<string, unknown> }[] };
export type ExecutionDecision = { strategy: Strategy; reason: string; confidence: number; config?: Record<string, unknown>; risks?: string[] };
export type PackWorkflowDecision = { workflowId?: string; packId?: string; reason: string; confidence: number };
export type TaskInput = { agentId: string; description: string; input: string; model?: ModelRef; contextArtifactIds?: string[] };
export type TaskOutput = { childSessionId: string; status: RuntimeStatus; summary: string; artifactIds: string[] };

export type RuntimeServices = {
  config: RuntimeConfig;
  storage: SqliteStorageConnection;
  sessionStore: SqliteSessionStore;
  messageStore: SqliteMessageStore;
  toolCallStore: SqliteToolCallStore;
  artifactStore: FilesystemArtifactStore;
  provenanceStore: SqliteProvenanceStore;
  reviewStore: SqliteReviewStore;
  agentRegistry: InMemoryAgentRegistry;
  toolRegistry: InMemoryToolRegistry;
  reviewerRegistry: InMemoryReviewerRegistry;
  verifierRegistry: InMemoryStageVerifierRegistry;
  packRegistry: InMemoryPackRegistry;
  providerRouter: DefaultProviderRouter;
  promptAssembler: DefaultPromptAssembler;
  permissionService: DefaultPermissionService;
  eventBus: DefaultEventBus;
  extensions: Map<string, unknown>;
};

export type RuntimeInternals = {
  agentSessionRunner: AgentSessionRunner;
  toolRuntime: ToolRuntime;
};
