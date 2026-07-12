# jiuwen-sci

`jiuwen-sci` 是一个 CLI-first、local-first 的通用科研 Agent 平台。它的目标不是只做文献调研，而是提供一个可扩展的科研 Agent Runtime，让文献调研、实验设计、算法发现、代码编写、数据分析、论文写作等能力都能通过独立 capability pack 接入。

当前版本已经实现通用 Runtime、交互式 CLI、pack 自动选择、StageSpec 驱动的 workflow 约束与验证，以及 `literature` pack 的 PRISMA-style 文献调研闭环。

## 项目定位

- **通用科研 Agent 平台**：Core Runtime 不写入具体学科知识；领域能力通过 pack 提供。
- **主控 Agent + Capability Pack**：用户只输入研究目标，Runtime/主控路由按需选择合适 pack。
- **CLI-first**：支持 `jiuwen-sci` 进入交互式命令行，也支持脚本化 `exec` 和显式 workflow 命令。
- **Local-first**：Session、tool call、artifact、review finding、provenance 默认保存在本地 `.jiuwen-sci/`。
- **Artifact-first**：协议、检索结果、筛选表、证据表、PRISMA flow、最终报告都落成 artifact，便于追踪和复核。
- **Verifier-oriented**：Workflow 不再承担“硬编码流程控制”的全部责任，而是作为约束和验证框架；每个 stage 由 deterministic verifier 与 review agent 共同决定是否通过、返工或跳转。
- **Honest quality boundary**：当前文献调研重点打通可追溯、可审计的执行闭环；自动生成的最终报告还不能直接等同于可发表或可决策的高质量综述。

## 架构设计

整体结构：

```text
CLI / REPL
  -> RuntimeHost
     -> PackWorkflowSelector
     -> ExecutionEngine
        -> StrategySelector / RuntimeGuard
        -> Runner
           - direct
           - retry
           - critic_revise
           - workflow_controlled
        -> AgentSessionRunner / WorkflowRunner / StageContractRunner
     -> ToolRuntime
     -> Stores
        - SessionStore
        - MessageStore
        - ToolCallStore
        - ArtifactStore
        - ProvenanceStore
        - ReviewStore
     -> Capability Packs
        - literature
        - future: experiment / algorithm / coding / data
```

核心抽象：

- **RuntimeHost**：启动 runtime，注册 agents/tools/reviewers/packs，执行任务或恢复 session。
- **ExecutionEngine**：根据 strategy 调用对应 runner。
- **PackWorkflowSelector**：根据用户目标和已注册 pack 的 workflow catalog 选择合适 workflow。
- **StageSpec**：定义一个 stage 的目标、agent、允许工具、必需 artifact、verifier、gate 策略和下一阶段。
- **Verifier**：执行确定性检查，例如 artifact 是否齐全、PRISMA 计数是否一致、筛选是否覆盖所有记录。
- **Review Agent**：执行 LLM-based 语义检查，例如主题漂移、证据不足、引用不一致。
- **Capability Pack**：领域能力包，包含 agents、tools、workflows、stage contracts、verifiers 和可选激活逻辑。

目录结构：

```text
jiuwen-sci/
├── apps/
│   └── cli/                    # jiuwen-sci CLI / REPL
├── core/                       # 通用 Agent Runtime
├── packages/
│   └── packs/
│       └── literature/         # PRISMA-style 文献调研 pack
├── tests/                      # node:test 集成测试
├── .jiuwen-sci/                # 本地 runtime 数据，已 gitignore
│   ├── runtime.db
│   ├── artifacts/
│   ├── logs/
│   └── cache/
└── jiuwen-sci-phase1-design.md # 第一阶段设计文档
```

## 当前已实现功能

### CLI

