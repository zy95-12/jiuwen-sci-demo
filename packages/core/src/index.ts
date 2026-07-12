import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type ModelRef = { provider: string; model: string };
export type RuntimeStatus = "completed" | "failed" | "partial";
export type Strategy = "direct" | "retry" | "critic_revise" | "workflow_controlled" | (string & {});
export type MessageRole = "system" | "user" | "assistant" | "tool";

export class RuntimeError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

export function parseModelRef(input?: string | ModelRef): ModelRef | undefined {
  if (!input) return undefined;
  if (typeof input !== "string") return input;
  const idx = input.indexOf(":");
  if (idx < 1) throw new RuntimeError("MODEL_REF_INVALID", input);
  return { provider: input.slice(0, idx), model: input.slice(idx + 1) };
}

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

function j(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    const parsed = JSON.parse(value) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export class SqliteStorageConnection {
  private db?: DatabaseSync;
  constructor(readonly filename: string) {}
  async connect(): Promise<void> {
    await mkdir(path.dirname(this.filename), { recursive: true });
    this.db = new DatabaseSync(this.filename);
    this.migrate();
  }
  async close(): Promise<void> {
    this.db?.close();
  }
  run(sql: string, params: unknown[] = []): void {
    this.required().prepare(sql).run(...(params as any[]));
  }
  get<T = any>(sql: string, params: unknown[] = []): T | undefined {
    return this.required().prepare(sql).get(...(params as any[])) as T | undefined;
  }
  all<T = any>(sql: string, params: unknown[] = []): T[] {
    return this.required().prepare(sql).all(...(params as any[])) as T[];
  }
  private required(): DatabaseSync {
    if (!this.db) throw new RuntimeError("DB_NOT_CONNECTED", this.filename);
    return this.db;
  }
  private migrate(): void {
    const ddl = `
create table if not exists sessions (id text primary key,parent_id text,agent_id text not null,title text,status text not null,input text,cwd text,model_json text,permissions_json text,strategy_record_id text,artifact_ids_json text,metadata_json text,created_at text not null,updated_at text not null);
create table if not exists messages (id text primary key,session_id text not null,role text not null,content text not null,tool_call_id text,artifact_ids_json text,model_json text,token_usage_json text,created_at text not null);
create table if not exists strategy_records (id text primary key,session_id text not null,user_requested_strategy text,agent_decision_json text not null,guard_result_json text not null,final_strategy text not null,created_at text not null);
create table if not exists tool_calls (id text primary key,session_id text not null,tool_id text not null,input_json text,output_json text,status text not null,error_json text,created_at text not null,completed_at text);
create table if not exists artifacts (id text primary key,session_id text not null,type text not null,media_type text not null,path text not null,sha256 text not null,size integer not null,created_by_json text,created_at text not null);
create table if not exists provenance_nodes (id text primary key,type text not null,ref_id text not null,label text,metadata_json text);
create table if not exists provenance_edges (id text primary key,type text not null,from_node_id text not null,to_node_id text not null,metadata_json text);
create table if not exists review_findings (id text primary key,session_id text not null,severity text not null,category text,target_type text,target_ref text,description text not null,suggested_action text,status text not null,created_at text not null);
`;
    for (const stmt of ddl.split(";").map((s) => s.trim()).filter(Boolean)) this.run(stmt);
  }
  strategyRecords = {
    create: async (input: { sessionId: string; userRequestedStrategy?: string; agentDecision: ExecutionDecision; guardResult: unknown; finalStrategy: string }) => {
      const rec = { id: createId("str"), createdAt: new Date().toISOString(), ...input };
      this.run("insert into strategy_records values (?, ?, ?, ?, ?, ?, ?)", [rec.id, rec.sessionId, rec.userRequestedStrategy ?? null, j(rec.agentDecision), j(rec.guardResult), rec.finalStrategy, rec.createdAt]);
      return rec;
    },
    get: async (id: string) => {
      const row = this.get<any>("select * from strategy_records where id = ?", [id]);
      return row ? { id: row.id as string, sessionId: row.session_id as string, finalStrategy: row.final_strategy as string, agentDecision: parseJson<ExecutionDecision>(row.agent_decision_json, { strategy: "direct", reason: "", confidence: 1 }) } : null;
    }
  };
}

export class SqliteSessionStore {
  constructor(private db: SqliteStorageConnection) {}
  async create(input: { parentId?: string; agentId: string; input: string; cwd: string; model?: ModelRef; title?: string; permissions?: unknown[]; metadata?: Record<string, unknown> }): Promise<Session> {
    const now = new Date().toISOString();
    const session: Session = { id: createId("ses"), parentId: input.parentId, title: input.title ?? input.input.slice(0, 80), agentId: input.agentId, status: "created", input: input.input, cwd: input.cwd, model: input.model, permissions: input.permissions ?? [], artifactIds: [], metadata: input.metadata ?? {}, createdAt: now, updatedAt: now };
    this.db.run("insert into sessions values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [session.id, session.parentId ?? null, session.agentId, session.title, session.status, session.input, session.cwd, j(session.model), j(session.permissions), null, j(session.artifactIds), j(session.metadata), session.createdAt, session.updatedAt]);
    return session;
  }
  async get(id: string): Promise<Session | null> {
    const r = this.db.get<any>("select * from sessions where id = ?", [id]);
    return r ? mapSession(r) : null;
  }
  async update(id: string, patch: Partial<Session>): Promise<Session> {
    const cur = await this.get(id);
    if (!cur) throw new RuntimeError("SESSION_NOT_FOUND", id);
    const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    this.db.run("update sessions set title=?, status=?, strategy_record_id=?, artifact_ids_json=?, metadata_json=?, updated_at=? where id=?", [next.title, next.status, next.strategyRecordId ?? null, j(next.artifactIds), j(next.metadata), next.updatedAt, id]);
    return next;
  }
  async list(limit = 50): Promise<Session[]> {
    return this.db.all<any>("select * from sessions order by created_at desc limit ?", [limit]).map(mapSession);
  }
  async children(parentId: string): Promise<Session[]> {
    return this.db.all<any>("select * from sessions where parent_id = ? order by created_at asc", [parentId]).map(mapSession);
  }
}

function mapSession(r: any): Session {
  return { id: r.id, parentId: r.parent_id ?? undefined, agentId: r.agent_id, title: r.title, status: r.status, input: r.input, cwd: r.cwd, model: parseJson<ModelRef | undefined>(r.model_json, undefined), permissions: parseJson<unknown[]>(r.permissions_json, []), strategyRecordId: r.strategy_record_id ?? undefined, artifactIds: parseJson<string[]>(r.artifact_ids_json, []), metadata: parseJson<Record<string, unknown>>(r.metadata_json, {}), createdAt: r.created_at, updatedAt: r.updated_at };
}

export class SqliteMessageStore {
  constructor(private db: SqliteStorageConnection) {}
  async append(input: { sessionId: string; role: MessageRole; content: string; toolCallId?: string; artifactIds?: string[]; model?: ModelRef; tokenUsage?: Record<string, number> }): Promise<Message> {
    const msg: Message = { id: createId("msg"), artifactIds: input.artifactIds ?? [], createdAt: new Date().toISOString(), ...input };
    this.db.run("insert into messages values (?, ?, ?, ?, ?, ?, ?, ?, ?)", [msg.id, msg.sessionId, msg.role, msg.content, msg.toolCallId ?? null, j(msg.artifactIds), j(msg.model), j(msg.tokenUsage), msg.createdAt]);
    return msg;
  }
  async listBySession(sessionId: string): Promise<Message[]> {
    return this.db.all<any>("select * from messages where session_id = ? order by created_at asc", [sessionId]).map((r) => ({ id: r.id, sessionId: r.session_id, role: r.role, content: r.content, toolCallId: r.tool_call_id ?? undefined, artifactIds: parseJson<string[]>(r.artifact_ids_json, []), model: parseJson<ModelRef | undefined>(r.model_json, undefined), tokenUsage: parseJson<Record<string, number> | undefined>(r.token_usage_json, undefined), createdAt: r.created_at }));
  }
}

export class SqliteToolCallStore {
  constructor(private db: SqliteStorageConnection) {}
  async create(input: { sessionId: string; toolId: string; inputJson: unknown; status: string }) {
    const call = { id: createId("call"), createdAt: new Date().toISOString(), ...input };
    this.db.run("insert into tool_calls values (?, ?, ?, ?, ?, ?, ?, ?, ?)", [call.id, call.sessionId, call.toolId, j(call.inputJson), null, call.status, null, call.createdAt, null]);
    return call;
  }
  async complete(id: string, output: unknown): Promise<void> {
    this.db.run("update tool_calls set status='completed', output_json=?, completed_at=? where id=?", [j(output), new Date().toISOString(), id]);
  }
  async fail(id: string, error: unknown): Promise<void> {
    this.db.run("update tool_calls set status='failed', error_json=?, completed_at=? where id=?", [j(error), new Date().toISOString(), id]);
  }
}

export class FilesystemArtifactStore {
  constructor(private root: string, private db: SqliteStorageConnection) {}
  async create(input: CreateArtifactInput & { sessionId: string; createdBy: Record<string, unknown> }): Promise<Artifact> {
    const bytes = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const rel = path.join("sha256", sha256.slice(0, 2), sha256);
    const abs = path.join(this.root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, bytes);
    const artifact: Artifact = { id: createId("art"), sessionId: input.sessionId, type: input.type, mediaType: input.mediaType, path: rel, sha256, size: bytes.length, createdBy: input.createdBy, createdAt: new Date().toISOString() };
    this.db.run("insert into artifacts values (?, ?, ?, ?, ?, ?, ?, ?, ?)", [artifact.id, artifact.sessionId, artifact.type, artifact.mediaType, artifact.path, artifact.sha256, artifact.size, j(artifact.createdBy), artifact.createdAt]);
    return artifact;
  }
  async get(id: string): Promise<Artifact | null> {
    const r = this.db.get<any>("select * from artifacts where id = ?", [id]);
    return r ? { id: r.id, sessionId: r.session_id, type: r.type, mediaType: r.media_type, path: r.path, sha256: r.sha256, size: r.size, createdBy: parseJson<Record<string, unknown>>(r.created_by_json, {}), createdAt: r.created_at } : null;
  }
  async read(id: string): Promise<Buffer> {
    const a = await this.get(id);
    if (!a) throw new RuntimeError("ARTIFACT_NOT_FOUND", id);
    return readFile(path.join(this.root, a.path));
  }
  async listBySession(sessionId: string): Promise<Artifact[]> {
    const rows = this.db.all<any>("select id from artifacts where session_id = ? order by created_at asc", [sessionId]);
    return (await Promise.all(rows.map((r) => this.get(r.id)))).filter((x): x is Artifact => Boolean(x));
  }
  async listAll(limit = 50): Promise<Artifact[]> {
    const rows = this.db.all<any>("select id from artifacts order by created_at desc limit ?", [limit]);
    return (await Promise.all(rows.map((r) => this.get(r.id)))).filter((x): x is Artifact => Boolean(x));
  }
}

export class SqliteProvenanceStore {
  constructor(private db: SqliteStorageConnection) {}
  async record(input: RecordProvenanceInput): Promise<void> {
    const refToNode = new Map<string, string>();
    for (const n of input.nodes ?? []) {
      const id = createId("node");
      this.db.run("insert into provenance_nodes values (?, ?, ?, ?, ?)", [id, n.type, n.refId, n.label, j(n.metadata ?? {})]);
      refToNode.set(n.refId, id);
    }
    for (const e of input.edges ?? []) {
      this.db.run("insert into provenance_edges values (?, ?, ?, ?, ?)", [createId("edge"), e.type, refToNode.get(e.fromRef) ?? e.fromRef, refToNode.get(e.toRef) ?? e.toRef, j(e.metadata ?? {})]);
    }
  }
  async trace(refId: string): Promise<unknown> {
    const nodes = this.db.all<any>("select * from provenance_nodes where ref_id = ? or id = ?", [refId, refId]);
    const ids = nodes.map((n) => n.id);
    const edges = ids.length ? this.db.all<any>(`select * from provenance_edges where to_node_id in (${ids.map(() => "?").join(",")}) or from_node_id in (${ids.map(() => "?").join(",")})`, [...ids, ...ids]) : [];
    return { refId, nodes, edges };
  }
}

export class SqliteReviewStore {
  constructor(private db: SqliteStorageConnection) {}
  async create(input: Omit<ReviewFinding, "id" | "createdAt" | "status"> & { status?: ReviewFinding["status"] }): Promise<ReviewFinding> {
    const f: ReviewFinding = { id: createId("rev"), status: input.status ?? "open", createdAt: new Date().toISOString(), ...input };
    this.db.run("insert into review_findings values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [f.id, f.sessionId, f.severity, f.category, f.targetType, f.targetRef, f.description, f.suggestedAction ?? null, f.status, f.createdAt]);
    return f;
  }
  async listBySession(sessionId: string): Promise<ReviewFinding[]> {
    return this.db.all<any>("select * from review_findings where session_id = ? order by created_at asc", [sessionId]).map(mapFinding);
  }
  async listBySessionTree(sessionId: string): Promise<ReviewFinding[]> {
    return this.db.all<any>(`
      with recursive session_tree(id) as (
        select id from sessions where id = ?
        union all
        select sessions.id from sessions join session_tree on sessions.parent_id = session_tree.id
      )
      select review_findings.* from review_findings
      join session_tree on review_findings.session_id = session_tree.id
      order by review_findings.created_at asc
    `, [sessionId]).map(mapFinding);
  }
  async listOpenBlocking(sessionId: string): Promise<ReviewFinding[]> {
    return this.db.all<any>("select * from review_findings where session_id = ? and severity = 'blocking' and status = 'open'", [sessionId]).map(mapFinding);
  }
  async listOpenBlockingBySessionTree(sessionId: string): Promise<ReviewFinding[]> {
    return this.db.all<any>(`
      with recursive session_tree(id) as (
        select id from sessions where id = ?
        union all
        select sessions.id from sessions join session_tree on sessions.parent_id = session_tree.id
      )
      select review_findings.* from review_findings
      join session_tree on review_findings.session_id = session_tree.id
      where review_findings.severity = 'blocking' and review_findings.status = 'open'
      order by review_findings.created_at asc
    `, [sessionId]).map(mapFinding);
  }
  async acceptRisk(ids: string[]): Promise<void> {
    for (const id of ids) this.db.run("update review_findings set status='accepted_risk' where id=?", [id]);
  }
}

function mapFinding(r: any): ReviewFinding {
  return { id: r.id, sessionId: r.session_id, severity: r.severity, category: r.category, targetType: r.target_type, targetRef: r.target_ref, description: r.description, suggestedAction: r.suggested_action ?? undefined, status: r.status, createdAt: r.created_at };
}

export class InMemoryAgentRegistry {
  private agents = new Map<string, AgentDefinition>();
  register(agent: AgentDefinition): void {
    if (this.agents.has(agent.id)) throw new RuntimeError("AGENT_DUPLICATE", agent.id);
    this.agents.set(agent.id, agent);
  }
  get(id: string): AgentDefinition | null { return this.agents.get(id) ?? null; }
  list(filter: { mode?: string } = {}): AgentDefinition[] {
    return [...this.agents.values()].filter((a) => !filter.mode || a.mode === filter.mode || a.mode === "all");
  }
  canRunAs(id: string, mode: "primary" | "subagent" | "system"): boolean {
    const a = this.get(id);
    if (!a) return false;
    if (a.mode === "all") return mode !== "system";
    return a.mode === mode;
  }
}

export class InMemoryToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.id)) throw new RuntimeError("TOOL_DUPLICATE", tool.id);
    this.tools.set(tool.id, tool);
  }
  get(id: string): ToolDefinition | null { return this.tools.get(id) ?? null; }
  list(): ToolDefinition[] { return [...this.tools.values()]; }
  listForAgent(agent: AgentDefinition): ToolDefinition[] {
    return agent.allowedTools ? agent.allowedTools.map((id) => this.get(id)).filter((t): t is ToolDefinition => Boolean(t)) : this.list();
  }
}

