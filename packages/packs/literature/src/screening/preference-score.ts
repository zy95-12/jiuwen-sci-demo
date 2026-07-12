import { PaperHit, PreferenceScore, TopicProfile } from "../types.js";
import { escapeRegExp, normalizeText, termsOf, uniqueQueries } from "../utils/text.js";

export function topicAnchorScore(paper: PaperHit, profile: TopicProfile): { anchored: boolean; score: number; coreHits: string[]; domainHits: string[]; modifierHits: string[] } {
  const haystack = normalizeText(`${paper.title} ${paper.abstract ?? ""} ${paper.venue ?? ""}`);
  const coreHits = profile.coreTerms.filter((term) => haystack.includes(normalizeText(term)));
  const modifierHits = profile.modifierTerms.filter((term) => haystack.includes(normalizeText(term)));
  const expansion = profile.expansion;
  const institutionKeys = new Set((expansion?.institutionTerms ?? []).map(normalizeText));
  const domainHits = profile.domainTerms.filter((term) => !institutionKeys.has(normalizeText(term)) && haystack.includes(normalizeText(term)));
  const facetHits = expansion ? expansion.facets.filter((facet) => matchedTerms(haystack, [...facet.requiredTerms, ...facet.terms]).length > 0) : [];
  const systemHits = expansion ? matchedTerms(haystack, expansion.systemTerms) : [];
  const institutionHits = expansion ? matchedTerms(haystack, expansion.institutionTerms) : [];
  const hasMlContext = /\b(ai|artificial intelligence|machine learning|deep learning|foundation model|large language model|llm|neural network)\b/i.test(haystack);
  const facetAnchored = facetHits.some((facet) =>
    facet.anchorPolicy === "macro_or_facet"
      || coreHits.length > 0
      || systemHits.length > 0
      || (facet.anchorPolicy === "institution_plus_facet" && institutionHits.length > 0)
      || hasMlContext
  );
  const anchored = coreHits.length > 0 || facetAnchored || (domainHits.length > 0 && hasMlContext);
  const score = coreHits.length * 3 + domainHits.length * 1.2 + facetHits.reduce((sum, facet) => sum + facet.weight * 1.8, 0) + systemHits.length * 0.6 + institutionHits.length * 0.4 + modifierHits.length * 0.2 + (paper.abstract ? 0.3 : 0) + (paper.doi || paper.url ? 0.1 : 0);
  return { anchored, score, coreHits, domainHits, modifierHits };
}

