# jiuwen-sci

`jiuwen-sci` 是一个 CLI-first、local-first 的通用科研 Agent 平台。项目目标不是只做文献调研，而是提供一个可扩展的科研 Agent Runtime Kernel，让文献调研、实验设计、算法发现、代码编写、数据分析、论文写作等能力都能通过独立 capability pack 接入。

当前版本重点完成了通用 Runtime 和 `literature` pack，用 PRISMA-style 文献调研链路验证主 Agent、子 Agent、工具、Artifact、Provenance、Review 和 Workflow 的完整闭环。

## 定位

`jiuwen-sci` 的核心定位：

- **通用科研 Agent 平台**：Core Runtime 不包含 Paper、DOI、PRISMA 等领域概念，领域能力通过 pack 扩展。
- **CLI-first**：优先支持终端使用方式，适合本地科研工作流和自动化脚本。
- **Local-first**：Session、messages、tool calls、artifacts、provenance 默认保存在本地 `.jiuwen-sci/`。
- **Session-centered**：每次任务创建一个主 Session，子 Agent 通过 Task Tool 创建 Child Session。
- **Artifact-first**：重要中间结果写入 Artifact，不把大 JSON/Markdown 塞进模型上下文。
- **Provenance-aware**：记录 artifact、source、claim、tool/session 之间的派生与支持关系。
- **Pack-extensible**：不同科研场景通过 capability pack 接入，而不是修改 Core。

## 当前架构

```text
CLI
  -> RuntimeHost
  -> ExecutionEngine
  -> StrategySelector / RuntimeGuard
  -> Runner
     - direct
     - retry
     - critic_revise
     - workflow_controlled
  -> AgentSessionRunner / WorkflowRunner
  -> ToolRuntime
  -> ArtifactStore / ProvenanceStore / ReviewStore
  -> Capability Packs
```

目录结构：

```text
jiuwen-sci/
├── apps/
│   └── cli/                    # jiuwen-sci CLI
├── packages/
│   ├── core/                   # 通用 Agent Runtime
│   └── packs/
│       └── literature/         # PRISMA-style 文献调研 pack
├── tests/                      # node:test 集成测试
├── .jiuwen-sci/
│   ├── config.toml             # 本地配置示例，不存放 API key
│   ├── runtime.db              # 本地 SQLite，已 gitignore
│   ├── artifacts/              # 内容寻址 artifact，已 gitignore
│   ├── logs/                   # 已 gitignore
│   └── cache/                  # 已 gitignore
└── jiuwen-sci-phase1-design.md # 第一阶段设计文档
```

## 已完成能力

### Core Runtime

- RuntimeHost 生命周期管理和 pack/agent/tool/reviewer 注册。
- SQLite-backed stores：
  - SessionStore
  - MessageStore
  - ToolCallStore
  - ProvenanceStore
  - ReviewStore
- Filesystem ArtifactStore：
  - artifact 内容写入 `.jiuwen-sci/artifacts/`
  - SQLite 只保存索引和 hash
- Agent Registry / Tool Registry / Reviewer Registry / Pack Registry。
- ToolRuntime：
  - 所有工具调用记录 tool call
  - 工具创建 artifact 走 ToolContext
  - 工具可写 provenance
- Task Tool：
  - 子 Agent 通过 Child Session 执行
  - Parent/Child Session 有 provenance `spawned` 关系
- Execution Strategy：
  - `direct`
  - `retry`
  - `critic_revise`
  - `workflow_controlled`
- Runtime Guard：
  - 拒绝或降级未实现的 loop/best-of-n/tree-search 策略
- Pack workflow 选择：
  - Runtime 会在已注册 pack 的 workflow 中按需选择
  - 例如普通 `exec "请调研..."` 会路由到 `literature-review`
  - Pack 是否可用由注册/配置控制，模型不能任意加载未知 pack
- OpenAI-compatible provider：
  - 支持普通 OpenAI-compatible API
  - 支持火山引擎 Ark Coding Plan fallback
  - 支持 `volcengine:glm-5.2`