- `jiuwen-sci` 无参数进入交互式 REPL。
- 在 REPL 中直接输入研究目标，Runtime 会按需选择 pack。
- 支持基础 slash commands：
  - `/help`
  - `/status`
  - `/model`
  - `/packs`
  - `/brief show|load|save|clear|new|draft`
  - `/sessions [n]`
  - `/session [id]`
  - `/tree [id]`
  - `/artifacts [id|last]`
  - `/artifact <id>`
  - `/review [id]`
  - `/exit`
- 支持 `exec`、`resume`、`doctor`、`session`、`artifact`、`review`、`pack`、`literature review` 等非交互命令。
- 支持用户可读的 Research Brief，通过 `--brief <file>` 或 REPL `/brief` 命令增强当前 topic。
- CLI 会在需要时自动用 `--experimental-sqlite` 重启自身，用户不需要手动记住 Node 参数。

### Core Runtime

- RuntimeHost 生命周期管理。
- Agent / Tool / Reviewer / Pack Registry。
- SQLite-backed stores：
  - sessions
  - messages
  - tool calls
  - strategy records
  - artifacts metadata
  - provenance graph
  - review findings
- Filesystem ArtifactStore：
  - artifact 内容按 sha256 存储在 `.jiuwen-sci/artifacts/`
  - SQLite 保存索引、hash、media type 和创建来源
- ToolRuntime：
  - 工具输入 schema 校验
  - 工具调用记录
  - 工具创建 artifact
  - 工具记录 provenance
- Task Tool：
  - 子 Agent 通过 child session 执行
  - 支持 parent/child session tree
- Execution strategies：
  - `direct`
  - `retry`
  - `critic_revise`
  - `workflow_controlled`
- Pack workflow 自动选择：
  - 用户输入“调研/文献/论文/综述”等目标时会路由到 `literature-review`
  - selector 优先使用启发式，高置信度不足时可请求模型选择
- Provider：
  - mock provider，用于离线测试
  - OpenAI-compatible provider
  - Volcengine Ark Coding Plan fallback
  - 已适配 `volcengine:glm-5.2`

### Stage Contract / Verifier

- StageSpec 支持：
  - stage id / goal
  - stage agent
  - allowed tools
  - required artifacts
  - deterministic verifiers
  - semantic review agent
  - retry policy
  - gate rules
  - stage transitions
- Gate 支持：
  - hard gate failed -> retry
  - verifier failed -> retry or jump
  - review blocking -> retry or jump
  - review major/high -> retry
  - passed -> next stage
- Verifier 和 review agent 共同作用：
  - 函数检查提供底线和结构化信号
  - LLM review 基于 artifact 与函数检查结果做语义判断

### Literature Pack

`packages/packs/literature` 已实现 PRISMA-style 文献调研流程。

当前 stage：

1. `protocol_query`
   - 生成 research question、concepts、database plan、queries、IC/EC criteria。
2. `search_dedupe`
   - 多数据库检索、source error 记录、citation-chain hints、去重。
3. `screening`
   - title/abstract screening，记录每篇文献 include/exclude/uncertain 和理由。
4. `eligibility_quality`
   - eligibility assessment、quality tier、included studies、evidence table。
5. `citation_synthesis_review`
   - citation verification、BibTeX、PRISMA flow、final report、review findings。

每个 stage 都会产生结构化 artifact，并由 verifier/review agent 记录通过、返工或失败原因。完整审计说明见 [docs/literature-prisma-audit.md](docs/literature-prisma-audit.md)。

已注册数据源 connector：

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

典型 artifact：

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

PRISMA 审计链路：

```text
protocol.json / queries.json
  -> search_results.json / search_error.json
  -> identification.json
  -> citation_chaining.json
  -> deduped_papers.json
  -> preference_scores.json
  -> screening_log.json
  -> eligibility_log.json / quality_assessment.json
  -> included_studies.json / evidence_table.json
  -> contradiction_detection.json
  -> citation_verification.json / bibtex.bib
  -> prisma_flow.json
  -> review_findings.json
  -> final_report.md
```

