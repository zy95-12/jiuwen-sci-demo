import { StageContractRunner, type StageContractDefinition, type WorkflowContext, type WorkflowDefinition } from "@jiuwen-sci/core";
import { normalizeLiteratureDatabaseIds } from "../connectors/databases.js";
import { getLiteratureConnectorRegistry } from "../connectors/registry.js";
import { defaultCriteria, protocolPreferenceSummary } from "../protocol/metadata.js";
import { buildQueryPlan, executableQueryPlanFrom, normalizeSelectedQueries, normalizeTopicExpansion, searchQueryGroupsForDb, topicProfileFromQueries } from "../protocol/topic-expansion.js";
import { countTiers, detectContradictions, renderSynthesis } from "../reporting.js";
import { listArtifactsByType, readStageArtifact } from "../runtime/artifacts.js";
import { assessEligibility, preferenceAlignment, scorePaperAgainstBrief, screenPaper, summarizePreferenceScores } from "../screening/preference-score.js";
import { assessQuality } from "../screening/quality.js";
import type { PaperHit, PreferenceScore, TopicExpansion, TopicProfile } from "../types.js";
import { ensureResearchBriefArtifact, searchWithFallback, selectedQueryDbs } from "./helpers.js";

export const literatureReviewWorkflow: WorkflowDefinition = {
  id: "literature-review",
  name: "Literature Review",
  description: "PRISMA-style literature review: multi-database search, screening, eligibility, quality assessment, citation verification, synthesis, and review.",
  defaultStrategy: "workflow_controlled",
  async run(ctx, input) {
    return runLiteratureStageContract(ctx, input.input, input.metadata ?? {});
  }
};

async function runLiteratureStageContract(ctx: WorkflowContext, question: string, metadata: Record<string, unknown>) {
  return new StageContractRunner(ctx.services).run({
    sessionId: ctx.sessionId,
    contractId: literatureReviewStageContract.id,
    userGoal: question,
    metadata
  });
}

