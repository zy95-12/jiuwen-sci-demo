import type { StageVerifierDefinition } from "@jiuwen-sci/core";
import { normalizeSelectedQueries, normalizeTopicExpansion, topicProfileFromQueries } from "./protocol/topic-expansion.js";
import { listArtifactsByType, readStageArtifact } from "./runtime/artifacts.js";
import { meetsMinQuality, topicAnchorScore } from "./screening/preference-score.js";
import type { PaperHit } from "./types.js";
import { conceptTermsOf, normalizeText, termsOf, uniqueQueries } from "./utils/text.js";

export const literatureStageVerifiers: StageVerifierDefinition[] = [
  {
    id: "brief_metadata_valid",
    description: "Validate that a compiled user research brief is captured as an auditable artifact when provided.",
    async verify(ctx) {
      const brief = await readStageArtifact(ctx.services, ctx.artifactIds, "research_brief");
      if (!brief) return { ok: true, message: "No research brief artifact was required or provided." };
      const ok = Boolean(brief.researchQuestion && brief.researchBrief && brief.compiledMetadata?.topicProfile);
      return ok ? { ok: true, message: "Research brief metadata is captured." } : { ok: false, message: "Research brief artifact is missing question, original brief, or compiled topic profile.", severity: "major", category: "brief_metadata_invalid" };
    }
  },
  {
    id: "literature_protocol_valid",
    description: "Validate literature protocol and query-plan artifacts.",
    async verify(ctx) {
      const protocol = await readStageArtifact(ctx.services, ctx.artifactIds, "protocol");
      const queries = await readStageArtifact(ctx.services, ctx.artifactIds, "queries");
      const selectedQueries = normalizeSelectedQueries(queries);
      const ok = Boolean(getQuestion(protocol) && normalizeDatabases(protocol).length && selectedQueries.length && selectedQueries.every((q) => q.database && q.query));
      return ok ? { ok: true, message: "Protocol and query plan are valid." } : { ok: false, message: "Protocol or query plan is missing required question/database/query fields.", severity: "major", category: "protocol_invalid" };
    }
  },
  {
    id: "literature_query_concepts_valid",
    description: "Validate concept grounding and expanded scholarly queries.",
    async verify(ctx) {
      const queries = await readStageArtifact(ctx.services, ctx.artifactIds, "queries");
      const coreTerms = termsOf(queries?.coreTerms);
      const selectedQueries = normalizeSelectedQueries(queries);
      const conceptTerms = conceptTermsOf(queries?.concepts);
      const expansion = normalizeTopicExpansion(queries?.topicExpansion ?? queries?.topic_expansion, getQuestion(queries) ?? "", {}, queries);
      const expansionTerms = uniqueQueries([...expansion.macroTerms, ...expansion.facets.flatMap((facet) => [...facet.requiredTerms, ...facet.terms])]);
      const hasDefinition = Boolean(queries?.conceptDefinition?.definition || queries?.concept_definition?.definition || conceptTerms.length || expansion.facets.length);
      const hasCore = coreTerms.length >= 3 || termsOf(conceptTerms).length >= 3 || expansionTerms.length >= 3;
      const hasUsableQuery = selectedQueries.some((q: any) => String(q.query ?? "").trim().length >= 3);
      const rawQuestion = getQuestion(queries);
      const notOnlyRawQuestion = selectedQueries.some((q: any) => normalizeText(String(q.query ?? "")) !== normalizeText(String(rawQuestion ?? "")));
      const ok = hasDefinition && hasCore && hasUsableQuery && notOnlyRawQuestion;
      return ok ? { ok: true, message: "Query concept grounding and expansion are valid." } : { ok: false, message: "Query plan lacks concept grounding or expanded scholarly queries.", severity: "blocking", category: "query_concepts_invalid" };
    }
  },
  {
    id: "literature_search_valid",
    description: "Validate search and deduplication outputs.",
    async verify(ctx) {
      const identification = await readStageArtifact(ctx.services, ctx.artifactIds, "identification");
      const dedupe = await readStageArtifact(ctx.services, ctx.artifactIds, "deduplication");
      const records = Number(identification?.recordsIdentifiedThroughDatabaseSearching ?? -1);
      const after = Number(dedupe?.recordsAfter ?? -1);
      const ok = records >= 0 && after >= 0 && after <= records;
      return ok ? { ok: true, message: "Search and deduplication outputs are count-consistent." } : { ok: false, message: "Search/deduplication counts are missing or inconsistent.", severity: "major", category: "search_invalid" };
    }
  },
  {
    id: "literature_screening_complete",
    description: "Validate that every deduplicated record has a screening decision and reason.",
    async verify(ctx) {
      const dedupe = await readStageArtifact(ctx.services, ctx.artifactIds, "deduplication");
      const screening = await readStageArtifact(ctx.services, ctx.artifactIds, "screening_log");
      const papers = dedupe?.deduped ?? [];
      const decisions = screening?.decisions ?? [];
      const complete = Array.isArray(papers) && Array.isArray(decisions) && decisions.length === papers.length && decisions.every((d: any) => d.paperId && ["include", "exclude", "uncertain"].includes(d.decision) && d.reason);
      return complete ? { ok: true, message: "Screening decisions are complete." } : { ok: false, message: "Screening log does not contain a valid decision and reason for every deduplicated record.", severity: "major", category: "screening_incomplete" };
    }
  },
  {
    id: "literature_screening_topic_anchor_valid",
    description: "Validate that included studies match topic anchors, not only trend modifiers.",
    async verify(ctx) {
      const dedupe = await readStageArtifact(ctx.services, ctx.artifactIds, "deduplication");
      const screening = await readStageArtifact(ctx.services, ctx.artifactIds, "screening_log");
      const queries = await readStageArtifact(ctx.services, ctx.artifactIds, "queries");
      const expansion = await readStageArtifact(ctx.services, ctx.artifactIds, "topic_expansion");
      const brief = await readStageArtifact(ctx.services, ctx.artifactIds, "research_brief");
      const topicProfile = topicProfileFromQueries(queries, brief?.researchQuestion ?? "", brief?.compiledMetadata?.topicProfile, expansion);
      const papers: PaperHit[] = dedupe?.deduped ?? [];
      const decisions = screening?.decisions ?? [];
      const included = decisions.filter((d: any) => d.decision === "include");
      const weak = included.filter((d: any) => {
        const paper = papers.find((p) => p.id === d.paperId);
        return !paper || !topicAnchorScore(paper, topicProfile).anchored;
      });
      return weak.length === 0
        ? { ok: true, message: "Included studies have topic anchors." }
        : { ok: false, message: `Included studies without topic anchors: ${weak.map((d: any) => d.title ?? d.paperId).join("; ")}`, severity: "blocking", category: "topic_anchor_failed" };
    }
  },
  {
    id: "screening_preferences_complete",
    description: "Validate that screening decisions expose preference scores when a research brief is present.",
    async verify(ctx) {
      const brief = await readStageArtifact(ctx.services, ctx.artifactIds, "research_brief");
      if (!brief) return { ok: true, message: "No research brief preferences to enforce." };
      const screening = await readStageArtifact(ctx.services, ctx.artifactIds, "screening_log");
      const scores = await readStageArtifact(ctx.services, ctx.artifactIds, "preference_scores");
      const decisions = screening?.decisions ?? [];
      const ok = Array.isArray(scores?.scores) && scores.scores.length === decisions.length && decisions.every((d: any) => typeof d.preferenceScore === "number" && Array.isArray(d.preferenceReasons) && !(d.decision === "include" && d.hardExcluded));
      return ok ? { ok: true, message: "Screening decisions include auditable preference scores." } : { ok: false, message: "Screening decisions are missing preference scores or included hard-excluded records.", severity: "major", category: "screening_preferences_incomplete" };
    }
  },
  {
    id: "literature_evidence_complete",
    description: "Validate included studies, quality tiers, and evidence rows.",
    async verify(ctx) {
      const included = await readStageArtifact(ctx.services, ctx.artifactIds, "included_studies");
      const quality = await readStageArtifact(ctx.services, ctx.artifactIds, "quality_assessment");
      const evidence = await readStageArtifact(ctx.services, ctx.artifactIds, "evidence_table");
      const papers = included?.papers ?? [];
      const tiers = quality?.tiers ?? [];
      const rows = evidence?.rows ?? [];
      const paperIds = new Set(papers.map((p: PaperHit) => p.id));
      const ok = Array.isArray(papers) && Array.isArray(tiers) && Array.isArray(rows) && tiers.every((q: any) => q.paperId && q.tier) && rows.every((r: any) => r.evidenceId && paperIds.has(r.paperId) && r.claim);
      return ok ? { ok: true, message: "Evidence artifacts are internally consistent." } : { ok: false, message: "Evidence table, included studies, or quality tiers are incomplete or inconsistent.", severity: "major", category: "evidence_incomplete" };
    }
  },
  {
    id: "eligibility_preferences_enforced",
    description: "Validate bottom-line evidence preferences such as DOI, abstract, and minimum quality.",
    async verify(ctx) {
      const brief = await readStageArtifact(ctx.services, ctx.artifactIds, "research_brief");
      if (!brief) return { ok: true, message: "No research brief evidence preferences to enforce." };
      const included = await readStageArtifact(ctx.services, ctx.artifactIds, "included_studies");
      const eligibility = await readStageArtifact(ctx.services, ctx.artifactIds, "eligibility_log");
      const quality = await readStageArtifact(ctx.services, ctx.artifactIds, "quality_assessment");
      const evidencePreferences = brief.compiledMetadata?.evidencePreferences ?? {};
      const papers = included?.papers ?? [];
      const tiers = quality?.tiers ?? [];
      const minQuality = evidencePreferences.min_quality ?? evidencePreferences.minQuality;
      const bad = papers.filter((paper: PaperHit) => (evidencePreferences.require_doi || evidencePreferences.requireDoi) && !paper.doi || (evidencePreferences.require_abstract || evidencePreferences.requireAbstract) && !paper.abstract);
      const weak = minQuality ? tiers.filter((tier: any) => !meetsMinQuality(tier.tier, minQuality)) : [];
      const ok = Array.isArray(eligibility?.decisions) && bad.length === 0 && weak.length === 0;
      return ok ? { ok: true, message: "Eligibility preferences are enforced." } : { ok: false, message: "Included studies violate evidence preferences for DOI, abstract, or minimum quality.", severity: "blocking", category: "eligibility_preferences_failed" };
    }
  },
  {
    id: "literature_prisma_counts_valid",
    description: "Validate PRISMA flow arithmetic.",
    async verify(ctx) {
      const prisma = await readStageArtifact(ctx.services, ctx.artifactIds, "prisma_flow");
      if (!prisma) return { ok: false, message: "PRISMA flow artifact is missing.", severity: "major", category: "prisma_missing" };
      const total = Number(prisma.recordsIdentifiedThroughDatabaseSearching ?? 0) + Number(prisma.recordsIdentifiedThroughCitationChaining ?? 0);
      const after = Number(prisma.recordsAfterDeduplication ?? 0);
      const duplicates = Number(prisma.duplicateRecordsRemoved ?? 0);
      const screened = Number(prisma.recordsScreened ?? -1);
      const included = Number(prisma.studiesIncludedInSynthesis ?? -1);
      const ok = Number(prisma.totalRecordsIdentified) === total && after + duplicates === total && screened === after && included >= 0 && included <= screened;
      return ok ? { ok: true, message: "PRISMA counts are valid." } : { ok: false, message: "PRISMA counts are arithmetically inconsistent.", severity: "major", category: "prisma_count_mismatch" };
    }
  },
  {
    id: "synthesis_preferences_reflected",
    description: "Validate that the final synthesis reflects the user brief and preference artifacts.",
    async verify(ctx) {
      const brief = await readStageArtifact(ctx.services, ctx.artifactIds, "research_brief");
      if (!brief) return { ok: true, message: "No research brief preferences to reflect." };
      const markdown = await listArtifactsByType(ctx.services, ctx.artifactIds, "markdown");
      const latest = markdown.at(-1);
      const text = latest ? (await ctx.services.artifactStore.read(latest.id)).toString("utf8") : "";
      const ok = /User Preferences|用户偏好/i.test(text) && /preference_scores\.json/.test(text);
      return ok ? { ok: true, message: "Synthesis reflects user preferences and audit artifacts." } : { ok: false, message: "Final synthesis does not expose user preferences or preference score artifact references.", severity: "major", category: "synthesis_preferences_missing" };
    }
  }
];

function getQuestion(value: any): string | undefined {
  return value?.question ?? value?.researchQuestion ?? value?.research_question;
}

function normalizeDatabases(value: any): string[] {
  const databases = value?.databases ?? value?.databasePlan ?? value?.database_plan ?? [];
  if (!Array.isArray(databases)) return [];
  return databases.map((db: any) => typeof db === "string" ? db : (db?.id ?? db?.name ?? db?.database)).filter(Boolean).map(String);
}