这条链路保证“报告从哪些检索、哪些筛选、哪些证据来”可以被追踪和复核。它不保证最终报告已经达到专家可用质量；主题扩展、查询约束、语义筛选、证据分级和综合写作仍需要继续加强。

已实现的可靠性改进：

- 数据库名归一化：模型可输出 `OpenAlex`、`Semantic Scholar` 或对象形式，执行前会映射到已注册 connector id。
- 不支持的数据源过滤：例如 Scopus、Web of Science 不会进入执行调用，除非未来注册对应 connector。
- arXiv 查询韧性：
  - arXiv 使用短 query profile
  - 复杂布尔查询会转换为 `all:"term"` 风格
  - arXiv 专用 timeout / retry / backoff
  - retryable source error 会触发 fallback query
- topic profile 泛化：
  - literature pack 不硬编码 AI4S 领域词
  - 领域词应来自用户问题、protocol artifact、主控 Agent 或 `metadata.topicProfile`

### Research Brief

Research Brief 是面向用户的可读 topic 增强配置。用户不需要直接理解 runtime metadata，可以用 JSON 或简化 YAML 描述调研范围、关注问题、数据库偏好、机构偏好、证据类型和输出要求。CLI 会把它编译成 runtime metadata，例如 `topicProfile`、`dbs`、`limit`、`sourcePreferences`、`evidencePreferences` 和 `outputPreferences`。

示例：

```yaml
topic: AI4S的发展现状和趋势
intent: literature_review
scope:
  include:
    - AI4S
    - AI for Science
    - scientific discovery
  exclude:
    - news articles
focus:
  questions:
    - AI4S 当前发展阶段是什么？
    - 未来 3-5 年趋势是什么？
  domains:
    - materials discovery
    - drug discovery
  institutions:
    - DeepMind
    - 清华
sources:
  databases:
    - openalex
    - arxiv
    - semantic-scholar
    - crossref
  date_range:
    from: 2020
    to: 2026
evidence:
  study_types:
    - review
    - survey
    - benchmark
  require_abstract: true
output:
  language: zh
  format: report
  depth: deep
  max_papers: 30
```

## 安装

环境要求：

- Node.js 22+
- npm 11+

安装：

```bash
git clone https://github.com/zy95-12/jiuwen-sci-demo.git
cd jiuwen-sci-demo
npm install
npm run build
```

验证：

```bash
npm test
```

## 配置

### Mock 模型

Mock provider 可离线运行：

```bash
jiuwen-sci --model mock:deterministic doctor
```

如果未安装 bin，可使用：

```bash
node apps/cli/dist/index.js --model mock:deterministic doctor
```

### 火山引擎 GLM 5.2

推荐使用环境变量，不要把 API key 写入仓库：

```bash
export OPENAI_API_KEY="your_api_key"
export OPENAI_BASE_URL="https://ark.cn-beijing.volces.com/api/coding/v3"
```

运行：

```bash
jiuwen-sci --model volcengine:glm-5.2 doctor
```

本地开发时也支持从 `/root/.ark-helper/config.yaml` 读取 fallback key。该文件不属于本仓库，不应提交。

## 使用方法

### 交互式使用

进入 CLI：

```bash
jiuwen-sci --model volcengine:glm-5.2
```

输入研究目标：

```text
jiuwen-sci> 请调研 AI4S 的发展现状和趋势
```

查看最近任务：

```text
jiuwen-sci> /sessions 5
jiuwen-sci> /brief draft AI4S 2020 2026 DeepMind 清华 发展趋势
jiuwen-sci> /brief show
jiuwen-sci> /tree
jiuwen-sci> /artifacts last
jiuwen-sci> /artifact <artifact-id>
jiuwen-sci> /exit
```

### 单轮自动执行

```bash
jiuwen-sci --model volcengine:glm-5.2 \
  "请调研 AI agents for scientific discovery 的文献"
```

这会走 `strategy:auto`，由 Runtime 判断是否选择 `literature-review` workflow。

### 显式执行文献调研