export function scorePaperAgainstBrief(paper: PaperHit, metadata: any, profile: TopicProfile): PreferenceScore {
  const anchor = topicAnchorScore(paper, profile);
  const sourcePrefs = metadata?.sourcePreferences ?? {};
  const evidencePrefs = metadata?.evidencePreferences ?? {};
  const brief = metadata?.researchBrief ?? {};
  const text = paperSearchText(paper);
  const reasons: string[] = [];
  const penalties: string[] = [];
  const hardExclusions: string[] = [];
  const appliedPreferences: string[] = [];
  const matched = {
    questions: matchedTerms(text, termsOf(brief?.questions)),
    domains: matchedTerms(text, uniqueQueries([...termsOf(sourcePrefs?.domains), ...profile.domainTerms])),
    institutions: matchedTerms(text, termsOf(sourcePrefs?.institutions)),
    geographies: matchedTerms(text, termsOf(sourcePrefs?.geographies)),
    sources: matchedTerms(`${paper.sourceDb} ${paper.venue ?? ""} ${paper.url ?? ""}`, termsOf(sourcePrefs?.preferredSources)),
    studyTypes: matchedStudyTypes(text, termsOf(evidencePrefs?.studyTypes ?? evidencePrefs?.study_types))
  };

  const dateRange = sourcePrefs?.dateRange ?? sourcePrefs?.date_range;
  if (dateRange && !paperYearInRange(paper.year, dateRange)) hardExclusions.push(`outside date range ${dateRange.from ?? "any"}-${dateRange.to ?? "any"}`);
  for (const term of matchedTerms(text, exclusionTerms(metadata))) hardExclusions.push(`matched exclusion term: ${term}`);
  if ((evidencePrefs?.requireDoi || evidencePrefs?.require_doi) && !paper.doi) hardExclusions.push("missing required DOI");
  if ((evidencePrefs?.requireAbstract || evidencePrefs?.require_abstract) && !paper.abstract) hardExclusions.push("missing required abstract");
  const excludedSourceHits = matchedTerms(`${paper.sourceDb} ${paper.venue ?? ""} ${paper.url ?? ""} ${paper.title}`, termsOf(sourcePrefs?.excludedSources ?? sourcePrefs?.excluded_sources));
  for (const term of excludedSourceHits) hardExclusions.push(`matched excluded source: ${term}`);

  let sourceScore = 0;
  let focusScore = 0;
  let evidenceScore = 0;
  if (matched.sources.length) {
    sourceScore += matched.sources.length * 1.5;
    reasons.push(`preferred source match: ${matched.sources.join(", ")}`);
    appliedPreferences.push("sourcePreferences.preferredSources");
  }
  if (matched.domains.length) {
    focusScore += matched.domains.length * 1.2;
    reasons.push(`domain focus match: ${matched.domains.join(", ")}`);
    appliedPreferences.push("sourcePreferences.domains/topicProfile.domainTerms");
  }
  if (matched.institutions.length) {
    focusScore += matched.institutions.length * 1.1;
    reasons.push(`institution focus match: ${matched.institutions.join(", ")}`);
    appliedPreferences.push("sourcePreferences.institutions");
  }
  if (matched.geographies.length) {
    focusScore += matched.geographies.length * 0.8;
    reasons.push(`geography focus match: ${matched.geographies.join(", ")}`);
    appliedPreferences.push("sourcePreferences.geographies");
  }
  if (matched.studyTypes.length) {
    evidenceScore += matched.studyTypes.length;
    reasons.push(`evidence type match: ${matched.studyTypes.join(", ")}`);
    appliedPreferences.push("evidencePreferences.studyTypes");
  }
  if (paper.doi) evidenceScore += 0.3;
  else if (evidencePrefs?.requireDoi || evidencePrefs?.require_doi) penalties.push("DOI required but absent");
  if (paper.abstract) evidenceScore += 0.5;
  else if (evidencePrefs?.requireAbstract || evidencePrefs?.require_abstract) penalties.push("abstract required but absent");
  if (dateRange) appliedPreferences.push("sourcePreferences.dateRange");
  if (hardExclusions.length) penalties.push(...hardExclusions);

  const score = Math.max(0, anchor.score + sourceScore + focusScore + evidenceScore - penalties.length * 0.5);
  if (!reasons.length) reasons.push(anchor.anchored ? "topic anchor matched" : "no explicit user preference match");
  return {
    paperId: paper.id,
    hardExcluded: hardExclusions.length > 0,
    score: Number(score.toFixed(2)),
    topicScore: Number(anchor.score.toFixed(2)),
    sourceScore: Number(sourceScore.toFixed(2)),
    evidenceScore: Number(evidenceScore.toFixed(2)),
    focusScore: Number(focusScore.toFixed(2)),
    reasons,
    penalties,
    hardExclusions,
    appliedPreferences: uniqueQueries(appliedPreferences),
    briefTrace: uniqueQueries([
      ...matched.questions.map((term) => `question:${term}`),
      ...matched.domains.map((term) => `domain:${term}`),
      ...matched.institutions.map((term) => `institution:${term}`),
      ...matched.geographies.map((term) => `geography:${term}`),
      ...matched.sources.map((term) => `source:${term}`),
      ...matched.studyTypes.map((term) => `studyType:${term}`)
    ]),
    matched
  };
}

export function screenPaper(_question: string, paper: PaperHit, profile: TopicProfile, preference?: PreferenceScore): any {
  const anchor = topicAnchorScore(paper, profile);
  const hardExcluded = preference?.hardExcluded ?? false;
  const decision = !hardExcluded && anchor.anchored && anchor.score >= 1.5 ? "include" : "exclude";
  return {
    paperId: paper.id,
    title: paper.title,
    decision,
    criteria: decision === "include" ? ["IC1", paper.abstract ? "IC2" : "IC3"] : hardExcluded ? ["EC_user_preference"] : ["EC1"],
    reason: decision === "include"
      ? `Included: matched topic anchors. Core hits: ${anchor.coreHits.join(", ") || "none"}; domain hits: ${anchor.domainHits.join(", ") || "none"}.`
      : hardExcluded ? `Excluded by user brief hard filters: ${preference?.hardExclusions.join("; ")}` : `Excluded: no sufficient topic anchor. Modifier-only hits: ${anchor.modifierHits.join(", ") || "none"}.`,
    hardExcluded,
    hardExclusions: preference?.hardExclusions ?? [],
    preferenceScore: preference?.score ?? Number(anchor.score.toFixed(2)),
    preferenceReasons: preference?.reasons ?? [],
    preferencePenalties: preference?.penalties ?? [],
    briefTrace: preference?.briefTrace ?? [],
    confidence: Math.min(0.95, Math.max(0.35, anchor.score / 4))
  };
}

