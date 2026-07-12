export type PaperHit = {
  id: string;
  title: string;
  abstract?: string;
  authors?: string[];
  year?: number;
  venue?: string;
  doi?: string;
  url?: string;
  sourceDb: string;
  citationCount?: number;
  references?: string[];
  citations?: string[];
  raw?: unknown;
};

export type LiteratureSearchInput = { query: string; limit?: number };

export type SourceErrorType = "rate_limited" | "timeout" | "server_error" | "not_found" | "bad_request" | "network" | "unsupported" | "unknown";

export type SourceError = {
  ok: false;
  db: string;
  operation: "search" | "fetch" | "citation_chain";
  errorType: SourceErrorType;
  retryable: boolean;
  message: string;
  guidance: string;
  status?: number;
};

export type ConnectorCapability = {
  search: boolean;
  fetch: boolean;
  citationGraph: "none" | "search_result" | "fetch";
  abstracts: boolean;
  doi: boolean;
  fullTextLinks: boolean;
};

export type ConnectorMetadata = {
  capabilities: ConnectorCapability;
  queryHints: string[];
  rateLimit?: string;
  bestFor?: string[];
};

export interface LiteratureConnector {
  id: string;
  name: string;
  description: string;
  metadata?: ConnectorMetadata;
  search(input: LiteratureSearchInput): Promise<PaperHit[]>;
  fetch?(id: string): Promise<PaperHit | unknown>;
}

export type TopicProfile = {
  topicLabel?: string;
  coreTerms: string[];
  domainTerms: string[];
  modifierTerms: string[];
  expansion?: TopicExpansion;
};

export type TopicFacet = {
  id: string;
  label: string;
  weight: number;
  terms: string[];
  requiredTerms: string[];
  anchorPolicy: "macro_or_facet" | "facet_plus_system" | "institution_plus_facet";
};

export type TopicExpansion = {
  stage: "topic_expansion";
  macroConcept: string;
  macroTerms: string[];
  systemTerms: string[];
  institutionTerms: string[];
  facets: TopicFacet[];
  excludeTerms: string[];
  audit: { source: string; generatedAt?: string };
};

export type PreferenceScore = {
  paperId: string;
  hardExcluded: boolean;
  score: number;
  topicScore: number;
  sourceScore: number;
  evidenceScore: number;
  focusScore: number;
  reasons: string[];
  penalties: string[];
  hardExclusions: string[];
  appliedPreferences: string[];
  briefTrace: string[];
  matched: {
    questions: string[];
    domains: string[];
    institutions: string[];
    geographies: string[];
    sources: string[];
    studyTypes: string[];
  };
};
