import { TopicExpansion, TopicFacet, TopicProfile } from "../types.js";
import { booleanOr, conceptTermsOf, extractSearchTerms, isModifierOnlyTerm, normalizeText, quoteQueryTerm, slugify, termsOf, uniqueQueries } from "../utils/text.js";

export function buildQueryPlan(question: string, dbs: string[], criteria: unknown, metadataProfile?: unknown, expansion?: TopicExpansion): any {
  const topicProfile = topicProfileFromMetadata(metadataProfile, question);
  const topicExpansion = expansion ?? normalizeTopicExpansion(undefined, question, { topicProfile: metadataProfile });
  const broadQuery = booleanOr(topicProfile.coreTerms);
  const domainQuery = booleanOr(topicProfile.domainTerms);
  return {
    stage: "queries",
    researchQuestion: question,
    conceptDefinition: {
      term: topicProfile.topicLabel ?? question,
      definition: "Review scope derived from the user question and optional runtime topic profile.",
      scope: [...topicProfile.coreTerms, ...topicProfile.domainTerms]
    },
    concepts: inferConcepts(question, topicProfile),
    coreTerms: topicProfile.coreTerms,
    domainTerms: topicProfile.domainTerms,
    modifierTerms: topicProfile.modifierTerms,
    topicExpansion,
    criteria,
    selectedQueries: executableQueriesFromExpansion(dbs, topicExpansion, topicProfile),
    alternativeQueries: dbs.flatMap((db) => [
      { database: db, query: broadQuery, rationale: "High-precision core concept query." },
      { database: db, query: domainQuery, rationale: "Domain-expansion query from the runtime topic profile." }
    ])
  };
}

export function executableQueryPlanFrom(queryPlan: any, dbs: string[], expansion: TopicExpansion): any {
  const selected = normalizeSelectedQueries(queryPlan);
  const executable = selected.filter((query) => dbs.includes(String(query.database)));
  const topicProfile = topicProfileFromQueries(queryPlan, getQuestion(queryPlan) ?? "", undefined, expansion);
  return {
    ...queryPlan,
    stage: "queries",
    topicExpansion: expansion,
    selectedQueries: executable.length ? executable : executableQueriesFromExpansion(dbs, expansion, topicProfile)
  };
}

export function normalizeSelectedQueries(value: any): { database?: string; query?: string; rationale?: string; fallbackQueries?: string[]; facetId?: string }[] {
  const raw = value?.selectedQueries ?? value?.selected_queries ?? value?.queries ?? [];
  if (!Array.isArray(raw)) return [];
  return raw.map((query: any) => ({
    database: query?.database ?? query?.db ?? query?.source,
    query: query?.query ?? query?.queryString ?? query?.query_string,
    rationale: query?.rationale ?? query?.query_logic,
    facetId: query?.facetId ?? query?.facet_id,
    fallbackQueries: Array.isArray(query?.fallbackQueries ?? query?.fallback_queries) ? (query.fallbackQueries ?? query.fallback_queries).map(String) : undefined
  })).filter((query) => query.database || query.query);
}

export function executableQueriesFromExpansion(dbs: string[], expansion: TopicExpansion, topicProfile: TopicProfile): any[] {
  const facets = expansion.facets.length ? expansion.facets : [coreFacetFromExpansion(expansion, topicProfile)];
  return dbs.flatMap((db) => facets.slice(0, 8).map((facet) => ({
    database: db,
    facetId: facet.id,
    query: queryForFacet(db, expansion, facet),
    fallbackQueries: fallbackQueriesForFacet(db, expansion, facet),
    rationale: `Facet query for ${facet.label}; generated from topic_expansion.json and executable connector ${db}.`
  })));
}

export function searchQueryGroupsForDb(db: string, selectedQueries: { database?: string; query?: string; fallbackQueries?: string[] }[], expansion: TopicExpansion, profile?: TopicProfile): string[][] {
  const selected = selectedQueries.filter((query) => query.database === db && query.query).map((query) => uniqueQueries([query.query, ...(query.fallbackQueries ?? [])]));
  if (selected.length) return selected;
  const topicProfile = profile ?? topicProfileFromMetadata(undefined, expansion.macroConcept, expansion);
  return executableQueriesFromExpansion([db], expansion, topicProfile).map((query) => uniqueQueries([query.query, ...(query.fallbackQueries ?? [])]));
}

export function dbFallbackQueries(db: string, question = "", profile?: TopicProfile): string[] {
  const topicProfile = profile ?? topicProfileFromMetadata(undefined, question);
  const expansion = topicProfile.expansion;
  const seeds = expansion
    ? [...expansion.facets.flatMap((facet) => facet.requiredTerms.length ? facet.requiredTerms : facet.terms).slice(0, 5), ...expansion.macroTerms.slice(0, 2)]
    : db === "arxiv"
      ? [...topicProfile.coreTerms.slice(0, 3), ...topicProfile.domainTerms.slice(0, 2)]
      : topicProfile.coreTerms.slice(0, 3);
  return uniqueQueries(seeds.map(quoteQueryTerm));
}

