# Research Brief to Literature Review Flow

本文档说明 jiuwen-sci 如何把用户可读的 Research Brief 接入文献调研 pack，并保证偏好可追踪、可审计、可验证。

## 目标

Research Brief 是用户对调研 topic 的增强描述。它不替代主控 Agent 的规划能力，而是把用户明确表达的范围、数据源、机构、证据质量和输出偏好编译成 runtime metadata，供 literature pack 在各阶段使用。

当前实现遵循三个原则：

- 可读：用户可以用 JSON 或简化 YAML 表达需求，不需要直接编写内部 metadata。
- 可溯源：原始 brief、编译后的 metadata、每篇文献的偏好评分都会写成 artifact。
- 可验证：确定性函数负责底线约束，review agent 仍可做语义审查和返工建议。

## 用户输入格式

CLI 支持通过 `--brief <file>` 加载 brief，也支持在交互环境中用 `/brief` 命令维护当前 brief。

示例：

```yaml
topic: AI4S的发展现状和趋势
intent: literature_review
scope:
  include:
    - foundation models
    - autonomous laboratories
  exclude:
    - policy commentary
focus:
  questions:
    - AI for Science foundation models
    - autonomous laboratories
  domains:
    - foundation models
    - scientific discovery
  institutions:
    - DeepMind
sources:
  databases:
    - openalex
    - semantic-scholar
    - arxiv
  preferred_sources:
    - Nature
    - Science
  date_range:
    from: 2020
    to: 2026
evidence:
  requireDoi: true
  requireAbstract: true
  minQuality: Tier 2
  studyTypes:
    - review
    - benchmark
output:
  language: zh
  max_papers: 25
```

## CLI 使用

直接执行一次文献调研：

```bash
jiuwen-sci literature review "AI4S的发展现状和趋势" --brief ai4s.yaml
```

进入交互环境：

```bash
jiuwen-sci
```

常用 brief 命令：

```text
/brief load ai4s.yaml
/brief show
/brief draft AI4S 2020 2026 DeepMind foundation models
请调研 AI4S 的发展现状和趋势
```

在交互环境中，主控模型仍然按需选择 pack。加载 brief 后，CLI 会把 brief 编译进当前请求的 metadata；如果主控判断这是文献调研任务，会调用 literature pack。

## 内部流程

### 1. Brief 编译

CLI 的 `compileBriefMetadata` 会把用户 brief 转换成 runtime metadata：

- `researchBrief`：原始用户 brief。
- `topicProfile`：核心词、领域词、修饰词，用于查询扩展和 topic anchor 检查。
- `sourcePreferences`：数据库、优先来源、排除来源、时间范围、机构、地域、领域偏好。
- `evidencePreferences`：DOI、摘要、最低质量层级、证据类型等要求。
- `outputPreferences`：语言、最大文献数、输出关注点。
- `inclusionCriteria` / `exclusionCriteria`：用户定义的纳入和排除条件。
- `dbs` / `limit` / `workflow`：pack 路由和执行参数。

### 2. Protocol Stage

`protocol_query` 阶段会写出 `research_brief.json`。

该 artifact 冻结三类信息：

- 原始 `researchBrief`。
- 编译后的 metadata 摘要。
- 审计说明，标明它由 `protocol_query` 阶段创建。

对应 verifier：

- `brief_metadata_valid`：如果存在 research brief artifact，必须包含调研问题、原始 brief 和编译后的 topic profile。

同一阶段还会写出 `topic_expansion.json`。它把宽泛 topic 拆成可执行、可验证的结构化扩展：

- `macroConcept` / `macroTerms`：用户问题中的上位概念。
- `facets`：训练、推理、评测、系统组件等子方向。facet 来自 LLM 生成的 query concepts、Research Brief、或 deterministic fallback。
- `systemTerms`：infrastructure、system、platform、training、serving 等系统语义词。
- `institutionTerms`：用户关注的机构，只作为偏好加权和机构覆盖审计，不单独构成 topic anchor。
- `excludeTerms`：用户声明的排除词。

pack 不硬编码具体领域词。比如 AI-Infra 的 `distributed training`、`KV cache`、`RDMA`，应来自 brief、LLM 生成的 `concepts[].keywords`，或运行时 metadata。pack 只解析通用 schema，并把它保存为可审计 artifact。

### 3. Search Stage

`search_dedupe` 使用 metadata 中的 `dbs`、`limit` 和 `topicProfile` 生成查询、fallback 查询和数据库计划。

如果存在 `topic_expansion.json`，search 会按 facet 生成多路可执行查询，而不是只搜索原始大词。不可执行数据库名会被过滤或映射到当前已注册 connector，避免 agent 写出 Google Scholar、IEEE Xplore、ACM Digital Library 后实际无法执行。

