import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RuntimeError } from "./errors.js";
import { createId } from "./ids.js";
import { j, parseJson } from "./json.js";
import type {
  Artifact,
  CreateArtifactInput,
  ExecutionDecision,
  Message,
  MessageRole,
  ModelRef,
  RecordProvenanceInput,
  ReviewFinding,
  Session
} from "./types.js";

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
  async resolve(ids: string[]): Promise<void> {
    for (const id of ids) this.db.run("update review_findings set status='resolved' where id=?", [id]);
  }
}

function mapFinding(r: any): ReviewFinding {
  return { id: r.id, sessionId: r.session_id, severity: r.severity, category: r.category, targetType: r.target_type, targetRef: r.target_ref, description: r.description, suggestedAction: r.suggested_action ?? undefined, status: r.status, createdAt: r.created_at };
}
