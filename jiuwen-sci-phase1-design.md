# jiuwen-sci 第一阶段设计方案：通用 Agent Runtime MVP

> 本文档用于指导第一阶段实现。第一阶段目标是构建一个与具体科研领域解耦的 Agent Runtime。文献调研只是第一条验证链路，不应污染 Core Runtime 的领域边界。

> 重要调整：第一阶段不实现 Loop Engineering、多路径探索、Branch / Attempt / LoopRuntime。设计上只保留扩展点，未来可以通过新增 Runner、Evaluator、Workflow Policy 接入 Loop Engineering，但初版不进入实现范围。

---

## 0. 命名与 CLI 风格约定

### 0.1 系统名称

系统统一命名为：

```text
jiuwen-sci
```

CLI 主命令统一为：

```bash
jiuwen-sci
```

文档、测试、配置目录、日志目录、Artifact 目录必须全部使用 `jiuwen-sci` 或 `.jiuwen-sci`。

---

### 0.2 CLI 风格基准

CLI 风格应尽量接近 Claude Code、Codex CLI 等终端 Agent 的事实标准。

第一阶段采用：

1. 裸命令进入交互模式：

```bash
jiuwen-sci
```

2. `exec` 用于一次性非交互任务：

```bash
jiuwen-sci exec "Survey recent papers on AI agents for scientific discovery"
```

3. `resume` 用于恢复已有 Session：

```bash
jiuwen-sci resume ses_abc123
```

4. `doctor` 用于诊断本地环境：

```bash
jiuwen-sci doctor
```

5. 支持全局参数：

```bash
jiuwen-sci --model anthropic:claude-sonnet-4 exec "run a literature review"
jiuwen-sci exec "run a literature review" --model anthropic:claude-sonnet-4
```

6. 交互模式支持 slash commands：

```text
/init
/status
/model
/agent
/strategy
/permissions
/tasks
/artifacts
/provenance
/review
/compact
/exit
```

---

### 0.3 推荐命令分层

#### 高频 Agent 命令

```bash
jiuwen-sci
jiuwen-sci exec "<prompt>"
jiuwen-sci resume <session-id>
jiuwen-sci doctor
```

#### Runtime 检查命令

```bash
jiuwen-sci session list
jiuwen-sci session show <session-id>
jiuwen-sci session tree <session-id>

jiuwen-sci artifact list --session <session-id>
jiuwen-sci artifact cat <artifact-id-or-name>

jiuwen-sci provenance trace <artifact-id>
jiuwen-sci review list --session <session-id>
```

#### 能力包命令

```bash
jiuwen-sci pack list
jiuwen-sci pack enable literature
jiuwen-sci literature review "<question>"
```

`literature review` 是 CLI shortcut，不是独立 Runtime。底层必须走相同的 `RuntimeHost.run()` 和 `WorkflowRunner`。

---

### 0.4 全局参数规范

第一阶段必须支持：

```bash
-C, --cd <path>                 设置工作目录
-m, --model <provider:model>    指定模型
-c, --config <key=value>        覆盖配置
-a, --approval <mode>           审批模式：on-request | never | always
--sandbox <mode>                沙箱模式：none | readonly | workspace-write
--strategy <strategy>           direct | retry | critic_revise | workflow_controlled | auto
--json                          输出 JSON 或 JSONL
--verbose                       输出详细事件
--quiet                         只输出最终结果
```

第一阶段暂不实现强沙箱，但 CLI 参数和配置字段必须预留。

第一阶段不支持：

```bash
--max-branches
--branch-explore
--loop
--best-of-n
```

这些属于后续 Loop Engineering 扩展，不进入初版命令。

---

## 1. 关键目标

### 1.1 第一阶段核心目标

第一阶段目标：

```text
构建 jiuwen-sci Core Runtime
  +
用 literature-pack 验证主 Agent、子 Agent、工具、Artifact、Provenance、Review 的完整链路
```

完整链路：

```text
User Goal
  ↓
Primary Agent
  ↓
Strategy Selection
  ↓
Runtime Guard
  ↓
Execution Runner
  ↓
Tool / Subagent / Workflow
  ↓
Artifact
  ↓
Provenance
  ↓
Reviewer
  ↓
Final Output
```

---

### 1.2 必须完成的 Runtime 能力

1. CLI-first。
2. Local-first。
3. Session-centered。
4. Agent Registry。
5. Primary Agent / Subagent / System Agent。
6. Tool Registry。
7. Task Tool 创建 Child Session。
8. Provider Router。
9. Strategy Selection。
10. Runtime Guard。
11. Runner：`direct`、`retry`、`critic_revise`、`workflow_controlled`。
12. Artifact Store。
13. Provenance Lite。
14. Reviewer / Review Finding。
15. Capability Pack。
16. Literature Pack 端到端验证。

---

### 1.3 明确不做

第一阶段不做：

1. Web UI。
2. 多用户。
3. 云端 SaaS。
4. 强隔离 sandbox。
5. Notebook / Python Kernel。
6. SSH / SLURM / GPU Compute。
7. 完整插件市场。
8. 长期 Memory。
9. 生产级 PRISMA。
10. 分布式任务队列。
11. Loop Engineering。
12. 多路径探索。
13. Branch / Attempt / LoopRuntime。
14. MCTS / Evolutionary Search。
15. Graph DB。

---

### 1.4 Loop Engineering 的处理原则

第一阶段不实现 Loop Engineering，但需要保留扩展性。

保留方式：

1. `ExecutionRunner` 采用注册式架构，未来可新增 `branch_explore`、`best_of_n`、`tree_search` Runner。
2. `StrategyRecord` 可记录策略选择与 Guard 结果，未来可扩展更多策略字段。
3. `Provenance` 保持通用节点与边，不把图结构写死为线性流程。
4. `WorkflowDefinition` 支持领域 Workflow 接管阶段推进，未来可以扩展为探索式 Workflow。
5. `EvaluatorDefinition` 可以在第一阶段用于 Review，未来可用于 Attempt 评分。

不保留方式：

1. 初版不定义 `Goal`、`Branch`、`Attempt`、`LoopPolicy`。
2. 初版不创建 `loop_runs`、`branches`、`attempts`、`evaluations` 表。
3. 初版不提供 `jiuwen-sci loop` 命令。
4. 初版不暴露 `--max-branches`、`--max-iterations` 等参数。
5. 初版主控 Agent 不允许选择 `branch_explore`。

---

## 2. 总体方案设计

### 2.1 架构图

```text
┌──────────────────────────────────────────────┐
│ CLI                                          │
│ interactive / exec / resume / doctor         │
├──────────────────────────────────────────────┤
│ Runtime Host                                 │
│ config / lifecycle / event stream            │
├──────────────────────────────────────────────┤
│ Agent Runtime                                │
│ Session Loop / Prompt Assembly / Tool Loop   │
├──────────────────────────────────────────────┤
│ Execution Strategy Layer                     │
│ Strategy Selection / Guard / Runner          │
├──────────────────────────────────────────────┤
│ Governance Layer                             │
│ Permission / Artifact / Provenance / Review  │
├──────────────────────────────────────────────┤
│ Capability Packs                             │
│ literature / future biology / physics / ml   │
├──────────────────────────────────────────────┤
│ Storage & Providers                          │
│ SQLite / Filesystem / LLM Providers          │
└──────────────────────────────────────────────┘
```

---

### 2.2 目录结构

参考实现必须从该目录结构开始，不允许把领域逻辑写入 `packages/core`。

```text
jiuwen-sci/
├── apps/
│   └── cli/
│       ├── src/
│       │   ├── index.ts
│       │   ├── command.ts
│       │   ├── interactive.ts
│       │   ├── commands/
│       │   │   ├── exec.ts
│       │   │   ├── resume.ts
│       │   │   ├── doctor.ts
│       │   │   ├── session.ts
│       │   │   ├── artifact.ts
│       │   │   ├── provenance.ts
│       │   │   ├── review.ts
│       │   │   ├── pack.ts
│       │   │   └── literature.ts
│       │   └── format/
│       │       ├── events.ts
│       │       ├── tree.ts
│       │       └── table.ts
│       └── package.json
│
├── packages/
│   ├── core/
│   │   ├── runtime/
│   │   ├── session/
│   │   ├── message/
│   │   ├── agent/
│   │   ├── prompt/
│   │   ├── provider/
│   │   ├── tool/
│   │   ├── task/
│   │   ├── strategy/
│   │   ├── runner/
│   │   ├── event/
│   │   ├── permission/
│   │   ├── artifact/
│   │   ├── provenance/
│   │   └── review/
│   │
│   ├── storage/
│   │   ├── sqlite/
│   │   └── filesystem/
│   │
│   ├── shared/
│   │   ├── ids/
│   │   ├── schema/
│   │   ├── errors/
│   │   └── logger/
│   │
│   ├── providers/
│   │   ├── mock/
│   │   ├── openai-compatible/
│   │   ├── anthropic/
│   │   └── gemini/
│   │
│   └── packs/
│       └── literature/
│           ├── index.ts
│           ├── agents/
│           ├── tools/
│           ├── connectors/
│           ├── evaluators/
│           ├── workflows/
│           ├── schemas/
│           └── prompts/
│
├── .jiuwen-sci/
│   ├── config.toml
│   ├── runtime.db
│   ├── artifacts/
│   ├── logs/
│   └── cache/
│
├── package.json
└── README.md
```

---

### 2.3 Core 与 Pack 的硬边界

Core Runtime 只能出现以下概念：

```text
Runtime
Session
Message
Agent
Tool
Task
Provider
Strategy
Runner
Artifact
Provenance
Reviewer
Permission
Event
```

Core Runtime 禁止出现：

```text
Paper
DOI
PubMed
arXiv
Crossref
Citation
Abstract
Screening
Evidence
PRISMA
```

这些必须放在 `packages/packs/literature`。

---

## 3. 关键接口与参考实现

以下参考实现用于约束开发方式。开发者可以调整细节，但不应改变职责边界和调用方向。

---

## 3.1 RuntimeHost

### 3.1.1 接口

```ts
export interface RuntimeHost {
  start(): Promise<void>;
  stop(): Promise<void>;

  run(input: RuntimeRunInput): Promise<RuntimeRunResult>;
  resume(sessionId: string): Promise<RuntimeRunResult>;

  registerAgent(agent: AgentDefinition): void;
  registerTool(tool: ToolDefinition): void;
  registerReviewer(reviewer: ReviewerDefinition): void;
  registerPack(pack: CapabilityPack): void;
}
```

```ts
export interface RuntimeRunInput {
  input: string;
  agentId?: string;
  strategy?: ExecutionStrategy | "auto";
  model?: ModelRef;
  cwd?: string;
  packIds?: string[];
  metadata?: Record<string, unknown>;
}
```

```ts
export interface RuntimeRunResult {
  sessionId: string;
  status: "completed" | "failed" | "partial";
  output: string;
  artifactIds: string[];
  reviewFindingIds: string[];
}
```

---

### 3.1.2 参考实现

文件：`packages/core/runtime/runtime-host.ts`