export class InMemoryReviewerRegistry {
  private reviewers = new Map<string, ReviewerDefinition>();
  register(reviewer: ReviewerDefinition): void { this.reviewers.set(reviewer.id, reviewer); }
  get(id: string): ReviewerDefinition | null { return this.reviewers.get(id) ?? null; }
  list(): ReviewerDefinition[] { return [...this.reviewers.values()]; }
}

export class InMemoryStageVerifierRegistry {
  private verifiers = new Map<string, StageVerifierDefinition>();
  register(verifier: StageVerifierDefinition): void {
    if (this.verifiers.has(verifier.id)) throw new RuntimeError("VERIFIER_DUPLICATE", verifier.id);
    this.verifiers.set(verifier.id, verifier);
  }
  get(id: string): StageVerifierDefinition | null { return this.verifiers.get(id) ?? null; }
  list(): StageVerifierDefinition[] { return [...this.verifiers.values()]; }
}

export class InMemoryPackRegistry {
  private packs = new Map<string, CapabilityPack>();
  private workflows = new Map<string, WorkflowDefinition>();
  private stageContracts = new Map<string, StageContractDefinition>();
  register(pack: CapabilityPack): void {
    if (this.packs.has(pack.id)) return;
    this.packs.set(pack.id, pack);
    for (const workflow of pack.workflows ?? []) this.workflows.set(workflow.id, workflow);
    for (const contract of pack.stageContracts ?? []) this.stageContracts.set(contract.id, contract);
  }
  get(id: string): CapabilityPack | null { return this.packs.get(id) ?? null; }
  list(): CapabilityPack[] { return [...this.packs.values()]; }
  getWorkflow(id: string): WorkflowDefinition | null { return this.workflows.get(id) ?? null; }
  getStageContract(id: string): StageContractDefinition | null { return this.stageContracts.get(id) ?? null; }
  workflowCatalog(): { packId: string; packName: string; workflowId: string; workflowName: string; description: string }[] {
    return [...this.packs.values()].flatMap((pack) => (pack.workflows ?? []).map((workflow) => ({
      packId: pack.id,
      packName: pack.name,
      workflowId: workflow.id,
      workflowName: workflow.name,
      description: workflow.description
    })));
  }
  stageContractCatalog(): { packId: string; packName: string; contractId: string; contractName: string; description: string }[] {
    return [...this.packs.values()].flatMap((pack) => (pack.stageContracts ?? []).map((contract) => ({
      packId: pack.id,
      packName: pack.name,
      contractId: contract.id,
      contractName: contract.name,
      description: contract.description
    })));
  }
}