export function topicProfileFromMetadata(value: unknown, question: string, expansion?: TopicExpansion): TopicProfile {
  const profile = value && typeof value === "object" ? value as any : {};
  const coreTerms = termsOf(profile.coreTerms ?? profile.core_terms);
  const domainTerms = termsOf(profile.domainTerms ?? profile.domain_terms);
  const modifierTerms = termsOf(profile.modifierTerms ?? profile.modifier_terms);
  const extracted = extractSearchTerms(question);
  const topicExpansion = expansion ?? (profile.expansion as TopicExpansion | undefined);
  return {
    topicLabel: typeof profile.topicLabel === "string" ? profile.topicLabel : question,
    coreTerms: uniqueQueries([...(coreTerms.length ? coreTerms : extracted), ...(topicExpansion?.macroTerms ?? [])]),
    domainTerms: uniqueQueries([...domainTerms, ...(topicExpansion?.facets.flatMap((facet) => [...facet.requiredTerms, ...facet.terms]) ?? [])]),
    modifierTerms: modifierTerms.length ? modifierTerms : defaultModifierTerms(),
    expansion: topicExpansion
  };
}

export function topicProfileFromQueries(queries: any, question = "", metadataProfile?: unknown, expansion?: TopicExpansion): TopicProfile {
  const topicExpansion = expansion ?? normalizeTopicExpansion(queries?.topicExpansion ?? queries?.topic_expansion, question, { topicProfile: metadataProfile }, queries);
  const fallback = topicProfileFromMetadata(metadataProfile, question, topicExpansion);
  const conceptTerms = conceptTermsOf(queries?.concepts);
  return {
    topicLabel: queries?.researchQuestion ?? queries?.question ?? fallback.topicLabel,
    coreTerms: uniqueQueries([...(termsOf(queries?.coreTerms).length ? termsOf(queries?.coreTerms) : conceptTerms.length ? conceptTerms : fallback.coreTerms), ...topicExpansion.macroTerms]),
    domainTerms: uniqueQueries([...(termsOf(queries?.domainTerms).length ? termsOf(queries?.domainTerms) : fallback.domainTerms), ...topicExpansion.facets.flatMap((facet) => [...facet.requiredTerms, ...facet.terms])]),
    modifierTerms: termsOf(queries?.modifierTerms).length ? termsOf(queries?.modifierTerms) : fallback.modifierTerms,
    expansion: topicExpansion
  };
}

export function normalizeTopicExpansion(value: any, question: string, metadata: any = {}, queries?: any): TopicExpansion {
  const raw = value && typeof value === "object" ? value : {};
  const metadataProfile = metadata?.topicProfile ?? {};
  const brief = metadata?.researchBrief ?? {};
  const queryConceptTerms = conceptTermsOf(queries?.concepts);
  const macroTerms = uniqueQueries([
    raw.macroConcept,
    raw.macro_concept,
    raw.macro,
    metadataProfile.topicLabel,
    question,
    ...termsOf(raw.macroTerms ?? raw.macro_terms),
    ...termsOf(metadataProfile.coreTerms ?? metadataProfile.core_terms),
    ...termsOf(brief?.scope?.include),
    ...queryConceptTerms.slice(0, 12),
    ...extractSearchTerms(question)
  ]).filter((term) => !isModifierOnlyTerm(term));
  const systemTerms = uniqueQueries([
    "infrastructure",
    "system",
    "systems",
    "platform",
    "framework",
    "engine",
    "cluster",
    "serving",
    "training",
    "inference",
    ...termsOf(raw.systemTerms ?? raw.system_terms)
  ]);
  const institutionTerms = uniqueQueries([
    ...termsOf(raw.institutionTerms ?? raw.institution_terms),
    ...termsOf(metadata?.sourcePreferences?.institutions),
    ...termsOf(brief?.focus?.institutions)
  ]);
  const rawFacets = Array.isArray(raw.facets) ? raw.facets : [];
  const hasStructuredExpansion = rawFacets.length > 0 || Boolean(metadata?.researchBrief) || Array.isArray(queries?.concepts);
  const geographyTerms = termsOf(metadata?.sourcePreferences?.geographies);
  const blockedFacetSeeds = new Set([...institutionTerms, ...geographyTerms].map(normalizeText));
  const metadataFacetSeeds = [
    ...(metadata?.researchBrief ? termsOf(metadataProfile.domainTerms ?? metadataProfile.domain_terms) : []),
    ...termsOf(brief?.focus?.domains),
    ...queryConceptTerms.slice(12)
  ].filter((term) => !blockedFacetSeeds.has(normalizeText(term)));
  const facets = uniqueFacets([
    ...rawFacets.map((facet: any, index: number) => normalizeFacet(facet, index)),
    ...metadataFacetSeeds.map((term, index) => normalizeFacet({ id: slugify(term), label: term, terms: [term], requiredTerms: [term] }, index + rawFacets.length))
  ]);
  const fallbackFacet = normalizeFacet({ id: "core", label: "Core topic", terms: macroTerms.slice(0, 6), requiredTerms: macroTerms.slice(0, 3), anchorPolicy: "macro_or_facet" }, 0);
  return {
    stage: "topic_expansion",
    macroConcept: String(raw.macroConcept ?? raw.macro_concept ?? metadataProfile.topicLabel ?? question),
    macroTerms: macroTerms.length ? macroTerms : extractSearchTerms(question),
    systemTerms,
    institutionTerms,
    facets: hasStructuredExpansion ? facets.length ? facets : [fallbackFacet] : [],
    excludeTerms: uniqueQueries([...termsOf(raw.excludeTerms ?? raw.exclude_terms), ...termsOf(metadata?.exclusionCriteria), ...termsOf(brief?.scope?.exclude)]),
    audit: { source: raw.stage === "topic_expansion" ? "artifact" : rawFacets.length ? "agent_or_metadata" : "deterministic_fallback" }
  };
}