```ts
export class DefaultRuntimeHost implements RuntimeHost {
  constructor(
    private readonly services: RuntimeServices,
    private readonly executionEngine: ExecutionEngine,
  ) {}

  async start(): Promise<void> {
    await this.services.storage.connect();
    await this.services.eventBus.emit({ type: "runtime.started" });
  }

  async stop(): Promise<void> {
    await this.services.eventBus.emit({ type: "runtime.stopped" });
    await this.services.storage.close();
  }

  registerAgent(agent: AgentDefinition): void {
    this.services.agentRegistry.register(agent);
  }

  registerTool(tool: ToolDefinition): void {
    this.services.toolRegistry.register(tool);
  }

  registerReviewer(reviewer: ReviewerDefinition): void {
    this.services.reviewerRegistry.register(reviewer);
  }

  registerPack(pack: CapabilityPack): void {
    for (const agent of pack.agents ?? []) this.registerAgent(agent);
    for (const tool of pack.tools ?? []) this.registerTool(tool);
    for (const reviewer of pack.reviewers ?? []) this.registerReviewer(reviewer);

    this.services.packRegistry.register(pack);
  }

  async run(input: RuntimeRunInput): Promise<RuntimeRunResult> {
    const agentId = input.agentId ?? "research-orchestrator";

    const session = await this.services.sessionStore.create({
      agentId,
      input: input.input,
      cwd: input.cwd ?? process.cwd(),
      model: input.model,
      metadata: input.metadata ?? {},
    });

    await this.services.eventBus.emit({
      type: "session.created",
      sessionId: session.id,
    });

    return this.executionEngine.run({
      sessionId: session.id,
      input: input.input,
      requestedStrategy: input.strategy ?? "auto",
    });
  }

  async resume(sessionId: string): Promise<RuntimeRunResult> {
    const session = await this.services.sessionStore.get(sessionId);
    if (!session) {
      throw new RuntimeError("SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
    }

    return this.executionEngine.resume({ sessionId });
  }
}
```

---

### 3.1.3 实现约束

必须遵守：

1. `RuntimeHost` 只做生命周期和注册，不直接执行模型调用。
2. `RuntimeHost.run()` 必须创建主 Session。
3. 所有执行必须进入 `ExecutionEngine`。
4. 不允许 CLI 直接调用 Agent、Tool 或 Provider。

禁止：

```ts
// 禁止：CLI 直接调用 provider
await provider.complete(...);

// 禁止：CLI 直接调用 literature tool
await scienceSearch.execute(...);
```

---

## 3.2 RuntimeServices

### 3.2.1 接口

```ts
export interface RuntimeServices {
  config: RuntimeConfig;

  storage: StorageConnection;

  sessionStore: SessionStore;
  messageStore: MessageStore;
  toolCallStore: ToolCallStore;
  artifactStore: ArtifactStore;
  provenanceStore: ProvenanceStore;
  reviewStore: ReviewStore;

  agentRegistry: AgentRegistry;
  toolRegistry: ToolRegistry;
  reviewerRegistry: ReviewerRegistry;
  packRegistry: PackRegistry;

  providerRouter: ProviderRouter;
  promptAssembler: PromptAssembler;
  permissionService: PermissionService;
  eventBus: EventBus;
}
```

---

### 3.2.2 参考实现

文件：`packages/core/runtime/create-runtime-services.ts`

```ts
export async function createRuntimeServices(
  config: RuntimeConfig,
): Promise<RuntimeServices> {
  const storage = new SqliteStorageConnection(config.paths.database);

  const eventBus = new DefaultEventBus();

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
    packRegistry: new InMemoryPackRegistry(),

    providerRouter: new DefaultProviderRouter(),
    promptAssembler: new DefaultPromptAssembler(),
    permissionService: new DefaultPermissionService(config.permissions),
    eventBus,
  };

  services.providerRouter.register(new MockProvider());
  services.providerRouter.register(new OpenAICompatibleProvider(config.providers.openaiCompatible));
  services.providerRouter.register(new AnthropicProvider(config.providers.anthropic));

  registerCoreAgents(services.agentRegistry);
  registerCoreTools(services.toolRegistry);
  registerCoreReviewers(services.reviewerRegistry);

  return services;
}
```

---

### 3.2.3 实现约束

1. 所有 Registry 初期可以使用内存实现。
2. 所有运行态记录必须进入 SQLite。
3. Artifact 内容必须写文件系统，不允许塞进 SQLite。
4. `createRuntimeServices()` 是唯一组装服务依赖的地方。
5. 第一阶段没有 `LoopStore`，不能引入 Loop 相关服务。

---

## 3.3 Session

### 3.3.1 接口

```ts
export interface Session {
  id: string;
  parentId?: string;

  title: string;
  agentId: string;
  status: SessionStatus;

  input: string;
  cwd: string;

  model?: ModelRef;
  permissions: PermissionRule[];

  strategyRecordId?: string;

  artifactIds: string[];
  provenanceGraphId?: string;

  metadata: Record<string, unknown>;

  createdAt: string;
  updatedAt: string;
}
```

```ts
export type SessionStatus =
  | "created"
  | "running"
  | "waiting_tool"
  | "waiting_permission"
  | "reviewing"
  | "completed"
  | "failed"
  | "cancelled";
```

---

### 3.3.2 Store 接口

```ts
export interface SessionStore {
  create(input: CreateSessionInput): Promise<Session>;
  get(id: string): Promise<Session | null>;
  update(id: string, patch: Partial<Session>): Promise<Session>;
  list(input?: ListSessionsInput): Promise<Session[]>;
  children(parentId: string): Promise<Session[]>;
}
```

---

### 3.3.3 参考实现

文件：`packages/storage/sqlite/session-store.ts`

```ts
export class SqliteSessionStore implements SessionStore {
  constructor(private readonly db: SqliteStorageConnection) {}

  async create(input: CreateSessionInput): Promise<Session> {
    const now = new Date().toISOString();

    const session: Session = {
      id: createId("ses"),
      parentId: input.parentId,
      title: input.title ?? input.input.slice(0, 80),
      agentId: input.agentId,
      status: "created",
      input: input.input,
      cwd: input.cwd,
      model: input.model,
      permissions: input.permissions ?? [],
      artifactIds: [],
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };

    await this.db.run(
      `insert into sessions
       (id, parent_id, agent_id, title, status, input, cwd, model_json,
        permissions_json, strategy_record_id, artifact_ids_json,
        metadata_json, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        session.id,
        session.parentId ?? null,
        session.agentId,
        session.title,
        session.status,
        session.input,
        session.cwd,
        JSON.stringify(session.model ?? null),
        JSON.stringify(session.permissions),
        session.strategyRecordId ?? null,
        JSON.stringify(session.artifactIds),
        JSON.stringify(session.metadata),
        session.createdAt,
        session.updatedAt,
      ],
    );

    return session;
  }

  async get(id: string): Promise<Session | null> {
    const row = await this.db.get(`select * from sessions where id = ?`, [id]);
    return row ? mapSessionRow(row) : null;
  }

  async update(id: string, patch: Partial<Session>): Promise<Session> {
    const current = await this.get(id);
    if (!current) throw new RuntimeError("SESSION_NOT_FOUND", id);

    const next = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };

    await this.db.run(
      `update sessions set
        title = ?,
        status = ?,
        strategy_record_id = ?,
        artifact_ids_json = ?,
        metadata_json = ?,
        updated_at = ?
       where id = ?`,
      [
        next.title,
        next.status,
        next.strategyRecordId ?? null,
        JSON.stringify(next.artifactIds),
        JSON.stringify(next.metadata),
        next.updatedAt,
        id,
      ],
    );

    return next;
  }

  async children(parentId: string): Promise<Session[]> {
    const rows = await this.db.all(
      `select * from sessions where parent_id = ? order by created_at asc`,
      [parentId],
    );
    return rows.map(mapSessionRow);
  }

  async list(input: ListSessionsInput = {}): Promise<Session[]> {
    const limit = input.limit ?? 50;
    const rows = await this.db.all(
      `select * from sessions order by created_at desc limit ?`,
      [limit],
    );
    return rows.map(mapSessionRow);
  }
}
```

---

### 3.3.4 实现约束

1. 每个 Agent 执行必须绑定一个 Session。
2. 每个 Subagent 必须创建 Child Session。
3. 不能让多个 Agent 在同一个 Session 中混写执行过程。
4. Parent Session 只接收 Child Session 的摘要和 Artifact 引用。
5. 初版 Session 不包含 `loopRunId`、`branchId`、`attemptId`。

---

## 3.4 Message

### 3.4.1 接口

```ts
export interface Message {
  id: string;
  sessionId: string;

  role: "system" | "user" | "assistant" | "tool";
  content: string;

  toolCallId?: string;
  artifactIds?: string[];

  model?: ModelRef;
  tokenUsage?: TokenUsage;

  createdAt: string;
}
```

---

### 3.4.2 参考实现

文件：`packages/storage/sqlite/message-store.ts`

```ts
export class SqliteMessageStore implements MessageStore {
  constructor(private readonly db: SqliteStorageConnection) {}