- MockProvider：
  - 所有核心测试可离线运行

### Literature Pack

`packages/packs/literature` 已实现 PRISMA-style 文献调研工作流。

已注册 connector：

- OpenAlex
- arXiv
- Crossref
- PubMed
- Europe PMC
- Semantic Scholar
- bioRxiv
- medRxiv

已实现工具：

- `science_list_dbs`
- `science_search`
- `paper_fetch`
- `paper_deduplicate`
- `citation_chain`
- `citation_verify`
- `bibtex_write`
- `prisma_flow_write`
- `evidence_table_write`
- `citation_check`

文献调研 workflow 产物包括：

- `protocol.json`
- `queries.json`
- `identification.json`
- `citation_chaining.json`
- `deduped_papers.json`
- `screening_log.json`
- `eligibility_log.json`
- `quality_assessment.json`
- `included_studies.json`
- `evidence_table.json`
- `contradiction_detection.json`
- `citation_verification.json`
- `bibtex.bib`
- `prisma_flow.json`
- `review_findings.json`
- `final_report.md`

## 环境要求

- Node.js 22+
- npm 11+

当前使用 Node 22 的 `node:sqlite`，运行 CLI 和测试时需要加：

```bash
--experimental-sqlite
```

## 安装

```bash
git clone https://github.com/zy95-12/jiuwen-sci-demo.git
cd jiuwen-sci-demo
npm install
npm run build
```

运行测试：

```bash
npm test
```

## 配置方法

### Mock 模型

默认可直接使用 mock provider：

```bash
node --experimental-sqlite apps/cli/dist/index.js \
  --model mock:deterministic \
  exec "hello"
```

### 火山引擎 GLM 5.2

推荐使用环境变量，不要把 API key 写入仓库：

```bash
export OPENAI_API_KEY="你的火山引擎 API key"
export OPENAI_BASE_URL="https://ark.cn-beijing.volces.com/api/coding/v3"
```

然后运行：

```bash
node --experimental-sqlite apps/cli/dist/index.js \
  --model volcengine:glm-5.2 \
  exec "用一句中文回答：连接测试。"
```

本地开发时也支持从 `/root/.ark-helper/config.yaml` 读取 `api_key` 作为 fallback。该文件不在本仓库内，也不应提交。

`.jiuwen-sci/config.toml` 只保存非敏感配置示例：

```toml
default_model = "mock:deterministic"

[providers.openai_compatible]
base_url = "https://ark.cn-beijing.volces.com/api/coding/v3"
api_key_env = "OPENAI_API_KEY"
default_volcengine_model = "glm-5.2"
```

## 使用方法

### 环境诊断

```bash
node --experimental-sqlite apps/cli/dist/index.js doctor
```

### 普通任务

```bash
node --experimental-sqlite apps/cli/dist/index.js \
  --model mock:deterministic \
  exec "写一句关于科研 Agent Runtime 的介绍"
```

使用火山 GLM 5.2：

```bash
node --experimental-sqlite apps/cli/dist/index.js \
  --model volcengine:glm-5.2 \
  exec "写一句关于科研 Agent Runtime 的介绍"
```

### 自动选择 pack workflow

普通 `exec` 会在已注册 pack 中按需选择 workflow：

```bash
node --experimental-sqlite apps/cli/dist/index.js \
  --model mock:deterministic \
  exec "请调研 AI agents for scientific discovery 的文献"
```

该命令会自动路由到 `literature-review` workflow。

### 显式运行文献调研

```bash
node --experimental-sqlite apps/cli/dist/index.js \
  --model mock:deterministic \
  literature review "AI agents for scientific discovery" \
  --limit 10 \
  --db openalex,semantic-scholar,crossref
```

为了减少网络波动，快速验证可先用：

```bash
node --experimental-sqlite apps/cli/dist/index.js \
  --model mock:deterministic \
  literature review "AI agents for scientific discovery" \
  --limit 2 \
  --db openalex
```

