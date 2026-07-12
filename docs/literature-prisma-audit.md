# Literature PRISMA Audit Flow

本文档说明 `literature` pack 在 PRISMA-style 文献调研中如何做到可追溯、可审计，以及当前自动报告和真正可用调研报告之间的差距。

## 定位

当前实现的目标是先打通一条完整、可复核的文献调研执行链路：

- 每个阶段都有明确输入、输出和 gate。
- 每个关键中间结果都会落成 artifact。
- deterministic verifier 负责结构和底线检查。
- review agent 负责语义风险检查。
- session、tool call、artifact、review finding 和 provenance 默认保存在本地 `.jiuwen-sci/`。

这不等价于生产级系统综述。当前最终报告可作为调研草稿和审计样本，但不能直接视为专家级、可发表或可决策的最终结论。

## Stage Flow

文献调研 workflow 当前由以下 stage 组成：

```text
protocol_query
  -> search_dedupe
  -> screening
  -> eligibility_quality
  -> citation_synthesis_review
```

### 1. protocol_query

目标：

- 明确 research question。
- 生成 protocol、queries、topic expansion。
- 编译用户 Research Brief 和 runtime metadata。

典型 artifact：

- `research_brief.json`
- `protocol.json`
- `queries.json`
- `topic_expansion.json`
- `verifier_report.json`

审计重点：

- 用户原始需求是否被保留。
- topic expansion 是否来自用户输入、brief、LLM 规划或 deterministic fallback。
- 数据库计划和 inclusion/exclusion criteria 是否可读。

### 2. search_dedupe

目标：

- 按数据库和 facet 执行检索。
- 记录数据源错误、fallback query 和 citation-chain hints。
- 对检索结果去重。

典型 artifact：

- `search_results.json`
- `search_error.json`
- `citation_chaining.json`
- `identification.json`
- `deduped_papers.json`
- `verifier_report.json`

审计重点：

- 每个数据库实际命中了多少记录。
- 哪些数据库发生限流、超时或不支持。
- fallback query 是否被触发。
- PRISMA 的 identification 和 deduplication 数字是否能对上。

### 3. screening

目标：

- 对去重后的 title/abstract 记录做筛选。
- 写出每篇文献的 include/exclude/uncertain 决策和原因。
- 计算 preference score 和 hard exclusion。

典型 artifact：

- `preference_scores.json`
- `screening_log.json`
- `verifier_report.json`

审计重点：

- 每篇记录是否都有筛选决策。
- 被纳入论文是否满足 topic anchor。
- Research Brief 中的日期、来源、机构、证据偏好是否影响了评分或硬排除。
- 是否存在“只命中领域词，但没有命中 AI/方法/科学发现 anchor”的误纳入。

### 4. eligibility_quality

目标：

- 进一步执行 eligibility assessment。
- 分配 quality tier。
- 生成 included studies 和 evidence table。

典型 artifact：

- `eligibility_log.json`
- `quality_assessment.json`
- `included_studies.json`
- `evidence_table.json`
- `contradiction_detection.json`
- `verifier_report.json`

审计重点：

- screening 阶段 hard-excluded 的记录不能重新进入 included studies。
- DOI、abstract、最低质量 tier 等底线是否被执行。
- evidence row 是否能追溯到具体 paper。
- quality tier 是否只是 metadata 粗分，还是有足够证据支撑。

### 5. citation_synthesis_review

目标：

- 执行 citation verification。
- 输出 BibTeX、PRISMA flow 和最终报告。
- 汇总 review findings。

典型 artifact：

- `citation_verification.json`
- `bibtex.bib`
- `prisma_flow.json`
- `review_findings.json`
- `final_report.md`
- `verifier_report.json`

审计重点：

- 引用 metadata 是否可验证。
- PRISMA 数字是否来自前序 artifact。
- final report 的 Artifact Index 是否指向关键 artifact。
- review findings 是否为空；如果为空，也需要人工抽查是否漏检主题漂移。

## PRISMA Artifact Chain

一次完整运行可以按下面顺序复核：

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

常用命令：

```bash
jiuwen-sci session tree <session-id>
jiuwen-sci artifact list --session <session-id>
jiuwen-sci artifact cat <artifact-id>
jiuwen-sci review list --session <session-id>
jiuwen-sci provenance trace <artifact-or-node-id>
```

## Verifier and Review Gate

每个 stage 的通过与否由两类检查共同决定：

- deterministic verifier：检查 artifact 是否存在、PRISMA 计数是否一致、筛选是否覆盖所有记录、hard exclusion 是否被执行。
- review agent：检查语义风险，例如主题漂移、证据不足、引用不一致、报告是否遗漏重要限制。

函数检查的结果会写入 `verifier_report.json`，并作为 review agent 的上下文。review agent 产生的 finding 会进入 `review_findings`，stage gate 再根据 severity 和 rules 决定通过、重试、跳转或返回 partial。

已修复的 retry 语义：

- 如果 reviewer agent 在某一次 attempt 中因为工具参数错误等执行层问题失败，会记录 `stage_review_failed`。
- 后续 attempt 中 reviewer 成功完成时，旧的 transient `stage_review_failed` 会被标记为 `resolved`，避免污染当前 gate。
- 真正的语义 finding 仍会保留，并继续影响 gate。

## Current Quality Gap

当前系统已经能完整跑完 PRISMA-style 流程，但自动报告距离“最终可用的调研报告”仍有明显差距。

已观察到的问题：

- 宽泛主题容易产生过宽 topic expansion。比如 AI4S 可能扩展出 materials science、astronomy、climate science 等领域词。
- 如果 query 没有强制“AI 方法 + 科学场景”双锚点，会召回普通科学领域论文。
- preference scoring 仍可能过度奖励领域词命中，把“材料科学论文”误判为“AI4S 论文”。
- screening hard gate 还不够强，低相关记录可能通过 title/abstract screening。
- review agent 可能漏检主题漂移，`review_findings.json` 为空不代表报告质量已经可靠。
- 证据主要来自 title/abstract metadata，缺少 full-text、section-level evidence 和人工质量评价。
- 最终 synthesis 仍偏模板化，不能替代专家综述中的概念框架、发展脉络、方法谱系和趋势判断。

因此当前结果应被视为：

- 可追溯的调研草稿。
- 系统执行链路和 artifact 审计样本。
- 后续人工或更强 agent 继续筛选、精读、综合的输入。

不应被视为：

- 可直接发表的系统综述。
- 可直接支撑重大决策的最终报告。
- 对复杂领域现状和趋势的充分专家判断。

## Near-Term Improvements

优先改进方向：

- Query construction：对 AI4S、AI-Infra 等宽泛主题强制使用双锚点或多锚点。
- Screening verifier：检查 included papers 是否同时满足核心概念和领域/方法约束。
- Preference scoring：降低单纯领域词命中的权重，提高核心概念和语义相关性要求。
- Review agent：增加主题漂移、代表性不足、低相关证据误纳入的检查清单。
- Data sources：为 Semantic Scholar 等连接器支持 API key/backoff；补强 PubMed、Europe PMC、publisher metadata。
- Evidence extraction：增加 PDF/full-text 获取和 section-level evidence extraction。
- Synthesis：从 evidence table 生成更强的概念框架、时间线、方法分类、机构/数据源覆盖和趋势判断。