  async append(input: AppendMessageInput): Promise<Message> {
    const msg: Message = {
      id: createId("msg"),
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      toolCallId: input.toolCallId,
      artifactIds: input.artifactIds ?? [],
      model: input.model,
      tokenUsage: input.tokenUsage,
      createdAt: new Date().toISOString(),
    };

    await this.db.run(
      `insert into messages
       (id, session_id, role, content, tool_call_id, artifact_ids_json,
        model_json, token_usage_json, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        msg.id,
        msg.sessionId,
        msg.role,
        msg.content,
        msg.toolCallId ?? null,
        JSON.stringify(msg.artifactIds),
        JSON.stringify(msg.model ?? null),
        JSON.stringify(msg.tokenUsage ?? null),
        msg.createdAt,
      ],
    );

    return msg;
  }

  async listBySession(sessionId: string): Promise<Message[]> {
    const rows = await this.db.all(
      `select * from messages where session_id = ? order by created_at asc`,
      [sessionId],
    );
    return rows.map(mapMessageRow);
  }
}
```

---

### 3.4.3 实现约束

1. 模型可见上下文必须来自 MessageStore 和 Artifact 摘要。
2. 大型 JSON / Markdown / PDF 不允许直接塞进 message。
3. Tool 结果如果较大，必须写 Artifact，只在 Message 中放摘要和 artifact id。

---

## 3.5 Agent Registry

### 3.5.1 接口

```ts
export interface AgentDefinition {
  id: string;
  name: string;
  description: string;

  mode: "primary" | "subagent" | "all" | "system";

  prompt: string;
  model?: ModelRef;

  permissions: PermissionRule[];
  allowedTools?: string[];

  maxTurns?: number;
  temperature?: number;

  supportsStrategySelection?: boolean;

  metadata?: Record<string, unknown>;
}
```

```ts
export interface AgentRegistry {
  register(agent: AgentDefinition): void;
  get(id: string): AgentDefinition | null;
  list(filter?: AgentListFilter): AgentDefinition[];
  canRunAs(agentId: string, mode: "primary" | "subagent" | "system"): boolean;
}
```

---

### 3.5.2 参考实现

文件：`packages/core/agent/agent-registry.ts`

```ts
export class InMemoryAgentRegistry implements AgentRegistry {
  private readonly agents = new Map<string, AgentDefinition>();

  register(agent: AgentDefinition): void {
    if (this.agents.has(agent.id)) {
      throw new RuntimeError("AGENT_DUPLICATE", `Duplicate agent: ${agent.id}`);
    }
    validateAgentDefinition(agent);
    this.agents.set(agent.id, agent);
  }

  get(id: string): AgentDefinition | null {
    return this.agents.get(id) ?? null;
  }

  list(filter: AgentListFilter = {}): AgentDefinition[] {
    return [...this.agents.values()].filter((agent) => {
      if (filter.mode && agent.mode !== filter.mode && agent.mode !== "all") {
        return false;
      }
      return true;
    });
  }

  canRunAs(agentId: string, mode: "primary" | "subagent" | "system"): boolean {
    const agent = this.get(agentId);
    if (!agent) return false;

    if (agent.mode === "all") return mode !== "system";
    return agent.mode === mode;
  }
}
```

---

### 3.5.3 核心 Agent 参考实现

文件：`packages/core/agent/core-agents.ts`

```ts
export function registerCoreAgents(registry: AgentRegistry): void {
  registry.register({
    id: "research-orchestrator",
    name: "Research Orchestrator",
    description: "General-purpose controller for research tasks.",
    mode: "primary",
    supportsStrategySelection: true,
    prompt: researchOrchestratorPrompt,
    permissions: [],
    allowedTools: ["task", "artifact_read", "artifact_write", "finalize"],
    maxTurns: 24,
  });

  registry.register({
    id: "task-agent",
    name: "Task Agent",
    description: "General-purpose subagent for bounded delegated tasks.",
    mode: "subagent",
    prompt: taskAgentPrompt,
    permissions: [],
    allowedTools: ["artifact_read", "artifact_write", "finalize"],
    maxTurns: 12,
  });

  registry.register({
    id: "reviewer",
    name: "Reviewer",
    description: "Read-only reviewer for checking claims, evidence, and internal consistency.",
    mode: "subagent",
    prompt: reviewerPrompt,
    permissions: [{ effect: "deny", resource: "tool:artifact_write" }],
    allowedTools: ["artifact_read", "provenance_query", "review_finding_write", "finalize"],
    maxTurns: 12,
  });
}
```

---

### 3.5.4 实现约束

1. Agent 只是配置，不应包含业务执行代码。
2. Agent 不能直接 import tool 实现。
3. 领域 Agent 必须由 Capability Pack 注册。
4. `mode = primary` 的 Agent 不允许被 Task Tool 调为 Subagent。
5. `system` Agent 不允许出现在普通 `agent list`，除非带 `--all`。

---

## 3.6 PromptAssembler

### 3.6.1 接口

```ts
export interface PromptAssembler {
  assemble(input: PromptAssemblyInput): Promise<ModelMessage[]>;
}
```

```ts
export interface PromptAssemblyInput {
  session: Session;
  agent: AgentDefinition;
  messages: Message[];
  availableTools: ToolDefinition[];
  contextArtifacts?: Artifact[];
  strategyRecord?: StrategyRecord;
}
```

---

### 3.6.2 参考实现

文件：`packages/core/prompt/prompt-assembler.ts`

```ts
export class DefaultPromptAssembler implements PromptAssembler {
  async assemble(input: PromptAssemblyInput): Promise<ModelMessage[]> {
    const system = [
      input.agent.prompt,
      this.renderRuntimeRules(),
      this.renderToolRules(input.availableTools),
      this.renderArtifactRules(input.contextArtifacts ?? []),
      this.renderStrategyContext(input.strategyRecord),
    ]
      .filter(Boolean)
      .join("\n\n---\n\n");

    const messages: ModelMessage[] = [
      { role: "system", content: system },
      ...input.messages.map((m) => ({
        role: m.role === "tool" ? "tool" : m.role,
        content: m.content,
      })),
    ];

    return messages;
  }

  private renderRuntimeRules(): string {
    return [
      "You are running inside jiuwen-sci Agent Runtime.",
      "Use tools when needed.",
      "Do not claim that an artifact exists unless it has been created.",
      "For delegated work, call the task tool instead of simulating another agent.",
      "For final answers, use finalize.",
    ].join("\n");
  }

  private renderToolRules(tools: ToolDefinition[]): string {
    const names = tools.map((t) => `- ${t.id}: ${t.description}`).join("\n");
    return `Available tools:\n${names}`;
  }

  private renderArtifactRules(artifacts: Artifact[]): string {
    if (artifacts.length === 0) return "";
    return [
      "Context artifacts:",
      ...artifacts.map((a) => `- ${a.id} ${a.type} ${a.path}`),
    ].join("\n");
  }

  private renderStrategyContext(strategy?: StrategyRecord): string {
    if (!strategy) return "";
    return `Execution strategy: ${strategy.finalStrategy}`;
  }
}
```

---

### 3.6.3 实现约束

1. Prompt 组装必须集中在 `PromptAssembler`。
2. Runner、Tool、CLI 都不允许拼大段模型 Prompt。
3. 领域 Prompt 来自 Pack，但最终由 Core PromptAssembler 组装。
4. Prompt 中必须明确 Artifact 和 Tool 的使用约束。

---

## 3.7 ProviderRouter

### 3.7.1 接口

```ts
export interface ProviderRouter {
  register(provider: ModelProvider): void;
  complete(request: ModelRequest): Promise<ModelResponse>;
}
```

```ts
export interface ModelProvider {
  id: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}
```

```ts
export interface ModelRequest {
  provider: string;
  model: string;
  messages: ModelMessage[];
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  metadata?: Record<string, unknown>;
}
```

---

### 3.7.2 参考实现

文件：`packages/core/provider/provider-router.ts`

```ts
export class DefaultProviderRouter implements ProviderRouter {
  private readonly providers = new Map<string, ModelProvider>();

  register(provider: ModelProvider): void {
    if (this.providers.has(provider.id)) {
      throw new RuntimeError("PROVIDER_DUPLICATE", provider.id);
    }
    this.providers.set(provider.id, provider);
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const provider = this.providers.get(request.provider);
    if (!provider) {
      throw new RuntimeError("PROVIDER_NOT_FOUND", request.provider);
    }

    return provider.complete(request);
  }
}
```

---

### 3.7.3 MockProvider 参考实现

文件：`packages/providers/mock/mock-provider.ts`

```ts
export class MockProvider implements ModelProvider {
  id = "mock";

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const last = request.messages.at(-1)?.content ?? "";

    if (last.includes("strategy selection")) {
      return {
        content: JSON.stringify({
          strategy: "direct",
          reason: "Mock provider chooses direct execution.",
          confidence: 1,
        }),
      };
    }

    return {
      content: `Mock response for model ${request.model}`,
      usage: {
        inputTokens: 10,
        outputTokens: 10,
        totalTokens: 20,
      },
    };
  }
}
```

---

### 3.7.4 实现约束

1. 第一阶段必须有 MockProvider。
2. 所有测试必须能在 MockProvider 下跑通。
3. Provider 不允许知道 Session、Artifact、Tool 等 Runtime 细节。
4. Provider 只处理模型协议转换。

---

## 3.8 Tool Runtime

### 3.8.1 接口

```ts
export interface ToolDefinition<I = unknown, O = unknown> {
  id: string;
  name: string;
  description: string;

  inputSchema: JsonSchema;
  outputSchema: JsonSchema;

  permission: ToolPermissionRequirement;

  execute(ctx: ToolContext, input: I): Promise<O>;
}
```

```ts
export interface ToolContext {
  runtime: RuntimeServices;
  sessionId: string;
  agentId: string;
  toolCallId: string;

  emit(event: RuntimeEvent): Promise<void>;
  createArtifact(input: CreateArtifactInput): Promise<Artifact>;
  recordProvenance(input: RecordProvenanceInput): Promise<void>;
}
```

---

### 3.8.2 ToolRegistry 参考实现

文件：`packages/core/tool/tool-registry.ts`

```ts
export class InMemoryToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.id)) {
      throw new RuntimeError("TOOL_DUPLICATE", tool.id);
    }
    validateToolDefinition(tool);
    this.tools.set(tool.id, tool);
  }

  get(id: string): ToolDefinition | null {
    return this.tools.get(id) ?? null;
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  listForAgent(agent: AgentDefinition): ToolDefinition[] {
    if (!agent.allowedTools) return this.list();

    return agent.allowedTools
      .map((id) => this.get(id))
      .filter((tool): tool is ToolDefinition => Boolean(tool));
  }
}
```

---

### 3.8.3 ToolRuntime 参考实现

文件：`packages/core/tool/tool-runtime.ts`

```ts
export class ToolRuntime {
  constructor(private readonly services: RuntimeServices) {}

  async execute(input: ExecuteToolInput): Promise<ToolExecutionResult> {
    const tool = this.services.toolRegistry.get(input.toolId);
    if (!tool) throw new RuntimeError("TOOL_NOT_FOUND", input.toolId);

    const permission = await this.services.permissionService.check({
      sessionId: input.sessionId,
      agentId: input.agentId,
      toolId: input.toolId,
      input: input.input,
    });

    if (!permission.allowed) {
      throw new RuntimeError("TOOL_PERMISSION_DENIED", permission.reason ?? input.toolId);
    }

    validateJsonSchema(tool.inputSchema, input.input);

    const toolCall = await this.services.toolCallStore.create({
      sessionId: input.sessionId,
      toolId: input.toolId,
      inputJson: input.input,
      status: "running",
    });

    await this.services.eventBus.emit({
      type: "tool.started",
      sessionId: input.sessionId,
      toolId: input.toolId,
    });

    try {
      const ctx: ToolContext = {
        runtime: this.services,
        sessionId: input.sessionId,
        agentId: input.agentId,
        toolCallId: toolCall.id,
        emit: (event) => this.services.eventBus.emit(event),
        createArtifact: (artifactInput) =>
          this.services.artifactStore.create({
            ...artifactInput,
            sessionId: input.sessionId,
            createdBy: {
              sessionId: input.sessionId,
              agentId: input.agentId,
              toolId: input.toolId,
            },
          }),
        recordProvenance: (prov) => this.services.provenanceStore.record(prov),
      };

      const output = await tool.execute(ctx, input.input);

      validateJsonSchema(tool.outputSchema, output);

      await this.services.toolCallStore.complete(toolCall.id, output);

      await this.services.eventBus.emit({
        type: "tool.completed",
        sessionId: input.sessionId,
        toolId: input.toolId,
      });

      return {
        toolCallId: toolCall.id,
        output,
      };
    } catch (error) {
      await this.services.toolCallStore.fail(toolCall.id, serializeError(error));
      throw error;
    }
  }
}
```

---

### 3.8.4 实现约束

1. 所有 Tool 必须有 input/output schema。
2. Tool 执行必须经过 ToolRuntime。
3. Tool 不能直接写数据库，必须通过 `ToolContext`。
4. Tool 产生大型输出时必须写 Artifact。
5. Tool 执行必须记录 tool_call。

---

## 3.9 Task Tool

### 3.9.1 接口

```ts
export interface TaskInput {
  agentId: string;
  description: string;
  input: string;
  model?: ModelRef;
  contextArtifactIds?: string[];
}
```

```ts
export interface TaskOutput {
  childSessionId: string;
  status: "completed" | "failed";
  summary: string;
  artifactIds: string[];
}
```

---

### 3.9.2 参考实现

文件：`packages/core/task/task-tool.ts`

```ts
export const taskTool: ToolDefinition<TaskInput, TaskOutput> = {
  id: "task",
  name: "Task",
  description: "Delegate bounded work to a subagent running in a child session.",
  inputSchema: taskInputSchema,
  outputSchema: taskOutputSchema,
  permission: { kind: "runtime" },

  async execute(ctx, input) {
    const targetAgent = ctx.runtime.agentRegistry.get(input.agentId);
    if (!targetAgent) {
      throw new RuntimeError("AGENT_NOT_FOUND", input.agentId);
    }

    if (!ctx.runtime.agentRegistry.canRunAs(input.agentId, "subagent")) {
      throw new RuntimeError(
        "AGENT_NOT_SUBAGENT",
        `${input.agentId} cannot run as subagent`,
      );
    }

    const parent = await ctx.runtime.sessionStore.get(ctx.sessionId);
    if (!parent) throw new RuntimeError("SESSION_NOT_FOUND", ctx.sessionId);

    const child = await ctx.runtime.sessionStore.create({
      parentId: parent.id,
      agentId: input.agentId,
      input: input.input,
      cwd: parent.cwd,
      model: input.model ?? targetAgent.model ?? parent.model,
      title: `${input.description} (@${input.agentId})`,
      permissions: targetAgent.permissions,
      metadata: {
        delegatedBy: ctx.agentId,
        contextArtifactIds: input.contextArtifactIds ?? [],
      },
    });

    await ctx.emit({
      type: "task.started",
      parentSessionId: parent.id,
      childSessionId: child.id,
      agentId: input.agentId,
    });

    const engine = new AgentSessionRunner(ctx.runtime);
    const result = await engine.runSession({
      sessionId: child.id,
      mode: "subagent",
      contextArtifactIds: input.contextArtifactIds ?? [],
    });

    await ctx.emit({
      type: "task.completed",
      parentSessionId: parent.id,
      childSessionId: child.id,
    });

    await ctx.recordProvenance({
      nodes: [
        {
          type: "session",
          refId: parent.id,
          label: `Parent session ${parent.id}`,
        },
        {
          type: "session",
          refId: child.id,
          label: `Child session ${child.id}`,
        },
      ],
      edges: [
        {
          type: "spawned",
          fromRef: parent.id,
          toRef: child.id,
        },
      ],
    });

    return {
      childSessionId: child.id,
      status: result.status === "completed" ? "completed" : "failed",
      summary: result.output,
      artifactIds: result.artifactIds,
    };
  },
};
```

---

### 3.9.3 实现约束

1. Task Tool 是唯一创建 Child Session 的入口。
2. Subagent 不共享 Parent Session 的完整上下文，只继承摘要和指定 Artifacts。
3. Task Output 必须返回 `childSessionId`。
4. Parent Agent 只能基于 Task Output 继续推理。
5. 不能让 Subagent 直接修改 Parent Session 的 messages。

---

## 3.10 Strategy Selection

### 3.10.1 接口

第一阶段只支持四种内置策略：

```ts
export type BuiltInExecutionStrategy =
  | "direct"
  | "retry"
  | "critic_revise"
  | "workflow_controlled";
```

为了保留扩展性，内部可以使用开放字符串类型：

```ts
export type ExecutionStrategy =
  | BuiltInExecutionStrategy
  | (string & {});
```

但第一阶段 Runtime Guard 只允许上述四种策略。

---

```ts
export interface ExecutionDecision {
  strategy: ExecutionStrategy;
  reason: string;
  confidence: number;

  config?: {
    maxRetries?: number;
    maxReviewRounds?: number;
    workflowId?: string;
  };

  risks?: string[];
}
```

---

### 3.10.2 StrategySelector 参考实现

文件：`packages/core/strategy/strategy-selector.ts`

```ts
export class StrategySelector {
  constructor(private readonly services: RuntimeServices) {}

  async select(input: StrategySelectionInput): Promise<ExecutionDecision> {
    if (input.requestedStrategy && input.requestedStrategy !== "auto") {
      return {
        strategy: input.requestedStrategy,
        reason: "User explicitly requested this strategy.",
        confidence: 1,
      };
    }

    const agent = this.services.agentRegistry.get(input.agentId);
    if (!agent) throw new RuntimeError("AGENT_NOT_FOUND", input.agentId);

    if (!agent.supportsStrategySelection) {
      return {
        strategy: "direct",
        reason: "Agent does not support strategy selection.",
        confidence: 1,
      };
    }

    const messages: ModelMessage[] = [
      {
        role: "system",
        content: strategySelectionSystemPrompt,
      },
      {
        role: "user",
        content: input.userGoal,
      },
    ];

    const model = selectModel({
      explicit: input.model,
      agentModel: agent.model,
      defaultModel: this.services.config.defaultModel,
    });

    const response = await this.services.providerRouter.complete({
      provider: model.provider,
      model: model.model,
      messages,
      temperature: 0,
      maxTokens: 800,
    });

    return parseExecutionDecision(response.content);
  }
}
```

---

### 3.10.3 Strategy Prompt 参考实现

文件：`packages/core/strategy/prompts.ts`

```ts
export const strategySelectionSystemPrompt = `
You are the strategy selector for jiuwen-sci.

Choose exactly one execution strategy:

- direct: simple deterministic tasks with a clear single path.
- retry: tasks with a clear path where tool or format failures are likely.
- critic_revise: writing, synthesis, critique, report, or argument tasks.
- workflow_controlled: a registered workflow should control the stages.

Do not choose branch exploration, best-of-n, tree search, or multi-path exploration.
Those are not implemented in the first version of jiuwen-sci.

Return JSON only:
{
  "strategy": "direct | retry | critic_revise | workflow_controlled",
  "reason": "...",
  "confidence": 0.0,
  "config": {
    "maxRetries": 2,
    "maxReviewRounds": 2,
    "workflowId": "optional"
  },
  "risks": []
}
`;
```

---

### 3.10.4 实现约束

1. Strategy Selection 必须在执行前发生。
2. 主控 Agent 可以建议策略，但不能直接创建分支。
3. 用户显式指定策略时优先级最高。
4. 第一阶段不允许主控 Agent 选择 `branch_explore`、`best_of_n`、`tree_search`。
5. 如果模型输出不支持的策略，Runtime Guard 必须降级或拒绝。

---

## 3.11 Runtime Guard

### 3.11.1 接口

```ts
export interface StrategyGuard {
  validate(input: StrategyGuardInput): Promise<StrategyGuardResult>;
}
```

```ts
export interface StrategyGuardResult {
  allowed: boolean;
  finalDecision: ExecutionDecision;
  warnings: string[];
  reason?: string;
}
```

---

### 3.11.2 参考实现

文件：`packages/core/strategy/runtime-guard.ts`

```ts
const SUPPORTED_STRATEGIES = new Set([
  "direct",
  "retry",
  "critic_revise",
  "workflow_controlled",
]);

export class DefaultStrategyGuard implements StrategyGuard {
  constructor(private readonly services: RuntimeServices) {}

  async validate(input: StrategyGuardInput): Promise<StrategyGuardResult> {
    const decision = structuredClone(input.decision);
    const warnings: string[] = [];

    if (!SUPPORTED_STRATEGIES.has(decision.strategy)) {
      warnings.push(
        `Strategy ${decision.strategy} is not supported in v0.1. Downgraded to direct.`,
      );

      decision.strategy = "direct";
      decision.reason = `Unsupported strategy was downgraded by Runtime Guard. Original reason: ${decision.reason}`;
    }

    if (decision.strategy === "retry") {
      const max = this.services.config.limits.maxRetries ?? 2;
      const requested = decision.config?.maxRetries ?? 1;

      if (requested > max) {
        decision.config = {
          ...decision.config,
          maxRetries: max,
        };
        warnings.push(`Reduced maxRetries from ${requested} to ${max}.`);
      }
    }

    if (decision.strategy === "critic_revise") {
      const max = this.services.config.limits.maxReviewRounds ?? 2;
      const requested = decision.config?.maxReviewRounds ?? 1;

      if (requested > max) {
        decision.config = {
          ...decision.config,
          maxReviewRounds: max,
        };
        warnings.push(`Reduced maxReviewRounds from ${requested} to ${max}.`);
      }
    }

    return {
      allowed: true,
      finalDecision: decision,
      warnings,
    };
  }
}
```

---

### 3.11.3 实现约束

1. Guard 不能调用模型。
2. Guard 只做确定性校验和策略修正。
3. Guard 必须记录所有降级和调整。
4. 第一阶段 Guard 必须拒绝或降级 Loop 相关策略。

---

## 3.12 Execution Engine 与 Runners

### 3.12.1 接口

```ts
export interface ExecutionRunner {
  strategy: ExecutionStrategy;
  run(input: RunnerInput): Promise<RunnerResult>;
}
```

```ts
export interface RunnerInput {
  sessionId: string;
  userGoal: string;
  decision: ExecutionDecision;
}
```

```ts
export interface RunnerResult {
  sessionId: string;
  status: "completed" | "failed" | "partial";
  output: string;
  artifactIds: string[];
  reviewFindingIds: string[];
}
```

---

### 3.12.2 ExecutionEngine 参考实现

文件：`packages/core/runner/execution-engine.ts`

```ts
export class ExecutionEngine {
  private readonly runners = new Map<string, ExecutionRunner>();

  constructor(
    private readonly services: RuntimeServices,
    private readonly selector: StrategySelector,
    private readonly guard: StrategyGuard,
  ) {}

  registerRunner(runner: ExecutionRunner): void {
    this.runners.set(runner.strategy, runner);
  }

  async run(input: ExecutionEngineInput): Promise<RuntimeRunResult> {
    const session = await this.services.sessionStore.get(input.sessionId);
    if (!session) throw new RuntimeError("SESSION_NOT_FOUND", input.sessionId);

    const decision = await this.selector.select({
      agentId: session.agentId,
      userGoal: input.input,
      requestedStrategy: input.requestedStrategy,
      model: session.model,
    });

    const guardResult = await this.guard.validate({
      sessionId: session.id,
      userRequestedStrategy: input.requestedStrategy,
      decision,
    });

    if (!guardResult.allowed) {
      throw new RuntimeError("STRATEGY_NOT_ALLOWED", guardResult.reason ?? "");
    }

    const strategyRecord = await this.services.storage.strategyRecords.create({
      sessionId: session.id,
      userRequestedStrategy: input.requestedStrategy,
      agentDecision: decision,
      guardResult,
      finalStrategy: guardResult.finalDecision.strategy,
    });

    await this.services.sessionStore.update(session.id, {
      strategyRecordId: strategyRecord.id,
    });

    await this.services.eventBus.emit({
      type: "strategy.selected",
      sessionId: session.id,
      strategy: guardResult.finalDecision.strategy,
    });

    const runner = this.runners.get(guardResult.finalDecision.strategy);
    if (!runner) {
      throw new RuntimeError("RUNNER_NOT_FOUND", guardResult.finalDecision.strategy);
    }

    return runner.run({
      sessionId: session.id,
      userGoal: input.input,
      decision: guardResult.finalDecision,
    });
  }

  async resume(input: ResumeInput): Promise<RuntimeRunResult> {
    const session = await this.services.sessionStore.get(input.sessionId);
    if (!session) throw new RuntimeError("SESSION_NOT_FOUND", input.sessionId);

    const strategyRecord = session.strategyRecordId
      ? await this.services.storage.strategyRecords.get(session.strategyRecordId)
      : null;

    const strategy = strategyRecord?.finalStrategy ?? "direct";
    const runner = this.runners.get(strategy);
    if (!runner) throw new RuntimeError("RUNNER_NOT_FOUND", strategy);

    return runner.run({
      sessionId: session.id,
      userGoal: session.input,
      decision: strategyRecord?.agentDecision ?? {
        strategy,
        reason: "Resumed existing session.",
        confidence: 1,
      },
    });
  }
}
```

---

### 3.12.3 DirectRunner 参考实现

文件：`packages/core/runner/direct-runner.ts`

```ts
export class DirectRunner implements ExecutionRunner {
  strategy: ExecutionStrategy = "direct";

  constructor(private readonly services: RuntimeServices) {}

  async run(input: RunnerInput): Promise<RunnerResult> {
    const runner = new AgentSessionRunner(this.services);
    return runner.runSession({
      sessionId: input.sessionId,
      mode: "primary",
    });
  }
}
```

---

### 3.12.4 RetryRunner 参考实现

文件：`packages/core/runner/retry-runner.ts`

```ts
export class RetryRunner implements ExecutionRunner {
  strategy: ExecutionStrategy = "retry";

  constructor(private readonly services: RuntimeServices) {}

  async run(input: RunnerInput): Promise<RunnerResult> {
    const maxRetries = input.decision.config?.maxRetries ?? 2;
    let lastError: unknown;

    for (let i = 0; i <= maxRetries; i++) {
      try {
        const runner = new AgentSessionRunner(this.services);
        return await runner.runSession({
          sessionId: input.sessionId,
          mode: "primary",
          retryContext: i === 0 ? undefined : serializeError(lastError),
        });
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError;
  }
}
```

---

### 3.12.5 CriticReviseRunner 参考实现

文件：`packages/core/runner/critic-revise-runner.ts`

```ts
export class CriticReviseRunner implements ExecutionRunner {
  strategy: ExecutionStrategy = "critic_revise";

  constructor(private readonly services: RuntimeServices) {}

  async run(input: RunnerInput): Promise<RunnerResult> {
    const maxRounds = input.decision.config?.maxReviewRounds ?? 2;
    const agentRunner = new AgentSessionRunner(this.services);

    let result = await agentRunner.runSession({
      sessionId: input.sessionId,
      mode: "primary",
    });

    for (let i = 0; i < maxRounds; i++) {
      const review = await this.runReviewer(input.sessionId, result.artifactIds);

      if (review.blockingFindings.length === 0) {
        return result;
      }

      result = await agentRunner.runSession({
        sessionId: input.sessionId,
        mode: "primary",
        revisionContext: review.summary,
      });
    }

    return {
      ...result,
      status: "partial",
    };
  }

  private async runReviewer(sessionId: string, artifactIds: string[]) {
    const output = await taskTool.execute(
      createInternalToolContext(this.services, sessionId, "system"),
      {
        agentId: "reviewer",
        description: "Review current output",
        input: "Review the current artifacts and report blocking issues.",
        contextArtifactIds: artifactIds,
      },
    );

    return normalizeReviewTaskOutput(output);
  }
}
```

---

### 3.12.6 WorkflowRunner 参考实现

文件：`packages/core/runner/workflow-runner.ts`

```ts
export class WorkflowRunner implements ExecutionRunner {
  strategy: ExecutionStrategy = "workflow_controlled";

  constructor(private readonly services: RuntimeServices) {}

  async run(input: RunnerInput): Promise<RunnerResult> {
    const workflowId = input.decision.config?.workflowId
      ?? this.inferWorkflowId(input.sessionId);

    const workflow = this.services.packRegistry.getWorkflow(workflowId);
    if (!workflow) {
      throw new RuntimeError("WORKFLOW_NOT_FOUND", workflowId);
    }

    const ctx = createWorkflowContext({
      services: this.services,
      sessionId: input.sessionId,
    });

    const result = await workflow.run(ctx, {
      input: input.userGoal,
    });

    return {
      sessionId: input.sessionId,
      status: result.status,
      output: result.output ?? "",
      artifactIds: result.artifactIds,
      reviewFindingIds: result.reviewFindingIds ?? [],
    };
  }

  private inferWorkflowId(sessionId: string): string {
    // 第一阶段可从 session.metadata.workflow 读取。
    return "literature-review";
  }
}
```

---

### 3.12.7 实现约束

1. Runner 可以调 AgentSessionRunner，但不能直接调 Provider。
2. Runner 不允许包含领域逻辑。
3. WorkflowRunner 只能通过 PackRegistry 找 Workflow。
4. 第一阶段不实现 BestOfNRunner、BranchExploreRunner、LoopRunner。
5. 未来 Loop Engineering 通过新增 Runner 接入，不修改现有 Runner。

---

## 3.13 AgentSessionRunner

### 3.13.1 职责

`AgentSessionRunner` 是单个 Session 的 Agent Loop。

```text
load session
load agent
load messages
assemble prompt
call provider
handle tool calls
append assistant/tool messages
repeat until finalize or maxTurns
```

---

### 3.13.2 参考实现

文件：`packages/core/session/agent-session-runner.ts`

```ts
export class AgentSessionRunner {
  constructor(private readonly services: RuntimeServices) {}

  async runSession(input: RunSessionInput): Promise<RunnerResult> {
    const session = await this.requiredSession(input.sessionId);
    const agent = this.requiredAgent(session.agentId);

    await this.services.sessionStore.update(session.id, { status: "running" });

    await this.services.messageStore.append({
      sessionId: session.id,
      role: "user",
      content: input.revisionContext
        ? `${session.input}\n\nRevision context:\n${input.revisionContext}`
        : session.input,
    });

    const maxTurns = agent.maxTurns ?? 16;
    const toolRuntime = new ToolRuntime(this.services);

    let finalOutput = "";
    let artifactIds: string[] = [];

    for (let turn = 0; turn < maxTurns; turn++) {
      const currentSession = await this.requiredSession(session.id);
      const messages = await this.services.messageStore.listBySession(session.id);
      const tools = this.services.toolRegistry.listForAgent(agent);

      const modelMessages = await this.services.promptAssembler.assemble({
        session: currentSession,
        agent,
        messages,
        availableTools: tools,
      });

      const model = selectModel({
        agentModel: agent.model,
        sessionModel: currentSession.model,
        defaultModel: this.services.config.defaultModel,
      });

      const response = await this.services.providerRouter.complete({
        provider: model.provider,
        model: model.model,
        messages: modelMessages,
        tools: tools.map(toToolSchema),
        temperature: agent.temperature,
      });

      await this.services.messageStore.append({
        sessionId: session.id,
        role: "assistant",
        content: response.content,
        model,
        tokenUsage: response.usage,
      });

      if (!response.toolCalls?.length) {
        finalOutput = response.content;
        break;
      }

      for (const call of response.toolCalls) {
        const result = await toolRuntime.execute({
          sessionId: session.id,
          agentId: agent.id,
          toolId: call.toolId,
          input: call.input,
        });

        await this.services.messageStore.append({
          sessionId: session.id,
          role: "tool",
          content: summarizeToolOutput(result.output),
          toolCallId: result.toolCallId,
        });

        const newArtifacts = extractArtifactIds(result.output);
        artifactIds.push(...newArtifacts);

        if (call.toolId === "finalize") {
          finalOutput = extractFinalText(result.output);

          await this.services.sessionStore.update(session.id, {
            status: "completed",
            artifactIds,
          });

          return {
            sessionId: session.id,
            status: "completed",
            output: finalOutput,
            artifactIds,
            reviewFindingIds: [],
          };
        }
      }
    }

    await this.services.sessionStore.update(session.id, {
      status: "completed",
      artifactIds,
    });

    return {
      sessionId: session.id,
      status: "completed",
      output: finalOutput,
      artifactIds,
      reviewFindingIds: [],
    };
  }

  private async requiredSession(id: string): Promise<Session> {
    const session = await this.services.sessionStore.get(id);
    if (!session) throw new RuntimeError("SESSION_NOT_FOUND", id);
    return session;
  }

  private requiredAgent(id: string): AgentDefinition {
    const agent = this.services.agentRegistry.get(id);
    if (!agent) throw new RuntimeError("AGENT_NOT_FOUND", id);
    return agent;
  }
}
```

---

### 3.13.3 实现约束

1. Agent Loop 必须有最大 turn 限制。
2. 模型调用和工具调用必须被事件记录。
3. 所有工具调用必须经过 ToolRuntime。
4. `finalize` 是结束 Session 的标准方式。
5. 如果超过 maxTurns，需要返回 `partial` 或 `failed`，不能无限循环。

---

## 3.14 Artifact Store

### 3.14.1 接口

```ts
export interface ArtifactStore {
  create(input: CreateArtifactInput): Promise<Artifact>;
  get(id: string): Promise<Artifact | null>;
  read(id: string): Promise<Buffer>;
  listBySession(sessionId: string): Promise<Artifact[]>;
}
```

---

### 3.14.2 参考实现

文件：`packages/storage/filesystem/artifact-store.ts`

```ts
export class FilesystemArtifactStore implements ArtifactStore {
  constructor(
    private readonly root: string,
    private readonly db: SqliteStorageConnection,
  ) {}

  async create(input: CreateArtifactInput): Promise<Artifact> {
    const bytes = Buffer.isBuffer(input.content)
      ? input.content
      : Buffer.from(input.content, "utf-8");

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const relPath = path.join("sha256", sha256.slice(0, 2), sha256);
    const absPath = path.join(this.root, relPath);

    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, bytes);

    const artifact: Artifact = {
      id: createId("art"),
      sessionId: input.sessionId,
      type: input.type,
      mediaType: input.mediaType,
      path: relPath,
      sha256,
      size: bytes.length,
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
    };

    await this.db.run(
      `insert into artifacts
       (id, session_id, type, media_type, path, sha256, size, created_by_json, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        artifact.id,
        artifact.sessionId,
        artifact.type,
        artifact.mediaType,
        artifact.path,
        artifact.sha256,
        artifact.size,
        JSON.stringify(artifact.createdBy),
        artifact.createdAt,
      ],
    );

    return artifact;
  }