function getQuestion(value: any): string | undefined {
  return value?.question ?? value?.researchQuestion ?? value?.research_question;
}

function coreFacetFromExpansion(expansion: TopicExpansion, topicProfile: TopicProfile): TopicFacet {
  const terms = uniqueQueries([...expansion.macroTerms, ...topicProfile.coreTerms]).slice(0, 8);
  return { id: "core", label: "Core topic", weight: 1, terms, requiredTerms: terms.slice(0, 3), anchorPolicy: "macro_or_facet" };
}

function queryForFacet(db: string, expansion: TopicExpansion, facet: TopicFacet): string {
  const macro = booleanOr(expansion.macroTerms.slice(0, db === "arxiv" ? 2 : 4));
  const facetTerms = booleanOr(uniqueQueries([...facet.requiredTerms, ...facet.terms]).slice(0, db === "arxiv" ? 3 : 6));
  const system = booleanOr(expansion.systemTerms.slice(0, db === "arxiv" ? 2 : 4));
  const institutions = booleanOr(expansion.institutionTerms.slice(0, db === "arxiv" ? 2 : 6));
  if (db === "crossref") return facetTerms || macro || system;
  if (db === "arxiv") return uniqueQueries([facetTerms, system, institutions].filter(Boolean)).join(" OR ");
  return uniqueQueries([
    macro && facetTerms ? `(${macro}) AND (${facetTerms})` : facetTerms || macro,
    system && facetTerms ? `(${system}) AND (${facetTerms})` : "",
    institutions && facetTerms ? `(${institutions}) AND (${facetTerms})` : ""
  ]).filter(Boolean).join(" OR ");
}

function fallbackQueriesForFacet(db: string, expansion: TopicExpansion, facet: TopicFacet): string[] {
  const seeds = db === "crossref"
    ? [...facet.requiredTerms, ...facet.terms].slice(0, 3)
    : [...facet.requiredTerms, ...facet.terms, ...expansion.macroTerms, ...expansion.systemTerms].slice(0, 5);
  return uniqueQueries(seeds.map(quoteQueryTerm));
}

function inferConcepts(question: string, profile?: TopicProfile): any[] {
  const topicProfile = profile ?? topicProfileFromMetadata(undefined, question);
  return topicProfile.coreTerms.slice(0, 10).map((name, index) => ({ name, synonyms: [], required: index === 0 }));
}

function defaultModifierTerms(): string[] {
  return ["development status", "current status", "trend", "trends", "future direction", "future directions", "roadmap", "review", "survey", "现状", "趋势", "发展"];
}

function normalizeFacet(facet: any, index: number): TopicFacet {
  const label = String(facet?.label ?? facet?.name ?? facet?.id ?? `facet_${index + 1}`);
  const terms = uniqueQueries([
    ...termsOf(facet?.terms),
    ...termsOf(facet?.keywords),
    ...termsOf(facet?.synonyms),
    label
  ]);
  const requiredTerms = uniqueQueries([...termsOf(facet?.requiredTerms ?? facet?.required_terms), ...terms.slice(0, 2)]);
  const policy = ["macro_or_facet", "facet_plus_system", "institution_plus_facet"].includes(facet?.anchorPolicy ?? facet?.anchor_policy)
    ? facet.anchorPolicy ?? facet.anchor_policy
    : "facet_plus_system";
  return {
    id: slugify(String(facet?.id ?? label)) || `facet_${index + 1}`,
    label,
    weight: Number(facet?.weight ?? 1),
    terms,
    requiredTerms,
    anchorPolicy: policy as TopicFacet["anchorPolicy"]
  };
}

function uniqueFacets(facets: TopicFacet[]): TopicFacet[] {
  const byId = new Map<string, TopicFacet>();
  for (const facet of facets) {
    const existing = byId.get(facet.id);
    if (!existing) byId.set(facet.id, facet);
    else byId.set(facet.id, { ...existing, terms: uniqueQueries([...existing.terms, ...facet.terms]), requiredTerms: uniqueQueries([...existing.requiredTerms, ...facet.requiredTerms]), weight: Math.max(existing.weight, facet.weight) });
  }
  return [...byId.values()].filter((facet) => facet.terms.length || facet.requiredTerms.length).slice(0, 24);
}

