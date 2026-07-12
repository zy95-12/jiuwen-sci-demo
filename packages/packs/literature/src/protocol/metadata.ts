export function defaultCriteria() {
  return {
    inclusion: [
      "IC1: directly addresses the research question",
      "IC2: contains empirical results, theoretical analysis, or systematic review",
      "IC3: has identifiable scholarly metadata"
    ],
    exclusion: [
      "EC1: only tangentially mentions the topic",
      "EC2: insufficient metadata to verify source identity",
      "EC3: duplicate or superseded record",
      "EC4: unavailable abstract/summary and low relevance"
    ]
  };
}

export function hasResearchBrief(metadata: any): boolean {
  return Boolean(metadata?.researchBrief);
}

export function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

export function protocolPreferenceSummary(metadata: any): any {
  return compactObject({
    sourcePreferences: metadata?.sourcePreferences,
    evidencePreferences: metadata?.evidencePreferences,
    outputPreferences: metadata?.outputPreferences,
    inclusionCriteria: metadata?.inclusionCriteria,
    exclusionCriteria: metadata?.exclusionCriteria
  });
}