  async read(id: string): Promise<Buffer> {
    const artifact = await this.get(id);
    if (!artifact) throw new RuntimeError("ARTIFACT_NOT_FOUND", id);
    return fs.readFile(path.join(this.root, artifact.path));
  }
}
```

---

### 3.14.3 实现约束

1. Artifact 使用内容寻址。
2. SQLite 只保存索引，不保存大文件内容。
3. 所有重要中间结果都应保存为 Artifact。
4. `final_report.md`、`evidence_table.json` 等必须是 Artifact，而不是 Message 文本。
5. 初版 Artifact 不包含 `loopRunId`、`branchId`、`attemptId`。

---

## 3.15 Provenance Store

### 3.15.1 接口

```ts
export interface ProvenanceNode {
  id: string;
  type:
    | "session"
    | "agent"
    | "tool_call"
    | "artifact"
    | "claim"
    | "source"
    | "review";

  refId: string;
  label: string;
  metadata?: Record<string, unknown>;
}
```

```ts
export interface ProvenanceEdge {
  id: string;
  type:
    | "created"
    | "used"
    | "derived_from"
    | "supports"
    | "refutes"
    | "reviewed"
    | "spawned"
    | "revised";

  from: string;
  to: string;
  metadata?: Record<string, unknown>;
}
```

---

### 3.15.2 参考实现

文件：`packages/storage/sqlite/provenance-store.ts`

```ts
export class SqliteProvenanceStore implements ProvenanceStore {
  constructor(private readonly db: SqliteStorageConnection) {}