export function assessEligibility(paper: PaperHit, metadata: any = {}, preference?: PreferenceScore, quality?: any): any {
  const hasIdentity = Boolean(paper.title && (paper.doi || paper.url || paper.id));
  const hasEvidence = Boolean(paper.abstract || paper.venue || paper.year);
  const evidencePrefs = metadata?.evidencePreferences ?? {};
  const reasons: string[] = [];
  if (!hasIdentity) reasons.push("insufficient source identity");
  if (!hasEvidence) reasons.push("insufficient evidence metadata");
  if (preference?.hardExcluded) reasons.push(...preference.hardExclusions);
  if ((evidencePrefs?.requireDoi || evidencePrefs?.require_doi) && !paper.doi) reasons.push("required DOI missing");
  if ((evidencePrefs?.requireAbstract || evidencePrefs?.require_abstract) && !paper.abstract) reasons.push("required abstract missing");
  const minQuality = evidencePrefs?.minQuality ?? evidencePrefs?.min_quality;
  if (minQuality && quality?.tier && !meetsMinQuality(quality.tier, minQuality)) reasons.push(`quality ${quality.tier} below required ${minQuality}`);
  const include = hasIdentity && hasEvidence && reasons.length === 0;
  return {
    paperId: paper.id,
    decision: include ? "include" : "exclude",
    reason: include ? "Eligible: identifiable scholarly record with usable metadata or abstract and no brief hard-filter violations." : `Excluded: ${reasons.join("; ")}.`,
    assessedUsing: paper.abstract ? "abstract" : "metadata",
    appliedPreferences: preference?.appliedPreferences ?? [],
    preferenceScore: preference?.score,
    qualityTier: quality?.tier
  };
}

export function preferenceAlignment(score?: PreferenceScore): any {
  if (!score) return { score: 0, reasons: [] };
  return {
    score: score.score,
    topicScore: score.topicScore,
    sourceScore: score.sourceScore,
    evidenceScore: score.evidenceScore,
    focusScore: score.focusScore,
    reasons: score.reasons,
    matched: score.matched
  };
}

export function summarizePreferenceScores(scores: PreferenceScore[]): any {
  const hardExcluded = scores.filter((score) => score.hardExcluded).length;
  const averageScore = scores.length ? scores.reduce((sum, score) => sum + score.score, 0) / scores.length : 0;
  return {
    recordsScored: scores.length,
    hardExcluded,
    averageScore: Number(averageScore.toFixed(2)),
    topPreferenceMatches: [...scores].sort((a, b) => b.score - a.score).slice(0, 5).map((score) => ({ paperId: score.paperId, score: score.score, reasons: score.reasons }))
  };
}

function paperSearchText(paper: PaperHit): string {
  return normalizeText(`${paper.title} ${paper.abstract ?? ""} ${paper.venue ?? ""} ${paper.sourceDb} ${(paper.authors ?? []).join(" ")} ${paper.url ?? ""}`);
}

function matchedTerms(haystack: string, terms: string[]): string[] {
  const normalized = normalizeText(haystack);
  return uniqueQueries(terms).filter((term) => normalized.includes(normalizeText(term)));
}

function matchedStudyTypes(haystack: string, studyTypes: string[]): string[] {
  const patterns: Record<string, RegExp> = {
    review: /\b(review|survey|systematic review|meta-analysis|roadmap)\b/i,
    survey: /\b(survey|review)\b/i,
    benchmark: /\b(benchmark|leaderboard|evaluation|comparison)\b/i,
    empirical: /\b(empirical|experiment|case study|observational|evaluation)\b/i,
    clinical: /\b(clinical|trial|patient|cohort)\b/i,
    experiment: /\b(experiment|experimental|ablation)\b/i
  };
  return uniqueQueries(studyTypes).filter((type) => (patterns[normalizeText(type)] ?? new RegExp(escapeRegExp(type), "i")).test(haystack));
}

function exclusionTerms(metadata: any): string[] {
  return uniqueQueries([
    ...termsOf(metadata?.exclusionCriteria),
    ...termsOf(metadata?.researchBrief?.scope?.exclude),
    ...termsOf(metadata?.researchBrief?.exclusionCriteria)
  ]);
}

function paperYearInRange(year: number | undefined, range: any): boolean {
  if (!year) return true;
  const from = Number(range?.from ?? range?.start ?? Number.NEGATIVE_INFINITY);
  const to = Number(range?.to ?? range?.end ?? Number.POSITIVE_INFINITY);
  return year >= from && year <= to;
}

function qualityRank(tier: string): number {
  const match = String(tier ?? "").match(/tier\s*(\d+)/i);
  return match ? Number(match[1]) : 4;
}

export function meetsMinQuality(tier: string, minQuality: string): boolean {
  return qualityRank(tier) <= qualityRank(minQuality);
}