export const literatureReviewStageContract: StageContractDefinition = {
  id: "literature-review-prisma-v1",
  name: "Literature Review PRISMA Stage Contract",
  description: "Agent-led PRISMA review contract with deterministic artifact, verifier, and provenance gates.",
  initialStageId: "protocol_query",
  maxStages: 12,
  stages: [
    {
      id: "protocol_query",
      goal: "Define review protocol, searchable concepts, database plan, and inclusion/exclusion criteria.",
      agentId: "literature-query-agent",
      allowedTools: ["artifact_write", "finalize"],
      requiredArtifacts: [{ type: "json", stage: "protocol" }, { type: "json", stage: "queries" }],
      verifiers: ["artifact_requirements_met", "brief_metadata_valid", "literature_protocol_valid", "literature_query_concepts_valid"],
      retryPolicy: { maxAttempts: 2, onFailure: "retry_stage" },
      gate: {
        deterministic: [{ id: "artifact_requirements_met", hardGate: true }, { id: "brief_metadata_valid", hardGate: true }, { id: "literature_protocol_valid", hardGate: true }, { id: "literature_query_concepts_valid", hardGate: true }],
        rules: [
          { when: "hard_gate_failed", action: "retry_stage" },
          { when: "verifier_failed", action: "retry_stage" },
          { when: "passed", action: "next" }
        ]
      },
      next: [{ when: "passed", stageId: "search_dedupe" }],
      run: async (ctx) => {
        const registry = getLiteratureConnectorRegistry(ctx.services);
        const metadataDbs = normalizeLiteratureDatabaseIds(ctx.metadata.dbs, registry);
        const agentProtocol = await readStageArtifact(ctx.services, ctx.artifactIds, "protocol");
        const agentQueries = await readStageArtifact(ctx.services, ctx.artifactIds, "queries");
        if (agentProtocol && agentQueries) {
          const briefArtifact = await ensureResearchBriefArtifact(ctx);
          const agentDbs = normalizeLiteratureDatabaseIds(agentProtocol.databases, registry);
          const queryDbs = normalizeLiteratureDatabaseIds(selectedQueryDbs(agentQueries), registry);
          const dbs = metadataDbs.length ? metadataDbs : agentDbs.length ? agentDbs : queryDbs.length ? queryDbs : ["openalex"];
          const topicExpansion = normalizeTopicExpansion(agentQueries.topicExpansion ?? agentQueries.topic_expansion, ctx.input, ctx.metadata, agentQueries);
          const executableQueryPlan = executableQueryPlanFrom(agentQueries, dbs, topicExpansion);
          const topicProfile = topicProfileFromQueries(executableQueryPlan, ctx.input, ctx.metadata.topicProfile, topicExpansion);
          const expansionArtifact = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify(topicExpansion, null, 2) });
          return { artifactIds: [briefArtifact?.id, expansionArtifact.id].filter(Boolean) as string[], statePatch: { limit: Number(agentProtocol.limit ?? ctx.metadata.limit ?? 25), dbs, criteria: agentProtocol.criteria ?? agentQueries.criteria ?? defaultCriteria(), queryPlan: executableQueryPlan, topicProfile, topicExpansion, researchBriefArtifactId: briefArtifact?.id, topicExpansionArtifactId: expansionArtifact.id } };
        }
        const limit = Number(ctx.metadata.limit ?? 25);
        const dbs = metadataDbs.length ? metadataDbs : ["openalex", "semantic-scholar", "crossref"];
        const criteria = defaultCriteria();
        const topicExpansion = normalizeTopicExpansion(undefined, ctx.input, ctx.metadata);
        const queryPlan = buildQueryPlan(ctx.input, dbs, criteria, ctx.metadata.topicProfile, topicExpansion);
        const briefArtifact = await ensureResearchBriefArtifact(ctx);
        const expansionArtifact = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify(topicExpansion, null, 2) });
        const protocol = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "protocol", question: ctx.input, databases: dbs, limit, criteria, conceptDefinition: queryPlan.conceptDefinition, appliedPreferences: protocolPreferenceSummary(ctx.metadata), workflow: ctx.contract.stages.map((s) => s.id) }, null, 2) });
        const queries = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify(queryPlan, null, 2) });
        return { artifactIds: [briefArtifact?.id, expansionArtifact.id, protocol.id, queries.id].filter(Boolean) as string[], statePatch: { limit, dbs, criteria, queryPlan, topicProfile: topicProfileFromQueries(queryPlan, ctx.input, ctx.metadata.topicProfile, topicExpansion), topicExpansion, researchBriefArtifactId: briefArtifact?.id, topicExpansionArtifactId: expansionArtifact.id, protocolArtifactId: protocol.id, queriesArtifactId: queries.id } };
      }
    },
    {
      id: "search_dedupe",
      goal: "Search selected scholarly databases, preserve source errors, collect citation-chain hints, and deduplicate records.",
      agentId: "literature-search-agent",
      allowedTools: ["science_search", "citation_chain", "paper_deduplicate", "artifact_write", "finalize"],
      requiredArtifacts: [{ type: "json", stage: "identification" }, { type: "json", stage: "deduplication" }],
      verifiers: ["artifact_requirements_met", "literature_search_valid"],
      retryPolicy: { maxAttempts: 2, onFailure: "retry_stage" },
      gate: {
        deterministic: [{ id: "artifact_requirements_met", hardGate: true }, { id: "literature_search_valid", hardGate: true }],
        rules: [
          { when: "verifier_failed:search_invalid", action: "go_to_stage", stageId: "protocol_query" },
          { when: "hard_gate_failed", action: "retry_stage" },
          { when: "verifier_failed", action: "retry_stage" },
          { when: "passed", action: "next" }
        ]
      },
      next: [{ when: "passed", stageId: "screening" }],
      run: async (ctx) => {
        const agentIdentification = await readStageArtifact(ctx.services, ctx.artifactIds, "identification");
        const agentDedupe = await readStageArtifact(ctx.services, ctx.artifactIds, "deduplication");
        if (agentIdentification && agentDedupe) {
          const deduped = (agentDedupe.deduped ?? agentDedupe.papers ?? []) as PaperHit[];
          return { statePatch: { allPapers: deduped, searchCounts: agentIdentification.searchCounts ?? {}, sourceErrors: agentIdentification.sourceErrors ?? [], deduped, duplicates: agentDedupe.duplicates ?? [], recordsIdentifiedThroughCitationChaining: Number(agentIdentification.recordsIdentifiedThroughCitationChaining ?? 0), citationChainHintsFound: Number(agentIdentification.citationChainHintsFound ?? 0) } };
        }
        const registry = getLiteratureConnectorRegistry(ctx.services);
        const metadataDbs = normalizeLiteratureDatabaseIds(ctx.metadata.dbs, registry);
        const dbs = normalizeLiteratureDatabaseIds(ctx.state.dbs, registry, metadataDbs.length ? metadataDbs : ["openalex"]);
        const limit = Number(ctx.state.limit ?? 25);
        const allPapers: PaperHit[] = [];
        const searchArtifactIds: string[] = [];
        const searchCounts: Record<string, number> = {};
        const sourceErrors: any[] = [];
        const queryPlan = ctx.state.queryPlan as any;
        const topicExpansion = (ctx.state.topicExpansion as TopicExpansion | undefined) ?? normalizeTopicExpansion(queryPlan?.topicExpansion ?? queryPlan?.topic_expansion, ctx.input, ctx.metadata, queryPlan);
        const selectedQueries = normalizeSelectedQueries(queryPlan).map((query) => ({
          ...query,
          database: normalizeLiteratureDatabaseIds(query.database, registry)[0] ?? query.database
        }));
        for (const db of dbs) {
          const queryGroups = searchQueryGroupsForDb(db, selectedQueries, topicExpansion, ctx.state.topicProfile as TopicProfile | undefined).slice(0, 5);
          searchCounts[db] = 0;
          for (const group of queryGroups) {
            const { out, artifactIds, errors } = await searchWithFallback(ctx, db, group, Math.max(5, Math.ceil(limit / Math.max(1, queryGroups.length))));
            allPapers.push(...(out.results ?? []));
            searchCounts[db] += out.count ?? 0;
            sourceErrors.push(...errors);
            if (out.ok === false && !errors.includes(out)) sourceErrors.push(out);
            else if (out.error) sourceErrors.push({ db, error: out.error });
            searchArtifactIds.push(...artifactIds);
          }
        }
        const chain = await ctx.tool({ toolId: "citation_chain", input: { papers: allPapers.slice(0, 5), limit: 5 } });
        const citationChainArtifactId = (chain.output as any).artifactId as string;
        const citationChainRecords = (chain.output as any).records ?? [];
        const citationChainHintsFound = citationChainRecords.reduce((sum: number, record: any) => sum + Number(record.referenceCount ?? 0) + Number(record.citationCount ?? 0), 0);
        const recordsIdentifiedThroughCitationChaining = 0;
        if (Array.isArray((chain.output as any).errors)) sourceErrors.push(...(chain.output as any).errors);
        const identification = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "identification", searchCounts, sourceErrors, topicExpansionId: ctx.state.topicExpansionArtifactId, appliedPreferences: protocolPreferenceSummary(ctx.metadata), recordsIdentifiedThroughDatabaseSearching: allPapers.length, recordsIdentifiedThroughCitationChaining, citationChainHintsFound }, null, 2) });
        const dedupe = await ctx.tool({ toolId: "paper_deduplicate", input: { papers: allPapers } });
        const deduped = (dedupe.output as any).papers as PaperHit[];
        const duplicates = (dedupe.output as any).duplicates ?? [];
        const dedupedArtifactId = (dedupe.output as any).artifactId as string;
        return { artifactIds: [...searchArtifactIds, identification.id, citationChainArtifactId, dedupedArtifactId], statePatch: { allPapers, searchCounts, sourceErrors, deduped, duplicates, recordsIdentifiedThroughCitationChaining, citationChainHintsFound, identificationArtifactId: identification.id, citationChainArtifactId, dedupedArtifactId } };
      }
    },
    {
      id: "screening",
      goal: "Screen titles and abstracts using explicit inclusion/exclusion criteria and record a reason for every paper.",
      agentId: "literature-screening-agent",
      allowedTools: ["artifact_read", "artifact_write", "finalize"],
      requiredArtifacts: [{ type: "json", stage: "screening_log" }],
      verifiers: ["artifact_requirements_met", "literature_screening_complete", "literature_screening_topic_anchor_valid", "screening_preferences_complete"],
      retryPolicy: { maxAttempts: 2, onFailure: "retry_stage" },
      gate: {
        deterministic: [{ id: "artifact_requirements_met", hardGate: true }, { id: "literature_screening_complete", hardGate: true }, { id: "literature_screening_topic_anchor_valid", hardGate: true }, { id: "screening_preferences_complete", hardGate: true }],
        semantic: { agentId: "literature-reviewer-agent", mode: "always" },
        rules: [
          { when: "hard_gate_failed", action: "retry_stage" },
          { when: "review_blocking:topic_drift", action: "go_to_stage", stageId: "protocol_query" },
          { when: "review_blocking", action: "retry_stage" },
          { when: "review_major", action: "retry_stage" },
          { when: "passed", action: "next" }
        ]
      },
      next: [{ when: "passed", stageId: "eligibility_quality" }],
      run: async (ctx) => {
        const deduped = (ctx.state.deduped as PaperHit[]) ?? [];
        const agentScreening = await readStageArtifact(ctx.services, ctx.artifactIds, "screening_log");
        const agentScreeningHasScaffold = agentScreening?.decisions?.every((d: any) => typeof d.preferenceScore === "number" && Array.isArray(d.briefTrace) && typeof d.hardExcluded === "boolean");
        if (agentScreening?.decisions && agentScreeningHasScaffold) {
          const screeningDecisions = agentScreening.decisions;
          const screenedIn = screeningDecisions.filter((d: any) => d.decision === "include").map((d: any) => deduped.find((p) => p.id === d.paperId)!).filter(Boolean);
          return { statePatch: { screeningDecisions, screenedIn } };
        }
        const criteria = ctx.state.criteria ?? defaultCriteria();
        const topicExpansion = (ctx.state.topicExpansion as TopicExpansion | undefined) ?? normalizeTopicExpansion((ctx.state.queryPlan as any)?.topicExpansion, ctx.input, ctx.metadata, ctx.state.queryPlan);
        const topicProfile = (ctx.state.topicProfile as TopicProfile | undefined) ?? topicProfileFromQueries(ctx.state.queryPlan, ctx.input, ctx.metadata.topicProfile, topicExpansion);
        const preferenceScores = deduped.map((paper) => scorePaperAgainstBrief(paper, ctx.metadata, topicProfile));
        const scoresById = new Map(preferenceScores.map((score) => [score.paperId, score]));
        const screeningDecisions = deduped.map((paper) => screenPaper(ctx.input, paper, topicProfile, scoresById.get(paper.id)));
        const screenedIn = screeningDecisions.filter((d) => d.decision === "include").map((d) => deduped.find((p) => p.id === d.paperId)!).filter(Boolean);
        const preferenceArtifact = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "preference_scores", summary: summarizePreferenceScores(preferenceScores), scores: preferenceScores }, null, 2) });
        const screeningLog = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "screening_log", criteria, preferenceSummary: summarizePreferenceScores(preferenceScores), decisions: screeningDecisions }, null, 2) });
        return { artifactIds: [preferenceArtifact.id, screeningLog.id], statePatch: { preferenceScores, screeningDecisions, screenedIn, preferenceScoresArtifactId: preferenceArtifact.id, screeningLogArtifactId: screeningLog.id } };
      }
    },
    {
      id: "eligibility_quality",
      goal: "Assess eligibility, assign evidence quality tiers, and extract structured evidence rows.",
      agentId: "literature-eligibility-agent",
      allowedTools: ["artifact_read", "artifact_write", "evidence_table_write", "finalize"],
      requiredArtifacts: [{ type: "json", stage: "eligibility_log" }, { type: "json", stage: "quality_assessment" }, { type: "json", stage: "included_studies" }, { type: "json", stage: "evidence_table" }],
      verifiers: ["artifact_requirements_met", "literature_evidence_complete", "eligibility_preferences_enforced"],
      retryPolicy: { maxAttempts: 2, onFailure: "retry_stage" },
      gate: {
        deterministic: [{ id: "artifact_requirements_met", hardGate: true }, { id: "literature_evidence_complete", hardGate: true }, { id: "eligibility_preferences_enforced", hardGate: true }],
        semantic: { agentId: "literature-reviewer-agent", mode: "always" },
        rules: [
          { when: "hard_gate_failed", action: "retry_stage" },
          { when: "review_blocking:topic_drift", action: "go_to_stage", stageId: "screening" },
          { when: "review_blocking", action: "retry_stage" },
          { when: "review_major", action: "retry_stage" },
          { when: "passed", action: "next" }
        ]
      },
      next: [{ when: "passed", stageId: "citation_synthesis_review" }],
      run: async (ctx) => {
        const screenedIn = (ctx.state.screenedIn as PaperHit[]) ?? [];
        const agentEligibility = await readStageArtifact(ctx.services, ctx.artifactIds, "eligibility_log");
        const agentQuality = await readStageArtifact(ctx.services, ctx.artifactIds, "quality_assessment");
        const agentIncluded = await readStageArtifact(ctx.services, ctx.artifactIds, "included_studies");
        const agentEvidence = await readStageArtifact(ctx.services, ctx.artifactIds, "evidence_table");
        if (agentEligibility && agentQuality && agentIncluded && agentEvidence) {
          const included = (agentIncluded.papers ?? []) as PaperHit[];
          const quality = agentQuality.tiers ?? [];
          const evidenceRows = agentEvidence.rows ?? [];
          return { statePatch: { eligibilityDecisions: agentEligibility.decisions ?? [], included, quality, evidenceRows, contradictions: [] } };
        }
        const limit = Number(ctx.state.limit ?? 25);
        const preferenceScores = (ctx.state.preferenceScores as PreferenceScore[]) ?? [];
        const scoresById = new Map(preferenceScores.map((score) => [score.paperId, score]));
        const qualityById = new Map(screenedIn.map((paper) => [paper.id, assessQuality(paper, ctx.metadata)]));
        const eligibilityDecisions = screenedIn.map((paper) => assessEligibility(paper, ctx.metadata, scoresById.get(paper.id), qualityById.get(paper.id)));
        const included = eligibilityDecisions.filter((d) => d.decision === "include").map((d) => screenedIn.find((p) => p.id === d.paperId)!).filter(Boolean).slice(0, Math.min(25, limit));
        const eligibilityLog = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "eligibility_log", decisions: eligibilityDecisions }, null, 2) });
        const quality = included.map((paper) => qualityById.get(paper.id) ?? assessQuality(paper, ctx.metadata));
        const qualityAssessment = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "quality_assessment", tiers: quality }, null, 2) });
        const includedStudies = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "included_studies", papers: included }, null, 2) });
        const evidenceRows = included.map((paper, index) => ({
          evidenceId: `ev_${index + 1}`,
          paperId: paper.id,
          claim: `${paper.title} provides ${paper.abstract ? "abstract-level" : "metadata-level"} evidence relevant to "${ctx.input}".`,
          supportType: "context",
          quoteOrSummary: paper.abstract?.slice(0, 700) || `${paper.title} (${paper.year ?? "n.d."})`,
          qualityTier: quality.find((q) => q.paperId === paper.id)?.tier ?? "Tier 3",
          preferenceAlignment: preferenceAlignment(scoresById.get(paper.id)),
          briefTrace: scoresById.get(paper.id)?.briefTrace ?? [],
          confidence: paper.abstract ? 0.72 : 0.52
        }));
        const evidence = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "evidence_table", researchQuestion: ctx.input, rows: evidenceRows }, null, 2) });
        const contradictions = detectContradictions(evidenceRows);
        const contradictionArtifact = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "contradiction_detection", contradictions }, null, 2) });
        return { artifactIds: [eligibilityLog.id, qualityAssessment.id, includedStudies.id, evidence.id, contradictionArtifact.id], statePatch: { eligibilityDecisions, included, quality, evidenceRows, contradictions, eligibilityLogArtifactId: eligibilityLog.id, qualityAssessmentArtifactId: qualityAssessment.id, includedStudiesArtifactId: includedStudies.id, evidenceArtifactId: evidence.id, contradictionArtifactId: contradictionArtifact.id } };
      }
    },
    {
      id: "citation_synthesis_review",
      goal: "Verify citations, write BibTeX, produce PRISMA flow, synthesize the report, and run final semantic review.",
      agentId: "literature-synthesis-agent",
      allowedTools: ["citation_verify", "bibtex_write", "prisma_flow_write", "artifact_read", "artifact_write", "finalize"],
      requiredArtifacts: [{ type: "json", stage: "citation_verification" }, { type: "json", stage: "prisma_flow" }, { type: "markdown", minCount: 2 }],
      verifiers: ["artifact_requirements_met", "literature_prisma_counts_valid", "synthesis_preferences_reflected", "no_open_blocking_findings"],
      review: { agentId: "literature-reviewer-agent", mode: "always" },
      retryPolicy: { maxAttempts: 2, onFailure: "retry_stage" },
      gate: {
        deterministic: [
          { id: "artifact_requirements_met", hardGate: true },
          { id: "literature_prisma_counts_valid", hardGate: true },
          { id: "synthesis_preferences_reflected", hardGate: true },
          { id: "no_open_blocking_findings", hardGate: true }
        ],
        semantic: { agentId: "literature-reviewer-agent", mode: "always" },
        rules: [
          { when: "hard_gate_failed", action: "retry_stage" },
          { when: "review_blocking:citation_mismatch", action: "retry_stage" },
          { when: "review_blocking:topic_drift", action: "go_to_stage", stageId: "screening" },
          { when: "review_blocking", action: "retry_stage" },
          { when: "review_major", action: "retry_stage" },
          { when: "passed", action: "next" }
        ]
      },
      run: async (ctx) => {
        const agentCitation = await readStageArtifact(ctx.services, ctx.artifactIds, "citation_verification");
        const agentPrisma = await readStageArtifact(ctx.services, ctx.artifactIds, "prisma_flow");
        const agentMarkdown = await listArtifactsByType(ctx.services, ctx.artifactIds, "markdown");
        if (agentCitation && agentPrisma && agentMarkdown.length >= 2) {
          return { output: `PRISMA-style literature review complete. Final report artifact: ${agentMarkdown.at(-1)?.id}`, statePatch: { prisma: agentPrisma, citationVerification: agentCitation, finalReportArtifactId: agentMarkdown.at(-1)?.id } };
        }
        const allPapers = (ctx.state.allPapers as PaperHit[]) ?? [];
        const deduped = (ctx.state.deduped as PaperHit[]) ?? [];
        const duplicates = (ctx.state.duplicates as any[]) ?? [];
        const screeningDecisions = (ctx.state.screeningDecisions as any[]) ?? [];
        const screenedIn = (ctx.state.screenedIn as PaperHit[]) ?? [];
        const eligibilityDecisions = (ctx.state.eligibilityDecisions as any[]) ?? [];
        const included = (ctx.state.included as PaperHit[]) ?? [];
        const quality = (ctx.state.quality as any[]) ?? [];
        const evidenceRows = (ctx.state.evidenceRows as any[]) ?? [];
        const contradictions = (ctx.state.contradictions as any[]) ?? [];
        const preferenceScores = (ctx.state.preferenceScores as PreferenceScore[]) ?? [];
        const citationVerification = await ctx.tool({ toolId: "citation_verify", input: { papers: included } });
        const citationVerificationArtifactId = (citationVerification.output as any).artifactId as string;
        const bibtex = await ctx.tool({ toolId: "bibtex_write", input: { papers: included } });
        const bibtexArtifactId = (bibtex.output as any).artifactId as string;
        const recordsIdentifiedThroughCitationChaining = Number(ctx.state.recordsIdentifiedThroughCitationChaining ?? 0);
        const citationChainHintsFound = Number(ctx.state.citationChainHintsFound ?? 0);
        const reviewFindingsTree = (await ctx.services.reviewStore.listBySessionTree(ctx.sessionId)).filter((finding) => finding.status === "open");
        const prisma = {
          recordsIdentifiedThroughDatabaseSearching: allPapers.length,
          recordsIdentifiedThroughCitationChaining,
          citationChainHintsFound,
          totalRecordsIdentified: allPapers.length + recordsIdentifiedThroughCitationChaining,
          duplicateRecordsRemoved: duplicates.length,
          recordsAfterDeduplication: deduped.length,
          recordsScreened: deduped.length,
          recordsExcludedTitleAbstract: screeningDecisions.filter((d) => d.decision === "exclude").length,
          fullTextOrAbstractRecordsAssessed: screenedIn.length,
          recordsExcludedEligibility: eligibilityDecisions.filter((d) => d.decision === "exclude").length,
          studiesIncludedInSynthesis: included.length,
          tierCounts: countTiers(quality)
        };
        const prismaFlow = await ctx.tool({ toolId: "prisma_flow_write", input: prisma });
        const prismaFlowArtifactId = (prismaFlow.output as any).artifactId as string;
        const synthesisText = renderSynthesis(ctx.input, included, evidenceRows, quality, contradictions, prisma, ctx.metadata, preferenceScores);
        const synthesis = await ctx.createArtifact({ type: "markdown", mediaType: "text/markdown", content: synthesisText });
        const reviewFindings = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "review_findings", findings: reviewFindingsTree, summary: reviewFindingsTree.length ? "Open review findings from the session tree are listed here and must be resolved or accepted before treating the report as final." : "No open review findings were present before final semantic review." }, null, 2) });
        const finalReport = await ctx.createArtifact({ type: "markdown", mediaType: "text/markdown", content: `${synthesisText}\n\n## Artifact Index\n\n- research_brief.json: ${ctx.state.researchBriefArtifactId ?? "not provided"}\n- protocol.json: ${ctx.state.protocolArtifactId}\n- queries.json: ${ctx.state.queriesArtifactId}\n- identification.json: ${ctx.state.identificationArtifactId}\n- citation_chaining.json: ${ctx.state.citationChainArtifactId}\n- deduped_papers.json: ${ctx.state.dedupedArtifactId}\n- preference_scores.json: ${ctx.state.preferenceScoresArtifactId ?? "not generated"}\n- screening_log.json: ${ctx.state.screeningLogArtifactId}\n- eligibility_log.json: ${ctx.state.eligibilityLogArtifactId}\n- quality_assessment.json: ${ctx.state.qualityAssessmentArtifactId}\n- included_studies.json: ${ctx.state.includedStudiesArtifactId}\n- evidence_table.json: ${ctx.state.evidenceArtifactId}\n- contradiction_detection.json: ${ctx.state.contradictionArtifactId}\n- citation_verification.json: ${citationVerificationArtifactId}\n- bibtex.bib: ${bibtexArtifactId}\n- prisma_flow.json: ${prismaFlowArtifactId}\n- review_findings.json: ${reviewFindings.id}\n` });
        await ctx.recordProvenance({
          nodes: [
            { type: "artifact", refId: finalReport.id, label: "final_report.md" },
            { type: "artifact", refId: synthesis.id, label: "synthesis.md" },
            ...(ctx.state.researchBriefArtifactId ? [{ type: "artifact", refId: String(ctx.state.researchBriefArtifactId), label: "research_brief.json" }] : []),
            ...(ctx.state.preferenceScoresArtifactId ? [{ type: "artifact", refId: String(ctx.state.preferenceScoresArtifactId), label: "preference_scores.json" }] : []),
            { type: "artifact", refId: String(ctx.state.evidenceArtifactId), label: "evidence_table.json" },
            { type: "artifact", refId: prismaFlowArtifactId, label: "prisma_flow.json" },
            ...included.map((paper) => ({ type: "source", refId: paper.id, label: paper.title, metadata: { doi: paper.doi, url: paper.url, sourceDb: paper.sourceDb } })),
            ...evidenceRows.map((row) => ({ type: "claim", refId: row.evidenceId, label: row.claim, metadata: { paperId: row.paperId, qualityTier: row.qualityTier } }))
          ],
          edges: [
            { type: "derived_from", fromRef: synthesis.id, toRef: finalReport.id },
            ...(ctx.state.researchBriefArtifactId ? [{ type: "constrains", fromRef: String(ctx.state.researchBriefArtifactId), toRef: String(ctx.state.preferenceScoresArtifactId ?? synthesis.id) }] : []),
            ...(ctx.state.preferenceScoresArtifactId ? [{ type: "constrains", fromRef: String(ctx.state.preferenceScoresArtifactId), toRef: String(ctx.state.evidenceArtifactId) }] : []),
            { type: "derived_from", fromRef: String(ctx.state.evidenceArtifactId), toRef: synthesis.id },
            { type: "derived_from", fromRef: prismaFlowArtifactId, toRef: finalReport.id },
            ...evidenceRows.map((row) => ({ type: "supports", fromRef: row.paperId, toRef: row.evidenceId })),
            ...evidenceRows.map((row) => ({ type: "supports", fromRef: row.evidenceId, toRef: synthesis.id }))
          ]
        });
        return { output: `PRISMA-style literature review complete. Final report artifact: ${finalReport.id}`, artifactIds: [citationVerificationArtifactId, bibtexArtifactId, prismaFlowArtifactId, synthesis.id, reviewFindings.id, finalReport.id], statePatch: { prisma, citationVerificationArtifactId, bibtexArtifactId, prismaFlowArtifactId, synthesisArtifactId: synthesis.id, reviewFindingsArtifactId: reviewFindings.id, finalReportArtifactId: finalReport.id } };
      }
    }
  ]
};