  async record(input: RecordProvenanceInput): Promise<void> {
    const refToNodeId = new Map<string, string>();

    for (const nodeInput of input.nodes ?? []) {
      const node: ProvenanceNode = {
        id: createId("node"),
        type: nodeInput.type,
        refId: nodeInput.refId,
        label: nodeInput.label,
        metadata: nodeInput.metadata ?? {},
      };

      await this.db.run(
        `insert into provenance_nodes
         (id, type, ref_id, label, metadata_json)
         values (?, ?, ?, ?, ?)`,
        [
          node.id,
          node.type,
          node.refId,
          node.label,
          JSON.stringify(node.metadata),
        ],
      );

      refToNodeId.set(node.refId, node.id);
    }

    for (const edgeInput of input.edges ?? []) {
      const from = refToNodeId.get(edgeInput.fromRef) ?? edgeInput.fromRef;
      const to = refToNodeId.get(edgeInput.toRef) ?? edgeInput.toRef;

      await this.db.run(
        `insert into provenance_edges
         (id, type, from_node_id, to_node_id, metadata_json)
         values (?, ?, ?, ?, ?)`,
        [
          createId("edge"),
          edgeInput.type,
          from,
          to,
          JSON.stringify(edgeInput.metadata ?? {}),
        ],
      );
    }
  }

  async trace(refId: string): Promise<ProvenanceTrace> {
    return traceBackwards(this.db, refId);
  }
}
```

---

### 3.15.3 实现约束

1. Tool 创建 Artifact 时必须写 Provenance。
2. Task 创建 Child Session 时必须写 `spawned` 边。
3. Reviewer finding 必须写 `reviewed` 边。
4. Provenance 类型保留通用性，但第一阶段不引入 Branch / Attempt 节点。

---

## 3.16 Reviewer 与 Review Gate

### 3.16.1 ReviewFinding 接口

```ts
export interface ReviewFinding {
  id: string;
  sessionId: string;

  severity: "blocking" | "major" | "minor" | "info";
  category: string;

  targetType: "artifact" | "claim" | "citation" | "section" | "session";
  targetRef: string;

  description: string;
  suggestedAction?: string;

  status: "open" | "resolved" | "accepted_risk";
  createdAt: string;
}
```

---

### 3.16.2 ReviewerDefinition

```ts
export interface ReviewerDefinition {
  id: string;
  name: string;
  description: string;