### 查看 Session

```bash
node --experimental-sqlite apps/cli/dist/index.js session list
node --experimental-sqlite apps/cli/dist/index.js session show <session-id>
node --experimental-sqlite apps/cli/dist/index.js session tree <session-id>
```

### 查看 Artifact

```bash
node --experimental-sqlite apps/cli/dist/index.js artifact list
node --experimental-sqlite apps/cli/dist/index.js artifact list --session <session-id>
node --experimental-sqlite apps/cli/dist/index.js artifact cat <artifact-id>
```

### 查看 Provenance

```bash
node --experimental-sqlite apps/cli/dist/index.js provenance trace <artifact-or-node-id>
```

### 查看 Review Findings

```bash
node --experimental-sqlite apps/cli/dist/index.js review list --session <session-id>
```

## 安全与密钥说明

本仓库不应包含任何真实 API key。

已通过 `.gitignore` 排除：

- `.env`
- `.env.*`
- `*.key`
- `*.pem`
- `.jiuwen-sci/runtime.db`
- `.jiuwen-sci/artifacts/`
- `.jiuwen-sci/logs/`
- `.jiuwen-sci/cache/`
- `node_modules/`
- `dist/`

提交前建议检查：

```bash
git status --short
git diff --cached
```

不要提交：

- 火山引擎 API key
- OpenAI/Anthropic/Gemini API key
- 本地 runtime DB
- 本地 artifacts
- `.ark-helper` 配置

## 当前限制

- Literature workflow 已接近 PRISMA-style，但仍不是生产级系统综述工具。
- Citation chaining 当前以 connector 元数据为基础，尚未完整展开 forward/backward citation graph。
- Full-text/PDF 下载和 section-level evidence extraction 尚未实现。
- Reviewer 已有结构，但 citation mismatch、untraceable number、figure/stat mismatch 还需要更强的自动审计。
- Provenance 已支持 source/claim 粒度，但 claim-level review gate 仍需增强。
- 当前没有 Web UI。
- 当前没有 notebook/Python kernel、远程 GPU/SLURM、实验调度能力。

## 未来计划

### 通用 Runtime

- 配置文件加载和 `config set/get` CLI。
- 更完整的 interactive mode 和 slash commands。
- 更严格的 sandbox/permission 实现。
- 更完善的 event stream 和 JSONL 输出。
- Provider catalog 和模型能力描述。
- 并发 task 调度和取消/恢复能力。
- 更强的 provenance trace 查询。
- Reviewer gate 与 revision loop 的标准化。

### Literature Pack

- 完整 citation chaining：
  - backward references
  - forward citations
  - saturation criterion
- DOI/PMID/arXiv ID 交叉验证。
- BibTeX 格式校验和 citation key 去重。
- PDF/full-text 获取。
- section-level evidence extraction。
- 更严格的 inclusion/exclusion criteria DSL。
- ASReview-style active screening。
- citation mismatch 检查。
- contradiction clustering。
- PRISMA flow diagram 可视化。

### 未来 Packs

建议新增：

```text
packages/packs/experiment
  - hypothesis generation
  - experimental protocol design
  - variable/control planning
  - statistical analysis plan

packages/packs/algorithm
  - algorithm search space definition
  - baseline selection
  - benchmark planning
  - ablation design

packages/packs/coding
  - code implementation
  - tests
  - patches
  - code review

packages/packs/data
  - dataset acquisition
  - cleaning
  - profiling
  - visualization
```

这些 pack 应复用 Core Runtime 的通用能力：

```text
Session
Agent
Tool
Task
Workflow
Artifact
Provenance
Review
Provider
Strategy
```

避免把领域概念写入 Core。

## 开发命令

```bash
npm install
npm run build
npm test
```

CLI 本地运行：

```bash
node --experimental-sqlite apps/cli/dist/index.js doctor
```

## License

当前仓库未显式声明 License。正式发布前建议补充开源许可证。
