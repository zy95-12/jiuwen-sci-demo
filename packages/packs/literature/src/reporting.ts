import { summarizePreferenceScores } from "./screening/preference-score.js";
import type { PaperHit, PreferenceScore } from "./types.js";
import { termsOf } from "./utils/text.js";
import { hasResearchBrief } from "./protocol/metadata.js";

export function detectContradictions(rows: any[]): any[] {
  const positives = rows.filter((r) => /\bimprove|increase|better|outperform|support/i.test(r.quoteOrSummary));
  const negatives = rows.filter((r) => /\bnot|fail|worse|decrease|contradict|limit/i.test(r.quoteOrSummary));
  if (positives.length && negatives.length) {
    return [{ type: "potential_method_or_context_conflict", supports: positives.slice(0, 3).map((r) => r.paperId), contrasts: negatives.slice(0, 3).map((r) => r.paperId), explanation: "Automated lexical scan found both positive and limiting language; manual review should determine whether this is a real contradiction or context difference." }];
  }
  return [];
}

export function countTiers(quality: any[]): Record<string, number> {
  return quality.reduce((acc, q) => ({ ...acc, [q.tier]: (acc[q.tier] ?? 0) + 1 }), {} as Record<string, number>);
}

export function renderBibtex(paper: PaperHit, index: number): string {
  const key = `paper${index + 1}_${String(paper.year ?? "nd")}`;
  const type = paper.venue?.toLowerCase().includes("journal") ? "article" : "misc";
  return `@${type}{${key},\n  title = {${paper.title.replace(/[{}]/g, "")}},\n  author = {${(paper.authors ?? ["Unknown"]).join(" and ")}},\n  year = {${paper.year ?? "n.d."}},\n  journal = {${paper.venue ?? paper.sourceDb}},\n  doi = {${paper.doi ?? ""}},\n  url = {${paper.url ?? ""}}\n}`;
}

export function renderSynthesis(question: string, papers: PaperHit[], rows: any[], quality: any[], contradictions: any[], prisma: any, metadata: any = {}, preferenceScores: PreferenceScore[] = []): string {
  const refs = papers.map((p, i) => `${i + 1}. ${p.authors?.slice(0, 3).join(", ") || "Unknown"} (${p.year ?? "n.d."}). ${p.title}. ${p.venue ?? p.sourceDb}. ${p.doi ? `doi:${p.doi}` : p.url ?? p.id}`).join("\n");
  const claims = rows.map((r, i) => `- **Finding ${i + 1}**: ${r.claim} Evidence: ${r.evidenceId}; source: ${r.paperId}; quality: ${r.qualityTier}.`).join("\n");
  const matrix = papers.map((p) => {
    const q = quality.find((x) => x.paperId === p.id);
    return `| ${p.title.replace(/\|/g, " ")} | ${p.year ?? "n.d."} | ${p.venue ?? p.sourceDb} | ${q?.tier ?? "Tier 3"} | ${p.abstract ? p.abstract.slice(0, 120).replace(/\|/g, " ") : "Metadata-level relevance"} |`;
  }).join("\n");
  const preferenceSummary = renderPreferenceSummary(metadata, preferenceScores);
  return `# PRISMA-Style Literature Review: ${question}\n\n## PRISMA Flow\n\n- Records identified through database searching: ${prisma.recordsIdentifiedThroughDatabaseSearching}\n- Records identified through citation chaining: ${prisma.recordsIdentifiedThroughCitationChaining}\n- Citation-chain hints found but not promoted to screened records: ${prisma.citationChainHintsFound ?? 0}\n- Records after deduplication: ${prisma.recordsAfterDeduplication}\n- Records screened: ${prisma.recordsScreened}\n- Records excluded during title/abstract screening: ${prisma.recordsExcludedTitleAbstract}\n- Full-text/abstract records assessed for eligibility: ${prisma.fullTextOrAbstractRecordsAssessed}\n- Records excluded at eligibility: ${prisma.recordsExcludedEligibility}\n- Studies included in synthesis: ${prisma.studiesIncludedInSynthesis}\n\n## Summary\n\nThis review searched registered scholarly databases, deduplicated records, screened title/abstract metadata against explicit criteria, assessed eligibility using available abstract/full metadata, assigned evidence quality tiers, verified citation metadata, and synthesized evidence rows into traceable findings.\n\n${preferenceSummary}\n\n## Key Findings\n\n${claims || "- No included papers were available for synthesis."}\n\n## Contradictions & Conflicts\n\n${contradictions.length ? contradictions.map((c) => `- ${c.type}: ${c.explanation}`).join("\n") : "- No explicit contradictions detected by automated v0 scan."}\n\n## Evidence Matrix\n\n| Paper | Year | Venue | Quality Tier | Key Finding |\n|---|---:|---|---|---|\n${matrix || "| No included papers | | | | |"}\n\n## References\n\n${refs || "No verified references returned."}\n\n## Gaps & Opportunities\n\n- Full-text retrieval and section-level extraction should be added for stronger eligibility assessment.\n- Citation chaining is represented, but connector-level reference expansion should be broadened where APIs permit.\n- Manual expert review remains necessary before treating this as a formal systematic review.\n`;
}

function renderPreferenceSummary(metadata: any, preferenceScores: PreferenceScore[]): string {
  if (!hasResearchBrief(metadata)) return "## User Preferences\n\n- No structured research brief was provided; screening used the inferred topic profile and default PRISMA-style criteria.";
  const sourcePrefs = metadata?.sourcePreferences ?? {};
  const evidencePrefs = metadata?.evidencePreferences ?? {};
  const outputPrefs = metadata?.outputPreferences ?? {};
  const summary = summarizePreferenceScores(preferenceScores);
  const dateRange = sourcePrefs?.dateRange ?? sourcePrefs?.date_range;
  const lines = [
    `- Structured brief captured in research_brief.json; paper-level scoring captured in preference_scores.json.`,
    `- Records scored against preferences: ${summary.recordsScored}; hard-excluded by brief filters: ${summary.hardExcluded}.`,
    dateRange ? `- Date range preference: ${dateRange.from ?? "any"} to ${dateRange.to ?? "any"}.` : undefined,
    termsOf(sourcePrefs?.preferredSources).length ? `- Preferred sources: ${termsOf(sourcePrefs.preferredSources).join(", ")}.` : undefined,
    termsOf(sourcePrefs?.institutions).length ? `- Institution focus: ${termsOf(sourcePrefs.institutions).join(", ")}.` : undefined,
    termsOf(sourcePrefs?.domains).length ? `- Domain focus: ${termsOf(sourcePrefs.domains).join(", ")}.` : undefined,
    evidencePrefs?.requireDoi || evidencePrefs?.require_doi ? "- DOI was treated as a hard evidence requirement." : undefined,
    evidencePrefs?.requireAbstract || evidencePrefs?.require_abstract ? "- Abstract availability was treated as a hard evidence requirement." : undefined,
    evidencePrefs?.minQuality || evidencePrefs?.min_quality ? `- Minimum quality tier: ${evidencePrefs.minQuality ?? evidencePrefs.min_quality}.` : undefined,
    outputPrefs?.language ? `- Requested output language: ${outputPrefs.language}.` : undefined
  ].filter(Boolean);
  return `## User Preferences\n\n${lines.join("\n")}`;
}