  review(ctx: ReviewContext): Promise<ReviewResult>;
}
```

```ts
export interface ReviewResult {
  findingIds: string[];
  blockingFindingIds: string[];
  summary: string;
}
```

---

### 3.16.3 Finalize Tool 参考实现

文件：`packages/core/review/finalize-tool.ts`

```ts
export const finalizeTool: ToolDefinition<FinalizeInput, FinalizeOutput> = {
  id: "finalize",
  name: "Finalize",
  description: "Finalize the current session output.",
  inputSchema: finalizeInputSchema,
  outputSchema: finalizeOutputSchema,
  permission: { kind: "runtime" },

  async execute(ctx, input) {
    const findings = await ctx.runtime.reviewStore.listOpenBlocking(ctx.sessionId);

    if (findings.length > 0 && !input.acceptRisk) {
      return {
        status: "blocked",
        output: "",
        blockingFindingIds: findings.map((f) => f.id),
      };
    }

    const artifact = await ctx.createArtifact({
      type: "markdown",
      mediaType: "text/markdown",
      content: input.finalText,
    });

    await ctx.recordProvenance({
      nodes: [
        {
          type: "artifact",
          refId: artifact.id,
          label: "Final output",
        },
      ],
      edges: [],
    });

    return {
      status: "finalized",
      output: input.finalText,
      artifactId: artifact.id,
      blockingFindingIds: [],
    };
  },
};
```

---

### 3.16.4 实现约束

1. 有 open blocking finding 时默认不能 finalize。
2. `acceptRisk` 必须记录到 ReviewStore。
3. Final output 必须写 Artifact。
4. Finalize Tool 是结束 Session 的唯一标准方式。
5. 第一阶段 Reviewer 只做审查，不承担多路径选择。

---

## 4. Capability Pack 机制

### 4.1 Pack 接口

```ts
export interface CapabilityPack {
  id: string;
  name: string;
  version: string;

  agents?: AgentDefinition[];
  tools?: ToolDefinition[];
  reviewers?: ReviewerDefinition[];
  workflows?: WorkflowDefinition[];
  prompts?: PromptTemplate[];
}
```

---

### 4.2 WorkflowDefinition

```ts
export interface WorkflowDefinition<I = unknown, O = unknown> {
  id: string;
  name: string;
  description: string;

  defaultStrategy: "workflow_controlled";

  run(ctx: WorkflowContext, input: I): Promise<WorkflowResult<O>>;
}
```

```ts
export interface WorkflowContext {
  sessionId: string;
  services: RuntimeServices;

  task(input: TaskInput): Promise<TaskOutput>;
  createArtifact(input: CreateArtifactInput): Promise<Artifact>;
  recordProvenance(input: RecordProvenanceInput): Promise<void>;
}
```

---

### 4.3 扩展性说明

初版 Workflow 是线性或有限状态流程。未来如要接入 Loop Engineering，可以：

1. 新增 `ExplorationWorkflowDefinition`。
2. 新增 `BranchExploreRunner`。
3. 新增 `Goal / Branch / Attempt` 存储。
4. 在 WorkflowContext 中加入 `explore()` 方法。

但第一阶段不实现这些扩展点的具体逻辑。

---

## 5. Literature Pack 参考实现

Literature Pack 是第一阶段验证场景，但必须作为 Pack 加载。

---

## 5.1 Pack 注册

文件：`packages/packs/literature/index.ts`

```ts
export const literaturePack: CapabilityPack = {
  id: "literature",
  name: "Literature Research Pack",
  version: "0.1.0",

  agents: [
    literatureOrchestratorAgent,
    literatureQueryAgent,
    literatureSearchAgent,
    literatureScreeningAgent,
    literatureSynthesisAgent,
    literatureReviewerAgent,
  ],

  tools: [
    scienceListDbsTool,
    scienceSearchTool,
    paperNormalizeTool,
    paperDeduplicateTool,
    evidenceTableWriteTool,
    citationCheckTool,
  ],

  reviewers: [
    literatureClaimReviewer,
    literatureCitationReviewer,
  ],

  workflows: [
    literatureReviewWorkflow,
  ],
};
```

---

## 5.2 Literature Agents

### 5.2.1 literature-orchestrator

```ts
export const literatureOrchestratorAgent: AgentDefinition = {
  id: "literature-orchestrator",
  name: "Literature Orchestrator",
  description: "Coordinates literature review tasks.",
  mode: "subagent",
  prompt: literatureOrchestratorPrompt,
  permissions: [],
  allowedTools: [
    "task",
    "artifact_read",
    "artifact_write",
    "provenance_record",
    "finalize",
  ],
  maxTurns: 20,
};
```

---

### 5.2.2 literature-query-agent

```ts
export const literatureQueryAgent: AgentDefinition = {
  id: "literature-query-agent",
  name: "Literature Query Agent",
  description: "Builds search plans and query branches for future extensibility, but v0 executes a single selected plan.",
  mode: "subagent",
  prompt: literatureQueryPrompt,
  permissions: [],
  allowedTools: ["artifact_write", "finalize"],
  maxTurns: 10,
};
```

注意：这里的 `query_branches` 可以作为文档结构存在，但第一阶段不执行多路径搜索。Agent 可以列出备选检索策略，但 Workflow 只选择一个主策略执行。

---

### 5.2.3 literature-search-agent

```ts
export const literatureSearchAgent: AgentDefinition = {
  id: "literature-search-agent",
  name: "Literature Search Agent",
  description: "Runs literature searches through science search tools.",
  mode: "subagent",
  prompt: literatureSearchPrompt,
  permissions: [],
  allowedTools: [
    "science_list_dbs",
    "science_search",
    "paper_normalize",
    "paper_deduplicate",
    "artifact_write",
    "finalize",
  ],
  maxTurns: 16,
};
```

---

### 5.2.4 literature-reviewer-agent

```ts
export const literatureReviewerAgent: AgentDefinition = {
  id: "literature-reviewer-agent",
  name: "Literature Reviewer",
  description: "Checks citation, evidence, and claim integrity for literature outputs.",
  mode: "subagent",
  prompt: literatureReviewerPrompt,
  permissions: [],
  allowedTools: [
    "artifact_read",
    "citation_check",
    "provenance_query",
    "review_finding_write",
    "finalize",
  ],
  maxTurns: 12,
};
```

---

## 5.3 Literature Schemas

文件：`packages/packs/literature/schemas/paper.ts`

```ts
export interface PaperHit {
  id: string;
  title: string;
  abstract?: string;
  authors?: string[];
  year?: number;
  venue?: string;
  doi?: string;
  url?: string;
  sourceDb: string;
  raw?: unknown;
}
```

```ts
export interface LiteratureQueryPlan {
  researchQuestion: string;

  concepts: {
    name: string;
    synonyms: string[];
    required: boolean;
  }[];

  selectedQueries: {
    database: string;
    query: string;
    rationale: string;
  }[];

  alternativeQueries?: {
    database: string;
    query: string;
    rationale: string;
  }[];
}
```

```ts
export interface ScreeningDecision {
  paperId: string;
  decision: "include" | "exclude" | "uncertain";
  reason: string;
  confidence: number;
}
```

```ts
export interface EvidenceTable {
  researchQuestion: string;
  rows: EvidenceRow[];
}
```

```ts
export interface EvidenceRow {
  paperId: string;
  claim: string;
  supportType: "supports" | "contradicts" | "context";
  quoteOrSummary: string;
  confidence: number;
}
```

---

## 5.4 Science Connectors

### 5.4.1 Connector 接口

```ts
export interface LiteratureConnector {
  id: string;
  name: string;
  description: string;

  search(input: LiteratureSearchInput): Promise<PaperHit[]>;
}
```

---

### 5.4.2 OpenAlex Connector 参考实现

文件：`packages/packs/literature/connectors/openalex.ts`

```ts
export class OpenAlexConnector implements LiteratureConnector {
  id = "openalex";
  name = "OpenAlex";
  description = "Search OpenAlex works metadata.";

  async search(input: LiteratureSearchInput): Promise<PaperHit[]> {
    const url = new URL("https://api.openalex.org/works");
    url.searchParams.set("search", input.query);
    url.searchParams.set("per-page", String(input.limit ?? 25));

    const res = await fetch(url);
    if (!res.ok) {
      throw new RuntimeError("OPENALEX_ERROR", `${res.status} ${res.statusText}`);
    }

    const json = await res.json();

    return (json.results ?? []).map((item: any): PaperHit => ({
      id: item.id,
      title: item.title,
      abstract: reconstructOpenAlexAbstract(item.abstract_inverted_index),
      authors: (item.authorships ?? []).map((a: any) => a.author?.display_name).filter(Boolean),
      year: item.publication_year,
      venue: item.primary_location?.source?.display_name,
      doi: item.doi,
      url: item.landing_page_url ?? item.id,
      sourceDb: "openalex",
      raw: item,
    }));
  }
}
```

---

### 5.4.3 Connector Registry

```ts
export class LiteratureConnectorRegistry {
  private readonly connectors = new Map<string, LiteratureConnector>();

  register(connector: LiteratureConnector): void {
    if (this.connectors.has(connector.id)) {
      throw new RuntimeError("CONNECTOR_DUPLICATE", connector.id);
    }
    this.connectors.set(connector.id, connector);
  }

  get(id: string): LiteratureConnector | null {
    return this.connectors.get(id) ?? null;
  }

  list(): LiteratureConnector[] {
    return [...this.connectors.values()];
  }
}
```

---

## 5.5 Literature Tools

### 5.5.1 science_list_dbs

```ts
export const scienceListDbsTool: ToolDefinition<{}, ScienceListDbsOutput> = {
  id: "science_list_dbs",
  name: "Science List DBs",
  description: "List available literature databases.",
  inputSchema: emptyObjectSchema,
  outputSchema: scienceListDbsOutputSchema,
  permission: { kind: "network", default: "allow" },

  async execute(ctx) {
    const registry = getLiteratureConnectorRegistry(ctx.runtime);

    return {
      databases: registry.list().map((db) => ({
        id: db.id,
        name: db.name,
        description: db.description,
        capabilities: ["search"],
      })),
    };
  },
};
```

---

### 5.5.2 science_search

```ts
export const scienceSearchTool: ToolDefinition<ScienceSearchInput, ScienceSearchOutput> = {
  id: "science_search",
  name: "Science Search",
  description: "Search a literature database by db id.",
  inputSchema: scienceSearchInputSchema,
  outputSchema: scienceSearchOutputSchema,
  permission: { kind: "network", default: "allow" },

  async execute(ctx, input) {
    const registry = getLiteratureConnectorRegistry(ctx.runtime);
    const connector = registry.get(input.db);

    if (!connector) {
      throw new RuntimeError("LITERATURE_DB_NOT_FOUND", input.db);
    }

    const results = await connector.search({
      query: input.query,
      limit: input.limit ?? 25,
    });

    const artifact = await ctx.createArtifact({
      type: "json",
      mediaType: "application/json",
      content: JSON.stringify(
        {
          db: input.db,
          query: input.query,
          results,
        },
        null,
        2,
      ),
    });

    await ctx.recordProvenance({
      nodes: [
        {
          type: "artifact",
          refId: artifact.id,
          label: `Search results from ${input.db}`,
        },
      ],
      edges: [],
    });

    return {
      db: input.db,
      query: input.query,
      count: results.length,
      results,
      artifactId: artifact.id,
    };
  },
};
```

---

### 5.5.3 paper_deduplicate

```ts
export const paperDeduplicateTool: ToolDefinition<PaperDeduplicateInput, PaperDeduplicateOutput> = {
  id: "paper_deduplicate",
  name: "Paper Deduplicate",
  description: "Deduplicate papers by DOI and normalized title.",
  inputSchema: paperDeduplicateInputSchema,
  outputSchema: paperDeduplicateOutputSchema,
  permission: { kind: "runtime" },

  async execute(ctx, input) {
    const seen = new Map<string, PaperHit>();
    const duplicates: DuplicateRecord[] = [];

    for (const paper of input.papers) {
      const key = paper.doi
        ? `doi:${normalizeDoi(paper.doi)}`
        : `title:${normalizeTitle(paper.title)}:${paper.year ?? ""}`;

      if (seen.has(key)) {
        duplicates.push({
          keptId: seen.get(key)!.id,
          duplicateId: paper.id,
          reason: key.startsWith("doi:") ? "doi" : "title_year",
        });
        continue;
      }

      seen.set(key, paper);
    }

    const deduped = [...seen.values()];

    const artifact = await ctx.createArtifact({
      type: "json",
      mediaType: "application/json",
      content: JSON.stringify({ deduped, duplicates }, null, 2),
    });

    return {
      papers: deduped,
      duplicateCount: duplicates.length,
      artifactId: artifact.id,
    };
  },
};
```

---

## 5.6 Literature Workflow

Workflow 是 Pack 提供的领域状态机。它调用 Runtime，而不是绕过 Runtime。

第一阶段采用线性 Workflow：

```text
query
  ↓