`identification.json` 会记录：

- 每个数据源命中数量。
- 数据源错误和 fallback 情况。
- 本次检索应用的偏好摘要。
- 本次使用的 topic expansion artifact id。

### 4. Screening Stage

`screening` 会对每篇去重后的 paper 计算 `PreferenceScore`，并写入 `preference_scores.json`。

评分由四部分组成：

- `topicScore`：题名、摘要、venue 是否命中 topic core/domain/modifier。
- `sourceScore`：是否命中 preferred sources。
- `focusScore`：是否命中用户关注的机构、地域、领域。
- `evidenceScore`：是否具备 DOI、摘要，是否匹配 review、benchmark 等证据类型。

硬排除条件包括：

- 年份不在 `sourcePreferences.dateRange`。
- 命中 `scope.exclude` 或 `exclusionCriteria`。
- `requireDoi` 为 true 但没有 DOI。
- `requireAbstract` 为 true 但没有摘要。
- 命中 `excludedSources`。

topic anchor 使用同一份 `topic_expansion.json`。纳入条件不再只依赖上位词，例如 `AI Infrastructure`；也允许 “facet + system” 组合，例如 `LLM training + infrastructure`、`KV cache + serving systems`。但机构词不能单独触发纳入，`OpenAI`、`ByteDance` 等只会增加偏好分，仍需要命中 topic/facet/system anchor。

`screening_log.json` 中每条 decision 会包含：

- `preferenceScore`
- `preferenceReasons`
- `preferencePenalties`
- `hardExcluded`
- `hardExclusions`
- `briefTrace`

对应 verifier：

- `screening_preferences_complete`：带 brief 时，每条筛选决策必须有偏好评分；被硬排除的 paper 不能被纳入。

### 5. Eligibility and Quality Stage

`eligibility_quality` 会再次执行证据底线检查。这里的逻辑不是 prompt 建议，而是确定性函数约束。

当前底线包括：

- DOI 必需。
- 摘要必需。
- 最低质量 tier。
- screening 阶段的 hard exclusion 不能被绕过。

`evidence_table.json` 的每条 evidence row 会包含：

- `preferenceAlignment`：该证据与 brief 的匹配原因和分项分数。
- `briefTrace`：可回溯到用户 brief 的问题、领域、机构、来源或证据类型。

对应 verifier：

- `eligibility_preferences_enforced`：最终 included studies 不得违反 DOI、摘要和最低质量要求。

### 6. Synthesis Stage

`citation_synthesis_review` 会把偏好影响写入最终 markdown 报告的 `User Preferences` section。

报告会说明：

- 是否存在 structured brief。
- 共有多少 records 被评分。
- 多少 records 被 brief hard filters 排除。
- 时间范围、优先来源、机构、领域、证据底线、输出语言等关键偏好。

最终报告的 `Artifact Index` 会包含：

- `research_brief.json`
- `preference_scores.json`
- `screening_log.json`
- `eligibility_log.json`
- `evidence_table.json`
- `prisma_flow.json`

对应 verifier：

- `synthesis_preferences_reflected`：带 brief 时，最终报告必须包含 `User Preferences`，并引用 `preference_scores.json`。

## 审计路径

一次带 brief 的文献调研可以按以下路径审计：

1. 查看 `research_brief.json`，确认用户原始需求和编译 metadata。
2. 查看 `queries.json` 和 `identification.json`，确认 topic profile、数据库和检索偏好如何影响查询。
3. 查看 `preference_scores.json`，逐篇确认偏好评分和硬排除原因。
4. 查看 `screening_log.json`，确认筛选决策是否和偏好评分一致。
5. 查看 `eligibility_log.json` 与 `quality_assessment.json`，确认 DOI、摘要、最低质量等底线是否被执行。
6. 查看 `evidence_table.json`，确认每条证据如何关联回用户 brief。
7. 查看最终 markdown 的 `User Preferences` 与 `Artifact Index`，确认报告对偏好影响做了显式披露。

## 设计边界

Research Brief 不会把 literature pack 变成 AI4S 专用系统。AI4S 相关词汇只应出现在用户 brief、CLI 输入、测试 fixture 或运行时 metadata 中，不应硬编码在 pack 的通用逻辑里。

pack 只理解通用结构：

- topic terms
- source preferences
- evidence preferences
- output preferences
- inclusion/exclusion criteria

因此同一机制可以复用于实验设计、算法发现、代码调研等任务，只需要对应 pack 定义自己的偏好结构、评分函数和 verifier。