```bash
jiuwen-sci --model volcengine:glm-5.2 \
  literature review "AI4S 的发展现状和趋势" \
  --brief ai4s.yaml \
  --db openalex,arxiv,semantic-scholar,crossref,pubmed,europepmc \
  --limit 20 \
  --max-review-rounds 2
```

快速本地验证：

```bash
jiuwen-sci --model mock:deterministic \
  literature review "AI agents for scientific discovery" \
  --db openalex \
  --limit 2
```

### 查看历史和产物

```bash
jiuwen-sci session list
jiuwen-sci session show <session-id>
jiuwen-sci session tree <session-id>

jiuwen-sci artifact list --session <session-id>
jiuwen-sci artifact cat <artifact-id>

jiuwen-sci review list --session <session-id>
jiuwen-sci provenance trace <artifact-or-node-id>
```

### 后台执行长任务

长任务建议用 `systemd-run`，避免 SSH 断开后进程被回收：

```bash
run_id="ai4s-$(date +%Y%m%d-%H%M%S)"
unit="jiuwen-${run_id}"
log="/root/jiuwen-sci/.jiuwen-sci/logs/${run_id}.log"

systemd-run --unit="$unit" --working-directory=/root/jiuwen-sci \
  /bin/bash -lc "node apps/cli/dist/index.js --model volcengine:glm-5.2 --verbose literature review 'AI4S的发展现状和趋势' --db openalex,arxiv,semantic-scholar,crossref,pubmed,europepmc --limit 20 --max-review-rounds 2 > '$log' 2>&1; code=\$?; echo EXIT_CODE=\$code >> '$log'; exit \$code"
```

监控：

```bash
systemctl status "$unit" --no-pager
tail -f "$log"
```

## 安全说明

不要提交任何真实 API key。

已 gitignore：

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

## 当前限制

- 当前文献调研是 PRISMA-style 的可追溯执行闭环，不等同于生产级系统综述。
- 自动报告与“最终可用的调研报告”仍有明显差距：主题漂移、低相关论文误纳入、证据深度不足、综合分析模板化等问题仍会出现。
- 对 AI4S、AI-Infra 这类宽泛主题，topic expansion 可能把领域词扩得过宽；如果 query 和 screening 没有强制“双锚点”（如 AI 方法 + 科学场景），会召回普通科学领域论文。
- Preference scoring 当前仍可能过度奖励领域词命中，不能完全替代语义相关性判断。
- Full-text/PDF 下载和 section-level evidence extraction 尚未实现。
- Citation chaining 已有 hints 和部分 fetch，但还没有完整的 saturation strategy。
- Semantic Scholar 未配置 API key 时容易被 429 限流。
- Reviewer 已能参与 gate，但对主题漂移、claim-level audit、统计数字校验、图表/表格校验仍需增强。
- 当前没有 Web UI。
- 当前没有 notebook/Python kernel、远程 GPU/SLURM、实验调度能力。

## 后续计划

### Runtime

- 更完整的配置系统与 `config get/set`。
- 更细粒度的权限与 sandbox。
- JSONL event stream 和更完善的后台任务管理。
- session resume 的多轮上下文策略。
- provenance graph 查询增强。
- review finding resolution / accepted risk 工作流。

### Literature Pack

- PDF/full-text 获取。
- section-level evidence extraction。
- DOI/PMID/arXiv ID 交叉验证。
- citation graph 深度扩展和 saturation criterion。
- ASReview-style active screening。
- contradiction clustering。
- 更强的 final synthesis 结构化综述。
- PRISMA flow diagram 可视化。

### Future Packs

计划新增：

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

这些 pack 应复用 Core Runtime 的通用抽象，避免把领域概念写入 Core。

## 开发命令

```bash
npm install
npm run build
npm test
```

本地 CLI：

```bash
node apps/cli/dist/index.js doctor
node apps/cli/dist/index.js --model mock:deterministic
```

## License

当前仓库未显式声明 License。正式发布前建议补充开源许可证。