search
  ↓
dedupe
  ↓
screen
  ↓
synthesize
  ↓
review
  ↓
finalize
```

---

### 5.6.1 参考实现

```ts
export const literatureReviewWorkflow: WorkflowDefinition = {
  id: "literature-review",
  name: "Literature Review",
  description: "Search, screen, synthesize, and review papers.",
  defaultStrategy: "workflow_controlled",

  async run(ctx, input) {
    const queryTask = await ctx.task({
      agentId: "literature-query-agent",
      description: "Generate query plan",
      input: input.question,
    });

    const searchTask = await ctx.task({
      agentId: "literature-search-agent",
      description: "Run literature search",
      input: "Use the query plan artifact and search available literature databases.",
      contextArtifactIds: queryTask.artifactIds,
    });

    const screeningTask = await ctx.task({
      agentId: "literature-screening-agent",
      description: "Screen search results",
      input: "Screen candidate papers for relevance.",
      contextArtifactIds: searchTask.artifactIds,
    });

    const synthesisTask = await ctx.task({
      agentId: "literature-synthesis-agent",
      description: "Synthesize evidence",
      input: "Produce evidence table and narrative synthesis.",
      contextArtifactIds: screeningTask.artifactIds,
    });

    const reviewTask = await ctx.task({
      agentId: "literature-reviewer-agent",
      description: "Review synthesis",
      input: "Review claims, citations, and evidence.",
      contextArtifactIds: synthesisTask.artifactIds,
    });

    return {
      status: "completed",
      artifactIds: [
        ...queryTask.artifactIds,
        ...searchTask.artifactIds,
        ...screeningTask.artifactIds,
        ...synthesisTask.artifactIds,
        ...reviewTask.artifactIds,
      ],
    };
  },
};
```

---

### 5.6.2 实现约束

1. Literature Workflow 不允许直接调用 Provider。
2. Literature Workflow 必须通过 Task 调用 Agent。
3. Literature Workflow 可以固定阶段，但阶段内部由 Agent 智能执行。
4. Literature Workflow 输出必须全部 Artifact 化。
5. 第一阶段不执行多个 query branch，只执行 selected query plan。
6. `alternativeQueries` 只作为产物信息保留，不触发多路径探索。

---

## 6. CLI 参考实现

CLI 使用 `commander` 或同类库。命令风格向 Claude Code / Codex 靠近。

---

## 6.1 package.json

文件：`apps/cli/package.json`

```json
{
  "name": "@jiuwen-sci/cli",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "jiuwen-sci": "./dist/index.js"
  },
  "dependencies": {
    "commander": "^12.0.0",
    "chalk": "^5.3.0",
    "ora": "^8.0.0"
  }
}
```

---

## 6.2 CLI 入口

文件：`apps/cli/src/index.ts`

```ts
#!/usr/bin/env node

import { createCommand } from "./command.js";

const program = createCommand();

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
```

---

## 6.3 Command 组装

文件：`apps/cli/src/command.ts`

```ts
export function createCommand(): Command {
  const program = new Command();

  program
    .name("jiuwen-sci")
    .description("CLI-first scientific Agent Runtime")
    .version(pkg.version)
    .option("-C, --cd <path>", "set working directory")
    .option("-m, --model <provider:model>", "model to use")
    .option("-c, --config <key=value...>", "override config")
    .option("-a, --approval <mode>", "approval mode: on-request | never | always")
    .option("--sandbox <mode>", "sandbox mode: none | readonly | workspace-write")
    .option("--json", "output JSON")
    .option("--verbose", "verbose output")
    .option("--quiet", "quiet output");

  program
    .argument("[prompt]", "start interactive mode with optional initial prompt")
    .action(async (prompt, opts) => {
      await runInteractive({ prompt, opts });
    });

  program.addCommand(execCommand());
  program.addCommand(resumeCommand());
  program.addCommand(doctorCommand());
  program.addCommand(sessionCommand());
  program.addCommand(artifactCommand());
  program.addCommand(provenanceCommand());
  program.addCommand(reviewCommand());
  program.addCommand(packCommand());
  program.addCommand(literatureCommand());

  return program;
}
```

---

## 6.4 exec 命令

```ts
export function execCommand(): Command {
  return new Command("exec")
    .description("run a non-interactive task")
    .argument("<prompt>", "task prompt")
    .option("--strategy <strategy>", "execution strategy", "auto")
    .option("--max-retries <n>", "maximum retries")
    .option("--max-review-rounds <n>", "maximum review rounds")
    .action(async (prompt, options, command) => {
      const global = command.parent?.opts() ?? {};

      const runtime = await createCliRuntime({
        cwd: global.cd ?? process.cwd(),
        model: global.model,
        configOverrides: global.config,
      });

      await runtime.start();

      try {
        const result = await runtime.run({
          input: prompt,
          strategy: options.strategy,
          model: parseModelRef(global.model),
          cwd: global.cd ?? process.cwd(),
          metadata: {
            maxRetries: Number(options.maxRetries ?? 0) || undefined,
            maxReviewRounds: Number(options.maxReviewRounds ?? 0) || undefined,
          },
        });

        printRunResult(result, { json: global.json, quiet: global.quiet });
      } finally {
        await runtime.stop();
      }
    });
}
```

---

## 6.5 resume 命令

```ts
export function resumeCommand(): Command {
  return new Command("resume")
    .description("resume a previous session")
    .argument("<session>", "session id")
    .action(async (sessionId, _options, command) => {
      const global = command.parent?.opts() ?? {};
      const runtime = await createCliRuntime({ cwd: global.cd ?? process.cwd() });

      await runtime.start();
      try {
        const result = await runtime.resume(sessionId);
        printRunResult(result, { json: global.json, quiet: global.quiet });
      } finally {
        await runtime.stop();
      }
    });
}
```

---

## 6.6 doctor 命令

```ts
export function doctorCommand(): Command {
  return new Command("doctor")
    .description("diagnose local jiuwen-sci setup")
    .action(async () => {
      const checks = await runDoctorChecks();

      for (const check of checks) {
        const mark = check.ok ? "✓" : "✗";
        console.log(`${mark} ${check.name}: ${check.message}`);
      }

      if (checks.some((c) => !c.ok)) process.exitCode = 1;
    });
}
```

Doctor 检查项：

```text
- Node/Bun 版本
- SQLite 可写
- .jiuwen-sci/config.toml 是否存在
- artifacts 目录是否可写
- 默认 Provider 是否配置
- API key 环境变量是否存在
- Literature connector 网络访问是否正常
```

---

## 6.7 literature review 命令

```ts
export function literatureCommand(): Command {
  const literature = new Command("literature")
    .description("literature research workflows");

  literature
    .command("review")
    .description("run a literature review workflow")
    .argument("<question>", "research question")
    .option("--db <ids>", "comma separated db ids")
    .option("--limit <n>", "result limit", "50")
    .option("--strategy <strategy>", "execution strategy", "workflow_controlled")
    .option("--max-review-rounds <n>", "maximum review rounds", "2")
    .action(async (question, options, command) => {
      const global = command.parent?.parent?.opts() ?? {};
      const runtime = await createCliRuntime({
        cwd: global.cd ?? process.cwd(),
        model: global.model,
        packs: ["literature"],
      });

      await runtime.start();
      runtime.registerPack(literaturePack);

      try {
        const result = await runtime.run({
          input: question,
          agentId: "research-orchestrator",
          strategy: options.strategy,
          packIds: ["literature"],
          cwd: global.cd ?? process.cwd(),
          model: parseModelRef(global.model),
          metadata: {
            workflow: "literature-review",
            dbs: options.db?.split(","),
            limit: Number(options.limit),
            maxReviewRounds: Number(options.maxReviewRounds),
          },
        });

        printRunResult(result, { json: global.json, quiet: global.quiet });
      } finally {
        await runtime.stop();
      }
    });

  return literature;
}
```

---

## 6.8 Interactive Slash Commands

第一阶段交互模式至少支持：

```text
/init
/status
/model
/agent
/strategy
/permissions
/tasks
/artifacts
/provenance
/review
/compact
/exit
```

参考实现：

```ts
const slashCommands: Record<string, SlashCommandHandler> = {
  "/status": async (ctx) => {
    const session = await ctx.runtime.services.sessionStore.get(ctx.sessionId);
    return formatSessionStatus(session);
  },

  "/model": async (ctx, args) => {
    if (!args.trim()) return ctx.runtime.services.config.defaultModel;
    await ctx.runtime.services.configStore.set("defaultModel", parseModelRef(args));
    return `Model set to ${args}`;
  },

  "/tasks": async (ctx) => {
    const children = await ctx.runtime.services.sessionStore.children(ctx.sessionId);
    return formatSessionTree(children);
  },

  "/artifacts": async (ctx) => {
    const artifacts = await ctx.runtime.services.artifactStore.listBySession(ctx.sessionId);
    return formatArtifactTable(artifacts);
  },

  "/exit": async () => {
    process.exit(0);
  },
};
```

---

## 6.9 CLI 输出风格

默认输出应是流式事件 + 最终结果。

示例：

```text
jiuwen-sci exec "Survey recent papers on AI agents for scientific discovery"

⏺ Session ses_01J... created
⏺ Strategy selected: workflow_controlled
⏺ Agent research-orchestrator started
⏺ Task literature-query-agent started
⏺ Artifact queries.json created
⏺ Task literature-search-agent started
⏺ Tool science_search openalex completed: 25 results
⏺ Tool science_search arxiv completed: 20 results
⏺ Artifact deduped_papers.json created
⏺ Task literature-synthesis-agent started
⏺ Task literature-reviewer-agent started
⏺ Review: 0 blocking, 2 minor
✓ Completed

Final artifact:
  art_abc123 final_report.md

Next:
  jiuwen-sci artifact cat art_abc123
  jiuwen-sci session tree ses_01J...
  jiuwen-sci provenance trace art_abc123
```

JSON 模式输出 JSONL：

```json
{"type":"session.created","sessionId":"ses_01J..."}
{"type":"strategy.selected","strategy":"workflow_controlled"}
{"type":"artifact.created","artifactId":"art_abc123"}
{"type":"session.completed","sessionId":"ses_01J..."}
```

---

## 7. SQLite Schema

第一阶段使用 SQLite。

```sql
create table sessions (
  id text primary key,
  parent_id text,
  agent_id text not null,
  title text,
  status text not null,
  input text,
  cwd text,
  model_json text,
  permissions_json text,
  strategy_record_id text,
  artifact_ids_json text,
  metadata_json text,
  created_at text not null,
  updated_at text not null
);

create table messages (
  id text primary key,
  session_id text not null,
  role text not null,
  content text not null,
  tool_call_id text,
  artifact_ids_json text,
  model_json text,
  token_usage_json text,
  created_at text not null
);