export class DefaultProviderRouter {
  private providers = new Map<string, ModelProvider>();
  register(provider: ModelProvider): void { this.providers.set(provider.id, provider); }
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const provider = this.providers.get(request.provider);
    if (!provider) throw new RuntimeError("PROVIDER_NOT_FOUND", request.provider);
    return provider.complete(request);
  }
  list(): string[] { return [...this.providers.keys()]; }
}

export class DefaultPromptAssembler {
  async assemble(input: { session: Session; agent: AgentDefinition; messages: Message[]; availableTools: ToolDefinition[]; contextArtifacts?: Artifact[]; strategyRecord?: unknown }): Promise<ModelMessage[]> {
    const system = [
      input.agent.prompt,
      "You are running inside jiuwen-sci Agent Runtime. Use tools when needed. Do not claim an artifact exists unless it has been created. For delegated work, call the task tool. For final answers, use finalize.",
      `Agent id: ${input.agent.id}`,
      `Available tools:\n${input.availableTools.map((t) => `- ${t.id}: ${t.description}`).join("\n")}`,
      input.contextArtifacts?.length ? `Context artifacts:\n${input.contextArtifacts.map((a) => `- ${a.id} ${a.type} ${a.path}`).join("\n")}` : ""
    ].filter(Boolean).join("\n\n---\n\n");
    return [{ role: "system", content: system }, ...input.messages.map((m) => ({ role: m.role, content: m.content }))];
  }
}

export class DefaultPermissionService {
  async check(): Promise<{ allowed: boolean; reason?: string }> { return { allowed: true }; }
}

export class DefaultEventBus {
  readonly events: RuntimeEvent[] = [];
  constructor(private sink?: (event: RuntimeEvent) => void) {}
  async emit(event: RuntimeEvent): Promise<void> {
    this.events.push(event);
    this.sink?.(event);
  }
}

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
  registry.register({ id: "reviewer", name: "Reviewer", description: "Read-only reviewer for checking consistency.", mode: "subagent", prompt: "Review current artifacts and record findings. Do not write new source artifacts.", permissions: [], allowedTools: ["artifact_read", "review_finding_write", "finalize"], maxTurns: 6 });
}