create table strategy_records (
  id text primary key,
  session_id text not null,
  user_requested_strategy text,
  agent_decision_json text not null,
  guard_result_json text not null,
  final_strategy text not null,
  created_at text not null
);

create table tool_calls (
  id text primary key,
  session_id text not null,
  tool_id text not null,
  input_json text,
  output_json text,
  status text not null,
  error_json text,
  created_at text not null,
  completed_at text
);

create table artifacts (
  id text primary key,
  session_id text not null,
  type text not null,
  media_type text not null,
  path text not null,
  sha256 text not null,
  size integer not null,
  created_by_json text,
  created_at text not null
);

create table provenance_nodes (
  id text primary key,
  type text not null,
  ref_id text not null,
  label text,
  metadata_json text
);

create table provenance_edges (
  id text primary key,
  type text not null,
  from_node_id text not null,
  to_node_id text not null,
  metadata_json text
);

create table review_findings (
  id text primary key,
  session_id text not null,
  severity text not null,
  category text,
  target_type text,
  target_ref text,
  description text not null,
  suggested_action text,
  status text not null,
  created_at text not null
);
```

---

## 8. 使用方式

### 8.1 初始化

```bash
jiuwen-sci init
```

生成：

```text
.jiuwen-sci/
├── config.toml
├── runtime.db
├── artifacts/
├── logs/
└── cache/
```

---

### 8.2 配置 Provider

```bash
jiuwen-sci config set default_model anthropic:claude-sonnet-4
jiuwen-sci config set providers.anthropic.api_key_env ANTHROPIC_API_KEY
```

或：

```bash
jiuwen-sci config set default_model openai:gpt-4.1
jiuwen-sci config set providers.openai.base_url https://api.openai.com/v1
jiuwen-sci config set providers.openai.api_key_env OPENAI_API_KEY
```

开发测试：

```bash
jiuwen-sci config set default_model mock:deterministic
```

---

### 8.3 交互模式

```bash
jiuwen-sci
```

带初始任务：

```bash
jiuwen-sci "Investigate AI agents for scientific discovery"
```

交互中：

```text
/model anthropic:claude-sonnet-4
/strategy auto
/permissions
/tasks
/artifacts
/provenance
/review
```

---

### 8.4 非交互执行

```bash
jiuwen-sci exec "Investigate promising research directions for AI agents in biology"
```

指定模型：

```bash
jiuwen-sci exec "Run a literature review" \
  --model anthropic:claude-sonnet-4
```

指定工作目录：

```bash
jiuwen-sci -C ./my-project exec "Analyze the papers in this folder"
```

---

### 8.5 策略控制

自动策略：

```bash
jiuwen-sci exec "Survey AI agents for scientific discovery" --strategy auto
```

直接执行：

```bash
jiuwen-sci exec "Summarize these search results" --strategy direct
```

Retry：

```bash
jiuwen-sci exec "Extract structured metadata from this document" \
  --strategy retry \
  --max-retries 2
```

Critic-revise：

```bash
jiuwen-sci exec "Improve this draft report" \
  --strategy critic_revise \
  --max-review-rounds 2
```

第一阶段不支持：

```bash
jiuwen-sci exec "..." --strategy branch_explore
jiuwen-sci exec "..." --strategy best_of_n
jiuwen-sci loop ...
```

---

### 8.6 文献调研

```bash
jiuwen-sci literature review \
  "AI agents for scientific discovery" \
  --strategy workflow_controlled \
  --db openalex,arxiv,crossref \
  --limit 50
```

自动策略也允许：

```bash
jiuwen-sci literature review \
  "AI agents for scientific discovery" \
  --strategy auto \
  --db openalex,arxiv,crossref \
  --limit 50
```

---

### 8.7 恢复 Session

```bash
jiuwen-sci resume ses_abc123
```

---

### 8.8 查看 Session

```bash
jiuwen-sci session list
jiuwen-sci session show ses_abc123
jiuwen-sci session tree ses_abc123
```

---

### 8.9 查看 Artifact

```bash
jiuwen-sci artifact list --session ses_abc123
jiuwen-sci artifact cat art_abc123
```

---

### 8.10 查看 Provenance

```bash
jiuwen-sci provenance trace art_abc123
```

---

### 8.11 查看 Review

```bash
jiuwen-sci review list --session ses_abc123
jiuwen-sci review show rev_001
```

---

## 9. 开发里程碑

### Milestone 1：Core Skeleton

实现：

```text
- monorepo
- jiuwen-sci init
- jiuwen-sci exec
- RuntimeHost
- RuntimeServices
- SQLite 连接
- SessionStore
- MessageStore
- AgentRegistry
- MockProvider
```

验收：

```bash
jiuwen-sci exec "hello" --model mock:deterministic
```

---

### Milestone 2：Tool Runtime

实现：

```text
- ToolRegistry
- ToolRuntime
- artifact_write
- artifact_read
- finalize
- RuntimeEvent
```

验收：

```bash
jiuwen-sci exec "write a short note as an artifact" --model mock:deterministic
jiuwen-sci artifact list
```

---

### Milestone 3：Task / Subagent

实现：

```text
- task tool
- child session
- subagent mode validation
- parent-child session tree
```

验收：

```bash
jiuwen-sci exec "ask a reviewer subagent to critique this answer" --model mock:deterministic
jiuwen-sci session tree <session-id>
```

---

### Milestone 4：Strategy Selection

实现：

```text
- ExecutionDecision
- StrategySelector
- RuntimeGuard
- StrategyRecord
- DirectRunner
- RetryRunner
- CriticReviseRunner
- WorkflowRunner
```

验收：

```bash
jiuwen-sci exec "Improve this draft report" --strategy auto
jiuwen-sci session show <session-id>
```

必须能看到 strategy record。

---

### Milestone 5：Provenance Lite

实现：

```text
- provenance node / edge
- tool call provenance
- task spawned edge
- artifact trace
```

验收：

```bash
jiuwen-sci provenance trace <artifact-id>
```

---

### Milestone 6：Review Gate

实现：

```text
- ReviewFinding
- ReviewStore
- review_finding_write
- finalize blocking gate
- reviewer subagent integration
```

验收：

```bash
jiuwen-sci exec "Create and review a short research note" --strategy critic_revise
jiuwen-sci review list --session <session-id>
```

---

### Milestone 7：Literature Pack v0

实现：

```text
- literature pack registration
- literature agents
- science_list_dbs
- science_search
- openalex connector
- arxiv connector
- paper_normalize
- paper_deduplicate
```

验收：

```bash
jiuwen-sci literature review "AI agents for scientific discovery" --limit 30
```

输出：

```text
queries.json
search_results.json
deduped_papers.json
```

---

### Milestone 8：Literature End-to-End

实现：

```text
- selected query plan
- search
- dedupe
- screening
- synthesis
- reviewer
- review findings
- final report
```

验收：

```bash
jiuwen-sci literature review \
  "AI agents for scientific discovery" \
  --strategy workflow_controlled \
  --max-review-rounds 2
```

输出：

```text
protocol.json
queries.json
search_results.json
deduped_papers.json
screening_decisions.json
evidence_table.json
synthesis.md
review_findings.json
final_report.md
```

---

## 10. 测试要求

### 10.1 单元测试

必须覆盖：

```text
AgentRegistry
ToolRegistry
StrategySelector
RuntimeGuard
SessionStore
ArtifactStore
ProvenanceStore
TaskTool
ReviewStore
FinalizeTool
```

---

### 10.2 集成测试

必须覆盖：

```text
exec direct
exec retry
exec critic_revise
exec workflow_controlled
task creates child session
artifact trace
review blocks finalize
literature review v0
```

---

### 10.3 MockProvider 测试

所有核心测试必须能在无网络、无真实 LLM 的情况下通过：

```bash
jiuwen-sci exec "hello" --model mock:deterministic
```

---

## 11. 开发约束清单

### 11.1 Core Runtime 禁止事项

Core 中禁止：

1. 引入领域类型。
2. 直接调用文献数据库。
3. 直接拼接领域 Prompt。
4. 直接写领域 Artifact。
5. 直接调用 Provider。
6. 绕过 ToolRuntime 执行 Tool。
7. 绕过 Task Tool 创建 Child Session。
8. 在 Runner 中写领域逻辑。
9. 引入 LoopRuntime、Branch、Attempt 等初版不实现的概念。

---

### 11.2 Literature Pack 禁止事项

Literature Pack 禁止：

1. 直接操作 SQLite。
2. 直接创建 Session。
3. 直接调用 Provider。
4. 绕过 ArtifactStore 写文件。
5. 绕过 ProvenanceStore 记录证据链。
6. 将文献调研流程写进 Core。
7. 第一阶段执行多 query branch。

---

### 11.3 CLI 禁止事项

CLI 禁止：

1. 直接调用 Provider。
2. 直接调用 Tool。
3. 直接操作数据库。
4. 包含业务流程逻辑。
5. 输出不可追踪的结果。

CLI 只能调用：

```text
RuntimeHost
Store Query APIs
Formatters
```

---

## 12. 第一阶段最终验收标准

### 12.1 Runtime 验收

必须证明：

1. `jiuwen-sci exec` 能创建主 Session。
2. Primary Agent 能运行。
3. Primary Agent 能通过 `task` 调 Subagent。
4. Subagent 在 Child Session 中运行。
5. Tool Call 能生成 Artifact。
6. Artifact 能被后续 Agent 读取。
7. Provenance 能追踪 Artifact 来源。
8. Strategy Selection 能记录策略。
9. Runtime Guard 能修正策略。
10. Reviewer 能产生 ReviewFinding。
11. Blocking Finding 能阻止 finalize。
12. CLI 能查看 Session Tree、Artifact、Provenance、Review。
13. 不需要 Loop Engineering 也能打通端到端链路。

---

### 12.2 Literature Pack 验收

输入：

```text
Survey recent papers on AI agents for scientific discovery
```

输出：

```text
protocol.json
queries.json
search_results.json
deduped_papers.json
screening_decisions.json
evidence_table.json
synthesis.md
review_findings.json
final_report.md
```

必须满足：

1. 引用来自检索结果。
2. 核心结论能追溯到 evidence table。
3. Reviewer findings 被记录。
4. Blocking finding 未解决时不能 finalize。
5. Session tree 能显示所有子 Agent。
6. Provenance trace 能从 final report 追到 search results。
7. `alternativeQueries` 可以保留在 artifact 中，但不会触发多路径执行。

---

## 13. 后续 Loop Engineering 扩展预留

第一阶段完成后，如需实现 Loop Engineering，应作为第二阶段或独立阶段处理。

建议扩展点：

```text
packages/core/
  exploration/
    goal.ts
    branch.ts
    attempt.ts
    exploration-runner.ts
    evaluator.ts
    policy.ts
```

建议新增命令：

```bash
jiuwen-sci explore "<goal>"
jiuwen-sci explore show <exploration-id>
jiuwen-sci explore tree <exploration-id>
```

建议新增策略：

```text
best_of_n
branch_explore
tree_search
critic_revise_loop
```

建议新增表：

```text
exploration_runs
branches
attempts
evaluations
```

但这些不属于第一阶段。

---

## 14. 第一阶段最终形态

第一阶段完成后，jiuwen-sci 应该是：

```text
一个 CLI-first、local-first、可扩展的科研 Agent Runtime Kernel。
```

核心链路：

```text
Primary Agent
  → Strategy Selection
  → Runtime Guard
  → Runner
  → Tool
  → Subagent
  → Child Session
  → Artifact
  → Provenance
  → Reviewer
  → Final Output
```

文献调研只是第一条验证链路。后续扩展到假设生成、实验设计、数据分析、代码执行、仿真、论文写作，应该通过新的 Capability Pack 接入；如果后续要加入 Loop Engineering，也应该通过新增 Runner / Exploration 模块接入，而不是修改 Core Runtime 的基础执行语义。