export function registerCoreTools(registry: InMemoryToolRegistry): void {
  registry.register(artifactWriteTool);
  registry.register(artifactReadTool);
  registry.register(finalizeTool);
  registry.register(taskTool);
  registry.register(reviewFindingWriteTool);
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

const objectSchema = { type: "object" };
const stringProp = { type: "string", minLength: 1 };

export const artifactWriteTool: ToolDefinition<any, any> = {
  id: "artifact_write", name: "Artifact Write", description: "Create an artifact. Prefer passing content as a string; if omitted, structured fields are serialized as JSON.", inputSchema: { type: "object", properties: { type: stringProp, mediaType: stringProp, content: { type: "string" }, name: stringProp } }, outputSchema: objectSchema, permission: { kind: "runtime" },
  async execute(ctx, input) {
    const hasExplicitContent = typeof input.content === "string";
    const structured = Object.fromEntries(Object.entries(input).filter(([key]) => !["type", "mediaType", "name", "content"].includes(key)));
    const inferredJson = Object.keys(structured).length > 0;
    const type = input.type ?? (inferredJson ? "json" : "markdown");
    const mediaType = input.mediaType ?? (type === "json" ? "application/json" : "text/markdown");
    const content = hasExplicitContent ? input.content : (inferredJson ? JSON.stringify(structured, null, 2) : "");
    const artifact = await ctx.createArtifact({ type, mediaType, content });
    await ctx.recordProvenance({ nodes: [{ type: "artifact", refId: artifact.id, label: input.name ?? "Artifact" }, { type: "tool_call", refId: ctx.toolCallId, label: ctx.toolCallId }], edges: [{ type: "created", fromRef: ctx.toolCallId, toRef: artifact.id }] });
    return { artifactId: artifact.id, path: artifact.path, size: artifact.size };
  }
};

export const artifactReadTool: ToolDefinition<any, any> = {
  id: "artifact_read", name: "Artifact Read", description: "Read artifact text.", inputSchema: { type: "object", required: ["artifactId"], properties: { artifactId: stringProp } }, outputSchema: objectSchema, permission: { kind: "runtime" },
  async execute(ctx, input) {
    const bytes = await ctx.runtime.artifactStore.read(String(input.artifactId));
    return { artifactId: input.artifactId, content: bytes.toString("utf8") };
  }
};

export const reviewFindingWriteTool: ToolDefinition<any, any> = {
  id: "review_finding_write", name: "Review Finding Write", description: "Record a review finding.", inputSchema: { type: "object", required: ["description"], properties: { severity: stringProp, category: stringProp, targetType: stringProp, targetRef: stringProp, description: stringProp, suggestedAction: stringProp } }, outputSchema: objectSchema, permission: { kind: "runtime" },
  async execute(ctx, input) {
    const finding = await ctx.runtime.reviewStore.create({ sessionId: ctx.sessionId, severity: input.severity ?? "minor", category: input.category ?? "general", targetType: input.targetType ?? "session", targetRef: input.targetRef ?? ctx.sessionId, description: String(input.description ?? "Review finding"), suggestedAction: input.suggestedAction });
    await ctx.recordProvenance({ nodes: [{ type: "review", refId: finding.id, label: finding.description }], edges: [] });
    return { findingId: finding.id, severity: finding.severity };
  }
};

export const finalizeTool: ToolDefinition<any, any> = {
  id: "finalize", name: "Finalize", description: "Finalize the current session output.", inputSchema: { type: "object", properties: { finalText: { type: "string" }, output: { type: "string" }, answer: { type: "string" }, content: { type: "string" }, text: { type: "string" }, acceptRisk: { type: "boolean" } } }, outputSchema: objectSchema, permission: { kind: "runtime" },
  async execute(ctx, input) {
    const blocking = await ctx.runtime.reviewStore.listOpenBlocking(ctx.sessionId);
    if (blocking.length && !input.acceptRisk) return { status: "blocked", output: "", blockingFindingIds: blocking.map((f) => f.id) };
    if (blocking.length && input.acceptRisk) await ctx.runtime.reviewStore.acceptRisk(blocking.map((f) => f.id));
    const finalText = String(input.finalText ?? input.output ?? input.answer ?? input.content ?? input.text ?? "");
    const artifact = await ctx.createArtifact({ type: "markdown", mediaType: "text/markdown", content: finalText });
    await ctx.recordProvenance({ nodes: [{ type: "artifact", refId: artifact.id, label: "Final output" }, { type: "tool_call", refId: ctx.toolCallId, label: ctx.toolCallId }], edges: [{ type: "created", fromRef: ctx.toolCallId, toRef: artifact.id }] });
    return { status: "finalized", output: finalText, artifactId: artifact.id, blockingFindingIds: [] };
  }
};

export const taskTool: ToolDefinition<TaskInput, TaskOutput> = {
  id: "task", name: "Task", description: "Delegate bounded work to a subagent running in a child session.", inputSchema: { type: "object", required: ["agentId", "description", "input"], properties: { agentId: stringProp, description: stringProp, input: stringProp, contextArtifactIds: { type: "array", items: stringProp } } }, outputSchema: objectSchema, permission: { kind: "runtime" },
  async execute(ctx, input) {
    const target = ctx.runtime.agentRegistry.get(input.agentId);
    if (!target) throw new RuntimeError("AGENT_NOT_FOUND", input.agentId);
    if (!ctx.runtime.agentRegistry.canRunAs(input.agentId, "subagent")) throw new RuntimeError("AGENT_NOT_SUBAGENT", input.agentId);
    const parent = await ctx.runtime.sessionStore.get(ctx.sessionId);
    if (!parent) throw new RuntimeError("SESSION_NOT_FOUND", ctx.sessionId);
    const child = await ctx.runtime.sessionStore.create({ parentId: parent.id, agentId: input.agentId, input: input.input, cwd: parent.cwd, model: input.model ?? target.model ?? parent.model, title: `${input.description} (@${input.agentId})`, permissions: target.permissions, metadata: { delegatedBy: ctx.agentId, contextArtifactIds: input.contextArtifactIds ?? [] } });
    await ctx.emit({ type: "task.started", parentSessionId: parent.id, childSessionId: child.id, agentId: input.agentId });
    try {
      const result = await new AgentSessionRunner(ctx.runtime).runSession({ sessionId: child.id, mode: "subagent", contextArtifactIds: input.contextArtifactIds ?? [] });
      await ctx.emit({ type: "task.completed", parentSessionId: parent.id, childSessionId: child.id });
      await ctx.recordProvenance({ nodes: [{ type: "session", refId: parent.id, label: `Parent ${parent.id}` }, { type: "session", refId: child.id, label: `Child ${child.id}` }], edges: [{ type: "spawned", fromRef: parent.id, toRef: child.id }] });
      return { childSessionId: child.id, status: result.status, summary: result.output, artifactIds: result.artifactIds };
    } catch (error) {
      await ctx.runtime.sessionStore.update(child.id, { status: "failed" });
      await ctx.emit({ type: "task.failed", parentSessionId: parent.id, childSessionId: child.id, agentId: input.agentId, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
};

export class ToolRuntime {
  constructor(private services: RuntimeServices) {}
  async execute(input: { sessionId: string; agentId: string; toolId: string; input: unknown; allowedToolIds?: string[] }): Promise<{ toolCallId: string; output: unknown }> {
    if (input.allowedToolIds && !input.allowedToolIds.includes(input.toolId)) throw new RuntimeError("TOOL_NOT_ALLOWED_IN_STAGE", input.toolId);
    const tool = this.services.toolRegistry.get(input.toolId);
    if (!tool) throw new RuntimeError("TOOL_NOT_FOUND", input.toolId);
    validateToolInput(tool, input.input);
    const perm = await this.services.permissionService.check();
    if (!perm.allowed) throw new RuntimeError("TOOL_PERMISSION_DENIED", perm.reason ?? input.toolId);
    const call = await this.services.toolCallStore.create({ sessionId: input.sessionId, toolId: input.toolId, inputJson: input.input, status: "running" });
    await this.services.eventBus.emit({ type: "tool.started", sessionId: input.sessionId, toolId: input.toolId });
    try {
      const ctx: ToolContext = {
        runtime: this.services, sessionId: input.sessionId, agentId: input.agentId, toolCallId: call.id,
        emit: (event) => this.services.eventBus.emit(event),
        createArtifact: (artifactInput) => this.services.artifactStore.create({ ...artifactInput, sessionId: input.sessionId, createdBy: { sessionId: input.sessionId, agentId: input.agentId, toolId: input.toolId } }),
        recordProvenance: (prov) => this.services.provenanceStore.record(prov)
      };
      const output = await tool.execute(ctx, input.input as never);
      await this.services.toolCallStore.complete(call.id, output);
      await this.services.eventBus.emit({ type: "tool.completed", sessionId: input.sessionId, toolId: input.toolId });
      return { toolCallId: call.id, output };
    } catch (error) {
      await this.services.toolCallStore.fail(call.id, error instanceof Error ? { message: error.message } : error);
      throw error;
    }
  }
}

export class StrategySelector {
  constructor(private services: RuntimeServices) {}
  async select(input: { agentId: string; userGoal: string; requestedStrategy?: Strategy | "auto"; model?: ModelRef }): Promise<ExecutionDecision> {
    if (input.requestedStrategy && input.requestedStrategy !== "auto") return { strategy: input.requestedStrategy, reason: "User explicitly requested this strategy.", confidence: 1 };
    const agent = this.services.agentRegistry.get(input.agentId);
    if (!agent?.supportsStrategySelection) return { strategy: "direct", reason: "Agent does not support strategy selection.", confidence: 1 };
    const model = input.model ?? agent.model ?? this.services.config.defaultModel;
    const response = await this.services.providerRouter.complete({ provider: model.provider, model: model.model, messages: [{ role: "system", content: "strategy selection: choose direct, retry, critic_revise, workflow_controlled. Return JSON only." }, { role: "user", content: input.userGoal }], temperature: 0, maxTokens: 800 });
    try {
      return JSON.parse(response.content) as ExecutionDecision;
    } catch {
      return { strategy: "direct", reason: "Strategy response was not JSON.", confidence: 0.5 };
    }
  }
}

export class PackWorkflowSelector {
  constructor(private services: RuntimeServices) {}
  async select(input: { userGoal: string; model?: ModelRef; allowedPackIds?: string[] }): Promise<PackWorkflowDecision> {
    const catalog = this.services.packRegistry.workflowCatalog()
      .filter((entry) => !input.allowedPackIds?.length || input.allowedPackIds.includes(entry.packId));
    if (catalog.length === 0) return { reason: "No registered pack workflows.", confidence: 1 };

    const heuristic = this.heuristic(input.userGoal, catalog);
    if (heuristic.confidence >= 0.9 || (input.model?.provider ?? this.services.config.defaultModel.provider) === "mock") return heuristic;

    const model = input.model ?? this.services.config.defaultModel;
    const response = await this.services.providerRouter.complete({
      provider: model.provider,
      model: model.model,
      messages: [
        {
          role: "system",
          content: [
            "You route a user goal to one registered jiuwen-sci capability-pack workflow.",
            "Choose a workflow only when the goal clearly matches it; otherwise return no workflowId.",
            "Return JSON only: {\"workflowId\":\"optional\", \"packId\":\"optional\", \"reason\":\"...\", \"confidence\":0.0}.",
            `Available workflows:\n${catalog.map((w) => `- ${w.workflowId} (pack ${w.packId}): ${w.description}`).join("\n")}`
          ].join("\n")
        },
        { role: "user", content: input.userGoal }
      ],
      temperature: 0,
      maxTokens: 600
    });
    try {
      const decision = JSON.parse(response.content) as PackWorkflowDecision;
      if (decision.workflowId && catalog.some((w) => w.workflowId === decision.workflowId)) return decision;
    } catch {
      // Fall through to deterministic routing.
    }
    return heuristic;
  }
  private heuristic(goal: string, catalog: { packId: string; workflowId: string }[]): PackWorkflowDecision {
    const lower = goal.toLowerCase();
    const wantsLiterature = [
      "literature", "paper", "papers", "survey", "review", "prisma", "citation", "doi",
      "文献", "论文", "综述", "调研", "引用", "检索"
    ].some((term) => lower.includes(term));
    const literature = catalog.find((w) => w.workflowId === "literature-review");
    if (wantsLiterature && literature) return { workflowId: literature.workflowId, packId: literature.packId, reason: "Goal matches literature-review workflow keywords.", confidence: 0.95 };
    return { reason: "No registered workflow clearly matches the goal.", confidence: 0.7 };
  }
}

export class DefaultStrategyGuard {
  constructor(private services: RuntimeServices) {}
  async validate(input: { decision: ExecutionDecision }): Promise<{ allowed: boolean; finalDecision: ExecutionDecision; warnings: string[]; reason?: string }> {
    const supported = new Set(["direct", "retry", "critic_revise", "workflow_controlled"]);
    const finalDecision = structuredClone(input.decision);
    const warnings: string[] = [];
    if (!supported.has(finalDecision.strategy)) {
      warnings.push(`Strategy ${finalDecision.strategy} is not supported in v0.1. Downgraded to direct.`);
      finalDecision.strategy = "direct";
    }
    if (finalDecision.strategy === "retry" && Number(finalDecision.config?.maxRetries ?? 1) > this.services.config.limits.maxRetries) {
      finalDecision.config = { ...finalDecision.config, maxRetries: this.services.config.limits.maxRetries };
      warnings.push("Reduced maxRetries to runtime limit.");
    }
    return { allowed: true, finalDecision, warnings };
  }
}

export class ExecutionEngine {
  private runners = new Map<string, ExecutionRunner>();
  constructor(private services: RuntimeServices, private selector: StrategySelector, private guard: DefaultStrategyGuard) {}
  registerRunner(runner: ExecutionRunner): void { this.runners.set(runner.strategy, runner); }
  async run(input: { sessionId: string; input: string; requestedStrategy?: Strategy | "auto" }): Promise<RuntimeRunResult> {
    const session = await this.services.sessionStore.get(input.sessionId);
    if (!session) throw new RuntimeError("SESSION_NOT_FOUND", input.sessionId);
    const decision = await this.selector.select({ agentId: session.agentId, userGoal: input.input, requestedStrategy: input.requestedStrategy, model: session.model });
    const guard = await this.guard.validate({ decision });
    const rec = await this.services.storage.strategyRecords.create({ sessionId: session.id, userRequestedStrategy: input.requestedStrategy, agentDecision: decision, guardResult: guard, finalStrategy: guard.finalDecision.strategy });
    await this.services.sessionStore.update(session.id, { strategyRecordId: rec.id });
    await this.services.eventBus.emit({ type: "strategy.selected", sessionId: session.id, strategy: guard.finalDecision.strategy });
    const runner = this.runners.get(guard.finalDecision.strategy);
    if (!runner) throw new RuntimeError("RUNNER_NOT_FOUND", guard.finalDecision.strategy);
    return runner.run({ sessionId: session.id, userGoal: input.input, decision: guard.finalDecision });
  }
  async resume(input: { sessionId: string }): Promise<RuntimeRunResult> {
    const session = await this.services.sessionStore.get(input.sessionId);
    if (!session) throw new RuntimeError("SESSION_NOT_FOUND", input.sessionId);
    const rec = session.strategyRecordId ? await this.services.storage.strategyRecords.get(session.strategyRecordId) : null;
    const strategy = rec?.finalStrategy ?? "direct";
    const runner = this.runners.get(strategy);
    if (!runner) throw new RuntimeError("RUNNER_NOT_FOUND", strategy);
    return runner.run({ sessionId: session.id, userGoal: session.input, decision: rec?.agentDecision ?? { strategy, reason: "Resumed existing session.", confidence: 1 } });
  }
}

export type ExecutionRunner = { strategy: Strategy; run(input: { sessionId: string; userGoal: string; decision: ExecutionDecision }): Promise<RunnerResult> };

export class DirectRunner implements ExecutionRunner {
  strategy: Strategy = "direct";
  constructor(private services: RuntimeServices) {}
  run(input: { sessionId: string }): Promise<RunnerResult> { return new AgentSessionRunner(this.services).runSession({ sessionId: input.sessionId, mode: "primary" }); }
}

export class RetryRunner implements ExecutionRunner {
  strategy: Strategy = "retry";
  constructor(private services: RuntimeServices) {}
  async run(input: { sessionId: string; decision: ExecutionDecision }): Promise<RunnerResult> {
    const max = Number(input.decision.config?.maxRetries ?? 2);
    let last: unknown;
    for (let i = 0; i <= max; i++) {
      try { return await new AgentSessionRunner(this.services).runSession({ sessionId: input.sessionId, mode: "primary", retryContext: i ? String(last) : undefined }); } catch (e) { last = e; }
    }
    throw last;
  }
}

export class CriticReviseRunner implements ExecutionRunner {
  strategy: Strategy = "critic_revise";
  constructor(private services: RuntimeServices) {}
  async run(input: { sessionId: string; decision: ExecutionDecision }): Promise<RunnerResult> {
    let result = await new AgentSessionRunner(this.services).runSession({ sessionId: input.sessionId, mode: "primary" });
    const max = Number(input.decision.config?.maxReviewRounds ?? 1);
    for (let i = 0; i < max; i++) {
      const ctx = createInternalToolContext(this.services, input.sessionId, "system");
      const review = await taskTool.execute(ctx, { agentId: "reviewer", description: "Review current output", input: "Review current artifacts and report blocking issues only for serious defects.", contextArtifactIds: result.artifactIds });
      const findings = await this.services.reviewStore.listBySession(review.childSessionId);
      if (!findings.some((f) => f.severity === "blocking" && f.status === "open")) return { ...result, reviewFindingIds: findings.map((f) => f.id) };
      result = await new AgentSessionRunner(this.services).runSession({ sessionId: input.sessionId, mode: "primary", revisionContext: review.summary });
    }
    return { ...result, status: "partial" };
  }
}

export class WorkflowRunner implements ExecutionRunner {
  strategy: Strategy = "workflow_controlled";
  constructor(private services: RuntimeServices) {}
  async run(input: { sessionId: string; userGoal: string; decision: ExecutionDecision }): Promise<RunnerResult> {
    const session = await this.services.sessionStore.get(input.sessionId);
    const workflowId = String(input.decision.config?.workflowId ?? session?.metadata.workflow ?? "");
    if (!workflowId) throw new RuntimeError("WORKFLOW_NOT_SPECIFIED", "workflow_controlled requires session.metadata.workflow or decision.config.workflowId");
    const workflow = this.services.packRegistry.getWorkflow(workflowId);
    if (!workflow) throw new RuntimeError("WORKFLOW_NOT_FOUND", workflowId);
    const ctx = createWorkflowContext(this.services, input.sessionId);
    await this.services.sessionStore.update(input.sessionId, { status: "running" });
    const result = await workflow.run(ctx, { input: input.userGoal, metadata: session?.metadata });
    await this.services.sessionStore.update(input.sessionId, { status: result.status === "completed" ? "completed" : result.status, artifactIds: result.artifactIds });
    return result;
  }
}

export class StageContractRunner {
  constructor(private services: RuntimeServices) {}
  async run(input: { sessionId: string; contractId: string; userGoal: string; metadata?: Record<string, unknown> }): Promise<RunnerResult> {
    const contract = this.services.packRegistry.getStageContract(input.contractId);
    if (!contract) throw new RuntimeError("STAGE_CONTRACT_NOT_FOUND", input.contractId);
    const stageById = new Map(contract.stages.map((stage) => [stage.id, stage]));
    let currentId: string | undefined = contract.initialStageId;
    let status: RuntimeStatus = "completed";
    let output = "";
    let artifactIds: string[] = [];
    let reviewFindingIds: string[] = [];
    const state: Record<string, unknown> = {};
    const maxStages = contract.maxStages ?? Math.max(20, contract.stages.length * 3);
    await this.services.sessionStore.update(input.sessionId, { status: "running" });

    for (let step = 0; currentId && step < maxStages; step++) {
      const stage = stageById.get(currentId);
      if (!stage) throw new RuntimeError("STAGE_NOT_FOUND", currentId);
      await this.services.eventBus.emit({ type: "stage.started", sessionId: input.sessionId, contractId: contract.id, stageId: stage.id });
      const attempts = Math.max(1, stage.retryPolicy?.maxAttempts ?? 1);
      let passed = false;
      let terminalAction: "partial" | "fail" | undefined;
      let lastResult: StageExecutionResult = {};

      for (let attempt = 1; attempt <= attempts; attempt++) {
        const feedback = (state[`stage.${stage.id}.feedback`] as string[] | undefined) ?? [];
        lastResult = await this.runStage({ contract, stage, sessionId: input.sessionId, userGoal: input.userGoal, metadata: input.metadata ?? {}, artifactIds, state, attempt, feedback });
        artifactIds = [...new Set([...artifactIds, ...(lastResult.artifactIds ?? [])])];
        Object.assign(state, lastResult.statePatch ?? {});
        output = lastResult.output ?? output;

        const gate = await this.evaluateGate(contract, stage, input.sessionId, artifactIds, state, attempt);
        artifactIds = [...new Set([...artifactIds, gate.reportArtifactId])];
        reviewFindingIds.push(...gate.findingIds);
        if (gate.action === "next" || gate.action === "continue" || gate.action === "go_to_stage") {
          passed = true;
          if (gate.action === "go_to_stage") lastResult.nextStageId = gate.nextStageId;
          await this.services.eventBus.emit({ type: gate.action === "go_to_stage" ? "stage.redirected" : "stage.completed", sessionId: input.sessionId, contractId: contract.id, stageId: stage.id, attempt, nextStageId: gate.nextStageId });
          break;
        }
        if (gate.action === "partial" || gate.action === "fail") terminalAction = gate.action;

        await this.services.eventBus.emit({ type: "stage.failed", sessionId: input.sessionId, contractId: contract.id, stageId: stage.id, attempt, messages: gate.messages, action: gate.action });
        state[`stage.${stage.id}.feedback`] = gate.messages;
        if (gate.action !== "retry_stage") break;
      }

      if (!passed && stage.retryPolicy?.onFailure !== "continue") {
        status = terminalAction === "fail" ? "failed" : "partial";
        break;
      }
      currentId = lastResult.nextStageId ?? resolveStageTransition(stage, passed);
    }

    if (currentId) status = "partial";
    const findings = await this.services.reviewStore.listBySessionTree(input.sessionId);
    reviewFindingIds = [...new Set([...reviewFindingIds, ...findings.map((f) => f.id)])];
    await this.services.sessionStore.update(input.sessionId, { status: status === "completed" ? "completed" : status, artifactIds: [...new Set(artifactIds)] });
    return { sessionId: input.sessionId, status, output, artifactIds: [...new Set(artifactIds)], reviewFindingIds };
  }

  private async runStage(input: { contract: StageContractDefinition; stage: StageSpec; sessionId: string; userGoal: string; metadata: Record<string, unknown>; artifactIds: string[]; state: Record<string, unknown>; attempt: number; feedback: string[] }): Promise<StageExecutionResult> {
    const { contract, stage, sessionId, userGoal, metadata, state } = input;
    let artifactIds = input.artifactIds;
    let agentTask: TaskOutput | undefined;
    if (stage.agentId) {
      const manifest = await createArtifactManifest(this.services, artifactIds);
      if (!this.services.agentRegistry.get(stage.agentId)) {
        await this.recordStageAgentFailure({ sessionId, contract, stage, state, feedback: input.feedback, message: `AGENT_NOT_FOUND: ${stage.agentId}` });
      } else {
      try {
        agentTask = await taskTool.execute(createInternalToolContext(this.services, sessionId, "stage-runner"), {
          agentId: stage.agentId,
          description: `Stage ${stage.id}`,
          input: renderStageAgentPrompt({ contract, stage, userGoal, attempt: input.attempt, feedback: input.feedback, artifactManifest: manifest }),
          contextArtifactIds: artifactIds
        });
        artifactIds = [...new Set([...artifactIds, ...agentTask.artifactIds])];
        state[`stage.${stage.id}.agentTask`] = agentTask;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.recordStageAgentFailure({ sessionId, contract, stage, state, feedback: input.feedback, message });
      }
      }
    }
    if (!stage.run) return { artifactIds: agentTask?.artifactIds ?? [], statePatch: agentTask ? { [`stage.${stage.id}.agentTask`]: agentTask } : undefined };
    const toolRuntime = new ToolRuntime(this.services);
    const result = await stage.run({
      sessionId,
      services: this.services,
      contract,
      stage,
      attempt: input.attempt,
      feedback: input.feedback,
      agentTask,
      input: userGoal,
      metadata,
      artifactIds,
      state,
      task: (taskInput) => taskTool.execute(createInternalToolContext(this.services, sessionId, "stage-runner"), taskInput),
      tool: (toolInput) => toolRuntime.execute({ sessionId, agentId: stage.agentId ?? "stage-runner", toolId: toolInput.toolId, input: toolInput.input, allowedToolIds: stage.allowedTools }),
      createArtifact: (artifactInput) => this.services.artifactStore.create({ ...artifactInput, sessionId, createdBy: { sessionId, agentId: stage.agentId ?? "stage-runner", toolId: "stage" } }),
      recordProvenance: (prov) => this.services.provenanceStore.record(prov)
    });
    return {
      ...result,
      artifactIds: [...new Set([...(agentTask?.artifactIds ?? []), ...(result.artifactIds ?? [])])],
      statePatch: { ...(agentTask ? { [`stage.${stage.id}.agentTask`]: agentTask } : {}), ...(result.statePatch ?? {}) }
    };
  }

  private async recordStageAgentFailure(input: { sessionId: string; contract: StageContractDefinition; stage: StageSpec; state: Record<string, unknown>; feedback: string[]; message: string }): Promise<void> {
    input.state[`stage.${input.stage.id}.agentError`] = input.message;
    input.state[`stage.${input.stage.id}.feedback`] = [...input.feedback, `Stage agent failed before producing valid artifacts: ${input.message}`];
    await this.services.reviewStore.create({
      sessionId: input.sessionId,
      severity: "major",
      category: "stage_agent_failed",
      targetType: "stage",
      targetRef: input.stage.id,
      description: `Stage agent failed before scaffold fallback: ${input.message}`,
      suggestedAction: "Use scaffold fallback for this attempt and tighten the stage agent tool arguments."
    });
    await this.services.eventBus.emit({ type: "stage.agent_failed", sessionId: input.sessionId, contractId: input.contract.id, stageId: input.stage.id, error: input.message });
  }

  private async evaluateGate(contract: StageContractDefinition, stage: StageSpec, sessionId: string, artifactIds: string[], state: Record<string, unknown>, attempt: number): Promise<{ action: StageGateDecisionRule["action"]; nextStageId?: string; messages: string[]; findingIds: string[]; reportArtifactId: string }> {
    const messages: string[] = [];
    const findingIds: string[] = [];
    const deterministicResults: (StageVerifierResult & { verifierId: string; hardGate: boolean })[] = [];
    const semanticFindings: ReviewFinding[] = [];
    const gate = effectiveGate(stage);

    for (const req of stage.requiredArtifacts ?? []) {
      const count = await countMatchingArtifacts(this.services, artifactIds, req);
      const minCount = req.minCount ?? (req.required === false ? 0 : 1);
      if (count < minCount) {
        const result = { verifierId: "required_artifact", hardGate: true, ok: false, message: `Missing required artifact for stage ${stage.id}: ${JSON.stringify(req)}`, severity: "blocking" as const, category: "missing_artifact" };
        deterministicResults.push(result);
        messages.push(result.message);
      }
    }

    for (const policy of gate.deterministic ?? []) {
      const verifier = this.services.verifierRegistry.get(policy.id);
      if (!verifier) throw new RuntimeError("VERIFIER_NOT_FOUND", policy.id);
      const result = await verifier.verify({ sessionId, services: this.services, contract, stage, artifactIds, state });
      deterministicResults.push({ ...result, verifierId: policy.id, hardGate: policy.hardGate === true });
      messages.push(result.message);
      if (!result.ok) {
        const severity = result.severity ?? "major";
        const finding = await this.services.reviewStore.create({
          sessionId,
          severity,
          category: result.category ?? `verifier:${policy.id}`,
          targetType: "stage",
          targetRef: result.targetRef ?? stage.id,
          description: result.message,
          suggestedAction: "Revise the stage output and rerun verification."
        });
        findingIds.push(finding.id);
      }
    }

    const report = await this.writeVerifierReport({ sessionId, contract, stage, attempt, deterministicResults, messages, state });
    const artifactIdsWithReport = [...new Set([...artifactIds, report.id])];
    const artifactManifest = await createArtifactManifest(this.services, artifactIdsWithReport);
    const deterministicOk = deterministicResults.every((result) => result.ok);
    const hardGateFailed = deterministicResults.some((result) => !result.ok && result.hardGate);
    const reviewPolicy = gate.semantic;
    const existingStageFindings = (await this.services.reviewStore.listBySession(sessionId)).filter((finding) => finding.targetType === "stage" && finding.targetRef === stage.id && finding.status === "open" && ["stage_agent_failed", "stage_review_failed"].includes(finding.category));
    semanticFindings.push(...existingStageFindings);

    if (reviewPolicy?.mode === "always" || (reviewPolicy?.mode === "on_failure" && !deterministicOk)) {
      if (reviewPolicy.reviewerId) {
        const reviewer = this.services.reviewerRegistry.get(reviewPolicy.reviewerId);
        if (!reviewer) throw new RuntimeError("REVIEWER_NOT_FOUND", reviewPolicy.reviewerId);
        const review = await reviewer.review({ sessionId, artifactIds: artifactIdsWithReport, services: this.services });
        findingIds.push(...review.findingIds);
        semanticFindings.push(...(await this.services.reviewStore.listBySession(sessionId)).filter((finding) => review.findingIds.includes(finding.id)));
      } else if (reviewPolicy.agentId) {
        try {
          const review = await taskTool.execute(createInternalToolContext(this.services, sessionId, "stage-runner"), {
            agentId: reviewPolicy.agentId,
            description: `Review stage ${stage.id}`,
            input: `Review stage "${stage.id}" for semantic quality and blocking issues. Use the verifier_report artifact to avoid repeating deterministic checks and focus on semantic risks.\n\nArtifact manifest:\n${JSON.stringify(artifactManifest, null, 2)}\n\nDo not call artifact_read unless artifactId is copied exactly from this manifest.`,
            contextArtifactIds: artifactIdsWithReport
          });
          const childFindings = await this.services.reviewStore.listBySession(review.childSessionId);
          semanticFindings.push(...childFindings);
          findingIds.push(...childFindings.map((f) => f.id));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const finding = await this.services.reviewStore.create({
            sessionId,
            severity: "major",
            category: "stage_review_failed",
            targetType: "stage",
            targetRef: stage.id,
            description: `Stage review agent failed; continuing with deterministic gate only: ${message}`,
            suggestedAction: "Tighten reviewer prompt/tool arguments and rerun semantic review."
          });
          findingIds.push(finding.id);
          semanticFindings.push(finding);
          messages.push(finding.description);
          await this.services.eventBus.emit({ type: "stage.review_failed", sessionId, contractId: contract.id, stageId: stage.id, error: message });
        }
      }
    }

    const reviewBlocking = semanticFindings.some((finding) => finding.severity === "blocking" && finding.status === "open");
    const reviewMajor = semanticFindings.some((finding) => ["high", "major"].includes(finding.severity) && finding.status === "open");
    const action = decideGateAction({ stage, deterministicOk, hardGateFailed, reviewBlocking, reviewMajor, deterministicResults, semanticFindings });
    return { ...action, messages: [...messages, ...semanticFindings.map((finding) => finding.description)], findingIds, reportArtifactId: report.id };
  }

  private async writeVerifierReport(input: { sessionId: string; contract: StageContractDefinition; stage: StageSpec; attempt: number; deterministicResults: (StageVerifierResult & { verifierId: string; hardGate: boolean })[]; messages: string[]; state: Record<string, unknown> }): Promise<Artifact> {
    const content = {
      stage: "verifier_report",
      contractId: input.contract.id,
      stageId: input.stage.id,
      attempt: input.attempt,
      deterministicChecks: input.deterministicResults.map((result) => ({
        verifierId: result.verifierId,
        hardGate: result.hardGate,
        ok: result.ok,
        severity: result.severity,
        category: result.category,
        targetRef: result.targetRef,
        message: result.message
      })),
      messages: input.messages
    };
    const artifact = await this.services.artifactStore.create({ sessionId: input.sessionId, type: "json", mediaType: "application/json", content: JSON.stringify(content, null, 2), createdBy: { sessionId: input.sessionId, agentId: "stage-runner", toolId: "verifier" } });
    input.state[`stage.${input.stage.id}.verifierReportArtifactId`] = artifact.id;
    return artifact;
  }
}

function resolveStageTransition(stage: StageSpec, passed: boolean): string | undefined {
  const desired = passed ? "passed" : "failed";
  return stage.next?.find((t) => t.when === desired)?.stageId ?? stage.next?.find((t) => t.when === "always")?.stageId;
}

function effectiveGate(stage: StageSpec): StageGatePolicy {
  return {
    deterministic: stage.gate?.deterministic ?? stage.verifiers?.map((id) => ({ id, hardGate: false })) ?? [],
    semantic: stage.gate?.semantic ?? stage.review,
    rules: stage.gate?.rules ?? defaultGateRules(stage)
  };
}

function defaultGateRules(stage: StageSpec): StageGateDecisionRule[] {
  const retryAction = stage.retryPolicy?.onFailure === "continue" ? "continue" : stage.retryPolicy?.onFailure === "fail" ? "partial" : "retry_stage";
  return [
    { when: "hard_gate_failed", action: retryAction },
    { when: "review_blocking", action: retryAction },
    { when: "review_major", action: retryAction },
    { when: "verifier_failed", action: retryAction },
    { when: "passed", action: "next" }
  ];
}

function decideGateAction(input: { stage: StageSpec; deterministicOk: boolean; hardGateFailed: boolean; reviewBlocking: boolean; reviewMajor: boolean; deterministicResults: (StageVerifierResult & { verifierId: string; hardGate: boolean })[]; semanticFindings: ReviewFinding[] }): { action: StageGateDecisionRule["action"]; nextStageId?: string } {
  const gate = effectiveGate(input.stage);
  const signals = gateSignals(input);
  const rule = gate.rules?.find((candidate) => signals.some((signal) => gateRuleMatches(candidate.when, signal))) ?? { when: input.deterministicOk ? "passed" : "failed", action: input.deterministicOk ? "next" : "retry_stage" };
  return { action: rule.action, nextStageId: rule.stageId };
}

function gateSignals(input: { deterministicOk: boolean; hardGateFailed: boolean; reviewBlocking: boolean; reviewMajor: boolean; deterministicResults: (StageVerifierResult & { verifierId: string; hardGate: boolean })[]; semanticFindings: ReviewFinding[] }): string[] {
  const signals: string[] = [];
  if (input.deterministicOk && !input.reviewBlocking && !input.reviewMajor) signals.push("passed");
  if (!input.deterministicOk || input.reviewBlocking || input.reviewMajor) signals.push("failed");
  if (input.hardGateFailed) signals.push("hard_gate_failed");
  for (const result of input.deterministicResults.filter((result) => !result.ok)) {
    signals.push("verifier_failed");
    signals.push(`verifier_failed:${result.verifierId}`);
    if (result.category) signals.push(`verifier_failed:${result.category}`);
  }
  if (input.reviewBlocking) signals.push("review_blocking");
  if (input.reviewMajor) signals.push("review_major");
  for (const finding of input.semanticFindings.filter((finding) => finding.status === "open")) {
    signals.push(`review_${finding.severity}`);
    signals.push(`review_${finding.severity}:${finding.category}`);
    signals.push(finding.category);
  }
  return signals;
}

function gateRuleMatches(ruleWhen: string, signal: string): boolean {
  return ruleWhen === signal || (ruleWhen.endsWith(":*") && signal.startsWith(ruleWhen.slice(0, -1)));
}

function renderStageAgentPrompt(input: { contract: StageContractDefinition; stage: StageSpec; userGoal: string; attempt: number; feedback: string[]; artifactManifest: unknown }): string {
  const required = input.stage.requiredArtifacts?.length
    ? input.stage.requiredArtifacts.map((req) => `- ${JSON.stringify(req)}`).join("\n")
    : "- No required artifacts declared.";
  const gate = effectiveGate(input.stage);
  const verifiers = gate.deterministic?.length ? gate.deterministic.map((policy) => `- ${policy.id}${policy.hardGate ? " (hard gate)" : ""}`).join("\n") : "- No verifiers declared.";
  const allowedTools = input.stage.allowedTools?.length ? input.stage.allowedTools.join(", ") : "all registered tools";
  const feedback = input.feedback.length ? `\nPrevious verifier/review feedback to fix:\n${input.feedback.map((m) => `- ${m}`).join("\n")}\n` : "";
  return [
    `Run stage "${input.stage.id}" for contract "${input.contract.id}".`,
    `Goal: ${input.stage.goal}`,
    `User goal:\n${input.userGoal}`,
    `Attempt: ${input.attempt}`,
    `Allowed tools: ${allowedTools}`,
    `Required input roles: ${(input.stage.requiredInputs ?? []).join(", ") || "none declared"}`,
    `Required artifacts:\n${required}`,
    `Verifiers that will judge completion:\n${verifiers}`,
    `Artifact manifest:\n${JSON.stringify(input.artifactManifest, null, 2)}`,
    feedback,
    "Produce the required structured artifacts with artifact_write before finalizing. For JSON artifacts, call artifact_write with type=\"json\", mediaType=\"application/json\", and content equal to a JSON string that includes the declared stage field exactly. Example: artifact_write({\"type\":\"json\",\"mediaType\":\"application/json\",\"content\":\"{\\\"stage\\\":\\\"protocol\\\",\\\"question\\\":\\\"...\\\"}\"}). If reading an artifact, copy artifactId exactly from the manifest; never call artifact_read with an empty or invented artifactId."
  ].filter(Boolean).join("\n\n");
}

function validateToolInput(tool: ToolDefinition, input: unknown): void {
  const schema = tool.inputSchema ?? {};
  if ((schema as any).type !== "object") return;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new RuntimeError("TOOL_INPUT_INVALID", `${tool.id}: input must be an object`);
  const obj = input as Record<string, unknown>;
  for (const key of ((schema as any).required ?? [])) {
    const value = obj[key];
    if (value === undefined || value === null || value === "") throw new RuntimeError("TOOL_INPUT_INVALID", `${tool.id}.${key} is required`);
  }
  const props = ((schema as any).properties ?? {}) as Record<string, any>;
  for (const [key, prop] of Object.entries(props)) {
    if (!(key in obj) || obj[key] === undefined || obj[key] === null) continue;
    const value = obj[key];
    if (prop.type === "string" && typeof value !== "string") throw new RuntimeError("TOOL_INPUT_INVALID", `${tool.id}.${key} must be a string`);
    if (prop.type === "number" && typeof value !== "number") throw new RuntimeError("TOOL_INPUT_INVALID", `${tool.id}.${key} must be a number`);
    if (prop.type === "integer" && (!Number.isInteger(value))) throw new RuntimeError("TOOL_INPUT_INVALID", `${tool.id}.${key} must be an integer`);
    if (prop.type === "boolean" && typeof value !== "boolean") throw new RuntimeError("TOOL_INPUT_INVALID", `${tool.id}.${key} must be a boolean`);
    if (prop.type === "array" && !Array.isArray(value)) throw new RuntimeError("TOOL_INPUT_INVALID", `${tool.id}.${key} must be an array`);
    if (prop.minLength && typeof value === "string" && value.trim().length < Number(prop.minLength)) throw new RuntimeError("TOOL_INPUT_INVALID", `${tool.id}.${key} must not be empty`);
  }
}

async function createArtifactManifest(services: RuntimeServices, artifactIds: string[]): Promise<{ artifacts: { id: string; type: string; mediaType: string; stage?: string; role?: string; size: number; createdAt: string }[]; byStage: Record<string, string[]>; byRole: Record<string, string[]> }> {
  const artifacts = [];
  const byStage: Record<string, string[]> = {};
  const byRole: Record<string, string[]> = {};
  for (const id of [...new Set(artifactIds)]) {
    const artifact = await services.artifactStore.get(id);
    if (!artifact) continue;
    let stage: string | undefined;
    if (artifact.mediaType === "application/json") {
      try {
        const parsed = JSON.parse((await services.artifactStore.read(id)).toString("utf8"));
        if (typeof parsed?.stage === "string") stage = parsed.stage;
      } catch {
        // Ignore non-JSON content with a JSON media type.
      }
    }
    const role = stageToArtifactRole(stage) ?? artifact.type;
    artifacts.push({ id: artifact.id, type: artifact.type, mediaType: artifact.mediaType, stage, role, size: artifact.size, createdAt: artifact.createdAt });
    if (stage) byStage[stage] = [...(byStage[stage] ?? []), artifact.id];
    if (role) byRole[role] = [...(byRole[role] ?? []), artifact.id];
  }
  return { artifacts, byStage, byRole };
}

function stageToArtifactRole(stage?: string): string | undefined {
  const roles: Record<string, string> = {
    protocol: "protocol",
    queries: "query_plan",
    identification: "identification",
    citation_chaining: "citation_chaining",
    deduplication: "deduped_papers",
    screening_log: "screening_log",
    eligibility_log: "eligibility_log",
    quality_assessment: "quality_assessment",
    included_studies: "included_studies",
    evidence_table: "evidence_table",
    contradiction_detection: "contradiction_detection",
    citation_verification: "citation_verification",
    prisma_flow: "prisma_flow",
    verifier_report: "verifier_report",
    review_findings: "review_findings"
  };
  return stage ? roles[stage] : undefined;
}

async function countMatchingArtifacts(services: RuntimeServices, artifactIds: string[], req: ArtifactRequirement): Promise<number> {
  let count = 0;
  for (const id of artifactIds) {
    const artifact = await services.artifactStore.get(id);
    if (!artifact) continue;
    if (req.type && artifact.type !== req.type) continue;
    if (req.mediaType && artifact.mediaType !== req.mediaType) continue;
    if (req.stage) {
      try {
        const parsed = JSON.parse((await services.artifactStore.read(id)).toString("utf8"));
        if (parsed?.stage !== req.stage) continue;
      } catch {
        continue;
      }
    }
    count++;
  }
  return count;
}

export class AgentSessionRunner {
  constructor(private services: RuntimeServices) {}
  async runSession(input: { sessionId: string; mode: "primary" | "subagent"; contextArtifactIds?: string[]; retryContext?: string; revisionContext?: string }): Promise<RunnerResult> {
    const session = await this.requiredSession(input.sessionId);
    const agent = this.requiredAgent(session.agentId);
    await this.services.sessionStore.update(session.id, { status: "running" });
    const prior = await this.services.messageStore.listBySession(session.id);
    if (!prior.some((m) => m.role === "user")) {
      const ctxText = input.contextArtifactIds?.length ? `\n\nContext artifact ids: ${input.contextArtifactIds.join(", ")}` : "";
      await this.services.messageStore.append({ sessionId: session.id, role: "user", content: `${input.revisionContext ? `${session.input}\n\nRevision context:\n${input.revisionContext}` : session.input}${ctxText}` });
    }
    const maxTurns = agent.maxTurns ?? 8;
    const toolRuntime = new ToolRuntime(this.services);
    let output = "";
    let artifactIds = [...session.artifactIds];
    for (let turn = 0; turn < maxTurns; turn++) {
      const current = await this.requiredSession(session.id);
      const messages = await this.services.messageStore.listBySession(session.id);
      const tools = this.services.toolRegistry.listForAgent(agent);
      const modelMessages = await this.services.promptAssembler.assemble({ session: current, agent, messages, availableTools: tools });
      const model = current.model ?? agent.model ?? this.services.config.defaultModel;
      const response = await this.services.providerRouter.complete({ provider: model.provider, model: model.model, messages: modelMessages, tools: tools.map((t) => ({ id: t.id, description: t.description, inputSchema: t.inputSchema })), temperature: agent.temperature });
      await this.services.messageStore.append({ sessionId: session.id, role: "assistant", content: response.content, model, tokenUsage: response.usage });
      if (!response.toolCalls?.length) { output = response.content; break; }
      for (const call of response.toolCalls) {
        const result = await toolRuntime.execute({ sessionId: session.id, agentId: agent.id, toolId: call.toolId, input: call.input });
        await this.services.messageStore.append({ sessionId: session.id, role: "tool", content: summarizeToolOutput(result.output), toolCallId: result.toolCallId });
        artifactIds.push(...extractArtifactIds(result.output));
        if (call.toolId === "finalize") {
          const final = result.output as any;
          if (final.status === "blocked") continue;
          output = String(final.output ?? "");
          await this.services.sessionStore.update(session.id, { status: "completed", artifactIds: [...new Set(artifactIds)] });
          return { sessionId: session.id, status: "completed", output, artifactIds: [...new Set(artifactIds)], reviewFindingIds: [] };
        }
      }
    }
    await this.services.sessionStore.update(session.id, { status: "completed", artifactIds: [...new Set(artifactIds)] });
    return { sessionId: session.id, status: output ? "completed" : "partial", output, artifactIds: [...new Set(artifactIds)], reviewFindingIds: [] };
  }
  private async requiredSession(id: string): Promise<Session> {
    const s = await this.services.sessionStore.get(id);
    if (!s) throw new RuntimeError("SESSION_NOT_FOUND", id);
    return s;
  }
  private requiredAgent(id: string): AgentDefinition {
    const a = this.services.agentRegistry.get(id);
    if (!a) throw new RuntimeError("AGENT_NOT_FOUND", id);
    return a;
  }
}

function summarizeToolOutput(output: unknown): string {
  const text = JSON.stringify(output);
  return text.length > 2000 ? `${text.slice(0, 2000)}...` : text;
}

function extractArtifactIds(output: unknown): string[] {
  if (!output || typeof output !== "object") return [];
  const ids: string[] = [];
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if ("artifactId" in value && typeof (value as any).artifactId === "string") ids.push((value as any).artifactId);
    if ("artifactIds" in value && Array.isArray((value as any).artifactIds)) ids.push(...(value as any).artifactIds.filter((x: unknown) => typeof x === "string"));
  };
  walk(output);
  return ids;
}

export function createInternalToolContext(services: RuntimeServices, sessionId: string, agentId: string): ToolContext {
  const toolCallId = createId("call");
  return {
    runtime: services, sessionId, agentId, toolCallId,
    emit: (event) => services.eventBus.emit(event),
    createArtifact: (artifactInput) => services.artifactStore.create({ ...artifactInput, sessionId, createdBy: { sessionId, agentId, toolId: "internal" } }),
    recordProvenance: (prov) => services.provenanceStore.record(prov)
  };
}

export function createWorkflowContext(services: RuntimeServices, sessionId: string): WorkflowContext {
  return {
    sessionId, services,
    task: (input) => taskTool.execute(createInternalToolContext(services, sessionId, "workflow"), input),
    createArtifact: (artifactInput) => services.artifactStore.create({ ...artifactInput, sessionId, createdBy: { sessionId, agentId: "workflow", toolId: "workflow" } }),
    recordProvenance: (prov) => services.provenanceStore.record(prov)
  };
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

export class MockProvider implements ModelProvider {
  id = "mock";
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const sys = request.messages.find((m) => m.role === "system")?.content ?? "";
    const last = [...request.messages].reverse().find((m) => m.role === "user" || m.role === "tool")?.content ?? "";
    if (sys.includes("strategy selection")) {
      const lower = last.toLowerCase();
      const strategy = lower.includes("review") || lower.includes("improve") ? "critic_revise" : "direct";
      return { content: JSON.stringify({ strategy, reason: "Mock deterministic strategy.", confidence: 1, config: { maxRetries: 1, maxReviewRounds: 1 } }) };
    }
    if (last.includes('"status":"finalized"') || last.includes('"status":"blocked"')) return { content: "Done." };
    if (sys.includes("Agent id: reviewer")) {
      return { content: "No blocking findings.", toolCalls: [{ toolId: "finalize", input: { finalText: "Review complete: no blocking findings." } }] };
    }
    if (last.includes("ask a reviewer") || last.includes("critique")) {
      return { content: "Delegating review.", toolCalls: [{ toolId: "task", input: { agentId: "reviewer", description: "Critique answer", input: "Critique this answer." } }] };
    }
    return { content: "Finalizing mock response.", toolCalls: [{ toolId: "finalize", input: { finalText: `Mock response for ${request.model}: ${last.slice(0, 400)}` } }] };
  }
}

export class OpenAICompatibleProvider implements ModelProvider {
  constructor(readonly id = "openai", private config: { baseUrl?: string; apiKeyEnv?: string; apiKey?: string } = {}) {}
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const apiKey = process.env[this.config.apiKeyEnv ?? "OPENAI_API_KEY"] ?? this.config.apiKey;
    if (!apiKey) throw new RuntimeError("OPENAI_API_KEY_MISSING", this.config.apiKeyEnv ?? "OPENAI_API_KEY");
    const baseUrl = (this.config.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const body: any = { model: normalizeVolcengineModel(request.model, baseUrl), messages: request.messages.map((m) => ({ role: m.role === "tool" ? "user" : m.role, content: m.content })), temperature: request.temperature ?? 0, max_tokens: request.maxTokens ?? 4096 };
    if (request.tools?.length) body.tools = (request.tools as any[]).map((t) => ({ type: "function", function: { name: t.id, description: t.description, parameters: t.inputSchema ?? { type: "object" } } }));
    const res = await fetch(`${baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body) });
    if (!res.ok) throw new RuntimeError("OPENAI_COMPATIBLE_ERROR", `${res.status} ${await res.text()}`);
    const json = await res.json() as any;
    const msg = json.choices?.[0]?.message ?? {};
    const toolCalls = (msg.tool_calls ?? []).map((c: any) => ({ id: c.id, toolId: c.function?.name, input: parseJson(c.function?.arguments, {}) }));
    return { content: msg.content ?? "", toolCalls, usage: json.usage ? { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens, totalTokens: json.usage.total_tokens } : undefined };
  }
}

function readArkHelperApiKey(): string | undefined {
  const file = "/root/.ark-helper/config.yaml";
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, "utf8");
  const match = text.match(/^\s*api_key\s*:\s*(.+?)\s*$/m);
  return match?.[1]?.trim().replace(/^["']|["']$/g, "");
}

function normalizeVolcengineModel(model: string, baseUrl: string): string {
  if (baseUrl.includes("/api/coding/") || baseUrl.includes("/api/plan/")) return model;
  const aliases: Record<string, string> = {
    "glm-5.2": "glm-5-2-260617",
    "glm5.2": "glm-5-2-260617",
    "glm-5-2": "glm-5-2-260617"
  };
  return aliases[model] ?? model;
}
