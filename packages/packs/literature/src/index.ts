import {
  Artifact,
  CapabilityPack,
  RuntimeError,
  RuntimeServices,
  StageContractDefinition,
  StageContractRunner,
  StageVerifierDefinition,
  ToolDefinition,
  WorkflowContext,
  WorkflowDefinition
} from "@jiuwen-sci/core";

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

export class LiteratureConnectorRegistry {
  private connectors = new Map<string, LiteratureConnector>();
  register(connector: LiteratureConnector): void {
    if (this.connectors.has(connector.id)) throw new RuntimeError("CONNECTOR_DUPLICATE", connector.id);
    this.connectors.set(connector.id, connector);
  }
  get(id: string): LiteratureConnector | null { return this.connectors.get(id) ?? null; }
  list(): LiteratureConnector[] { return [...this.connectors.values()]; }
}

const REGISTRY_KEY = "literature.connectorRegistry";

export function getLiteratureConnectorRegistry(services: RuntimeServices): LiteratureConnectorRegistry {
  let registry = services.extensions.get(REGISTRY_KEY) as LiteratureConnectorRegistry | undefined;
  if (!registry) {
    registry = new LiteratureConnectorRegistry();
    registry.register(new OpenAlexConnector());
    registry.register(new ArxivConnector());
    registry.register(new CrossrefConnector());
    registry.register(new PubMedConnector());
    registry.register(new EuropePmcConnector());
    registry.register(new SemanticScholarConnector());
    registry.register(new BioRxivConnector("biorxiv"));
    registry.register(new BioRxivConnector("medrxiv"));
    services.extensions.set(REGISTRY_KEY, registry);
  }
  return registry;
}

class SourceRequestError extends Error {
  constructor(
    readonly errorType: SourceErrorType,
    readonly retryable: boolean,
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "SourceRequestError";
  }
}

type RequestRetryOptions = { attempts?: number; timeoutMs?: number; retryBaseDelayMs?: number };

async function getJson<T>(url: string, headers?: Record<string, string>, options?: RequestRetryOptions): Promise<T> {
  const res = await requestWithRetry(url, headers, options);
  return res.json() as Promise<T>;
}

async function getText(url: string, headers?: Record<string, string>, options?: RequestRetryOptions): Promise<string> {
  const res = await requestWithRetry(url, headers, options);
  return res.text();
}

async function requestWithRetry(url: string, headers?: Record<string, string>, options: RequestRetryOptions = {}): Promise<Response> {
  const attempts = options.attempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 20000;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? 250;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, { headers: { "user-agent": "jiuwen-sci/0.1", ...(headers ?? {}) }, signal: controller.signal });
      clearTimeout(timeout);
      timeout = undefined;
      if (res.ok) return res;
      const classified = classifyHttpError(res.status, `${res.status} ${res.statusText}: ${url}`);
      if (!classified.retryable || attempt === attempts) throw classified;
      await sleep(retryBaseDelayMs * attempt * attempt);
    } catch (error) {
      if (timeout) clearTimeout(timeout);
      lastError = error;
      const requestError = toSourceRequestError(error, url);
      if (!requestError.retryable || attempt === attempts) throw requestError;
      await sleep(retryBaseDelayMs * attempt * attempt);
    }
  }
  throw toSourceRequestError(lastError, url);
}

function classifyHttpError(status: number, message: string): SourceRequestError {
  if (status === 429) return new SourceRequestError("rate_limited", true, message, status);
  if (status === 404) return new SourceRequestError("not_found", false, message, status);
  if (status >= 500) return new SourceRequestError("server_error", true, message, status);
  if (status >= 400) return new SourceRequestError("bad_request", false, message, status);
  return new SourceRequestError("unknown", false, message, status);
}

function toSourceRequestError(error: unknown, url: string): SourceRequestError {
  if (error instanceof SourceRequestError) return error;
  if (error instanceof Error && error.name === "AbortError") return new SourceRequestError("timeout", true, `Request timed out: ${url}`);
  if (error instanceof Error) return new SourceRequestError("network", true, error.message);
  return new SourceRequestError("unknown", true, String(error));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sourceError(db: string, operation: SourceError["operation"], error: unknown): SourceError {
  const requestError = toSourceRequestError(error, `${db}:${operation}`);
  return {
    ok: false,
    db,
    operation,
    errorType: requestError.errorType,
    retryable: requestError.retryable,
    message: requestError.message,
    guidance: sourceErrorGuidance(requestError.errorType, operation),
    status: requestError.status
  };
}

function sourceErrorGuidance(errorType: SourceErrorType, operation: SourceError["operation"]): string {
  if (errorType === "rate_limited") return "Back off and retry later; reduce limit or prefer a connector with an API key.";
  if (errorType === "timeout" || errorType === "server_error" || errorType === "network") return `Retry ${operation} or continue with other sources while preserving this source error.`;
  if (errorType === "bad_request") return "Revise the query syntax or identifier before retrying.";
  if (errorType === "not_found") return "Try DOI, source-native identifier, or another metadata source.";
  if (errorType === "unsupported") return "Use another connector that supports this operation.";
  return "Record the source error and continue with corroborating databases.";
}

export class OpenAlexConnector implements LiteratureConnector {
  id = "openalex";
  name = "OpenAlex";
  description = "Search OpenAlex works metadata and DOI-linked scholarly records.";
  metadata = {
    capabilities: { search: true, fetch: true, citationGraph: "fetch" as const, abstracts: true, doi: true, fullTextLinks: true },
    queryHints: ["Use broad natural-language scholarly concepts.", "Prefer English synonyms for cross-disciplinary topics.", "DOI and OpenAlex work IDs are accepted by fetch."],
    rateLimit: "Public API; use polite request rates and consider mailto for heavy use.",
    bestFor: ["broad scholarly discovery", "citation counts", "DOI coverage", "open access links"]
  };
  async search(input: LiteratureSearchInput): Promise<PaperHit[]> {
    const url = new URL("https://api.openalex.org/works");
    url.searchParams.set("search", input.query);
    url.searchParams.set("per-page", String(input.limit ?? 25));
    const json = await getJson<any>(url.toString());
    return (json.results ?? []).map((item: any): PaperHit => ({
      id: item.id,
      title: item.title ?? item.display_name ?? "Untitled",
      abstract: reconstructOpenAlexAbstract(item.abstract_inverted_index),
      authors: (item.authorships ?? []).map((a: any) => a.author?.display_name).filter(Boolean),
      year: item.publication_year,
      venue: item.primary_location?.source?.display_name,
      doi: normalizeDoi(item.doi),
      url: item.landing_page_url ?? item.id,
      sourceDb: "openalex",
      citationCount: item.cited_by_count,
      references: item.referenced_works,
      citations: item.cited_by_api_url ? [item.cited_by_api_url] : undefined,
      raw: item
    }));
  }
  async fetch(id: string): Promise<PaperHit | unknown> {
    const key = normalizeOpenAlexWorkId(id);
    const item = await getJson<any>(`https://api.openalex.org/works/${encodeURIComponent(key)}`);
    return {
      id: item.id,
      title: item.title ?? item.display_name ?? "Untitled",
      abstract: reconstructOpenAlexAbstract(item.abstract_inverted_index),
      authors: (item.authorships ?? []).map((a: any) => a.author?.display_name).filter(Boolean),
      year: item.publication_year,
      venue: item.primary_location?.source?.display_name,
      doi: normalizeDoi(item.doi),
      url: item.landing_page_url ?? item.id,
      sourceDb: "openalex",
      citationCount: item.cited_by_count,
      references: item.referenced_works,
      citations: item.cited_by_api_url ? [item.cited_by_api_url] : undefined,
      raw: item
    };
  }
}

export class ArxivConnector implements LiteratureConnector {
  id = "arxiv";
  name = "arXiv";
  description = "Search arXiv preprints and metadata.";
  metadata = {
    capabilities: { search: true, fetch: true, citationGraph: "none" as const, abstracts: true, doi: true, fullTextLinks: true },
    queryHints: ["Use English technical terms.", "For topic searches, include field terms such as machine learning, physics, biology, or materials.", "Fetch accepts an arXiv ID or arXiv URL."],
    rateLimit: "arXiv asks clients to make no more than one request every three seconds for repeated API calls.",
    bestFor: ["preprints", "computer science", "physics", "math", "quantitative biology"]
  };
  async search(input: LiteratureSearchInput): Promise<PaperHit[]> {
    const url = new URL("https://export.arxiv.org/api/query");
    url.searchParams.set("search_query", toArxivSearchQuery(input.query));
    url.searchParams.set("start", "0");
    url.searchParams.set("max_results", String(Math.min(input.limit ?? 10, 10)));
    const xml = await getText(url.toString(), undefined, { attempts: 4, timeoutMs: 60000, retryBaseDelayMs: 3000 });
    return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m): PaperHit => {
      const entry = m[1] ?? "";
      const id = text(entry, "id");
      return {
        id,
        title: clean(text(entry, "title")) || "Untitled",
        abstract: clean(text(entry, "summary")),
        authors: [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((a) => clean(a[1] ?? "")).filter(Boolean),
        year: Number((text(entry, "published") || "").slice(0, 4)) || undefined,
        venue: "arXiv",
        doi: normalizeDoi(text(entry, "arxiv:doi")),
        url: id,
        sourceDb: "arxiv",
        raw: { entry, pdfUrl: arxivPdfUrl(entry), categories: arxivCategories(entry) }
      };
    });
  }
  async fetch(id: string): Promise<PaperHit | null> {
    const arxivId = normalizeArxivId(id);
    if (!arxivId) return null;
    const url = new URL("https://export.arxiv.org/api/query");
    url.searchParams.set("id_list", arxivId);
    url.searchParams.set("max_results", "1");
    const xml = await getText(url.toString());
    const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1] ?? "";
    if (!entry) return null;
    const entryId = text(entry, "id");
    return {
      id: entryId || arxivId,
      title: clean(text(entry, "title")) || "Untitled",
      abstract: clean(text(entry, "summary")),
      authors: [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((a) => clean(a[1] ?? "")).filter(Boolean),
      year: Number((text(entry, "published") || "").slice(0, 4)) || undefined,
      venue: "arXiv",
      doi: normalizeDoi(text(entry, "arxiv:doi")),
      url: entryId || `https://arxiv.org/abs/${arxivId}`,
      sourceDb: "arxiv",
      raw: { entry, pdfUrl: arxivPdfUrl(entry), categories: arxivCategories(entry) }
    };
  }
}

export class CrossrefConnector implements LiteratureConnector {
  id = "crossref";
  name = "Crossref";
  description = "Cross-publisher DOI metadata and citation records.";
  metadata = {
    capabilities: { search: true, fetch: true, citationGraph: "search_result" as const, abstracts: true, doi: true, fullTextLinks: true },
    queryHints: ["Use article titles, DOI fragments, author names, or concise topic terms.", "Crossref is best used as DOI metadata corroboration rather than topical recall."],
    bestFor: ["DOI metadata", "publisher records", "bibliographic verification"]
  };
  async search(input: LiteratureSearchInput): Promise<PaperHit[]> {
    const url = new URL("https://api.crossref.org/works");
    url.searchParams.set("query", input.query);
    url.searchParams.set("rows", String(input.limit ?? 25));
    const json = await getJson<any>(url.toString());
    return (json.message?.items ?? []).map((item: any): PaperHit => ({
      id: item.DOI ? `https://doi.org/${item.DOI}` : item.URL,
      title: item.title?.[0] ?? "Untitled",
      abstract: stripTags(item.abstract ?? ""),
      authors: (item.author ?? []).map((a: any) => [a.given, a.family].filter(Boolean).join(" ")).filter(Boolean),
      year: item.issued?.["date-parts"]?.[0]?.[0],
      venue: item["container-title"]?.[0],
      doi: normalizeDoi(item.DOI),
      url: item.URL,
      sourceDb: "crossref",
      citationCount: item["is-referenced-by-count"],
      references: (item.reference ?? []).map((r: any) => r.DOI ? `https://doi.org/${r.DOI}` : r.article_title).filter(Boolean),
      raw: item
    }));
  }
  async fetch(id: string): Promise<unknown> {
    const doi = normalizeDoi(id);
    if (!doi) return null;
    return getJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
  }
}

export class PubMedConnector implements LiteratureConnector {
  id = "pubmed";
  name = "PubMed";
  description = "Biomedical literature abstracts and citations from NCBI.";
  metadata = {
    capabilities: { search: true, fetch: true, citationGraph: "none" as const, abstracts: true, doi: true, fullTextLinks: true },
    queryHints: ["Use biomedical concepts, MeSH-like terms, gene/protein names, and disease terms.", "Best used for life-science and clinical questions."],
    rateLimit: "NCBI E-utilities public rate limits apply; use an API key for heavy use.",
    bestFor: ["biomedicine", "clinical literature", "life sciences"]
  };
  async search(input: LiteratureSearchInput): Promise<PaperHit[]> {
    const size = Math.min(input.limit ?? 25, 50);
    const esearch = await getJson<any>(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&sort=relevance&retmax=${size}&term=${encodeURIComponent(input.query)}`);
    const ids: string[] = esearch.esearchresult?.idlist ?? [];
    if (!ids.length) return [];
    const esummary = await getJson<any>(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(",")}`);
    return ids.map((id) => esummary.result?.[id]).filter(Boolean).map((s: any): PaperHit => ({
      id: s.uid,
      title: clean(s.title ?? `PMID ${s.uid}`),
      authors: (s.authors ?? []).map((a: any) => a.name).filter(Boolean),
      year: Number(String(s.pubdate ?? "").slice(0, 4)) || undefined,
      venue: s.fulljournalname ?? s.source,
      doi: normalizeDoi(s.elocationid),
      url: `https://pubmed.ncbi.nlm.nih.gov/${s.uid}/`,
      sourceDb: "pubmed",
      raw: s
    }));
  }
  async fetch(id: string): Promise<unknown> {
    const cleanId = id.replace(/[^0-9]/g, "");
    const abstract = await getText(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&rettype=abstract&retmode=text&id=${cleanId}`);
    return { id: cleanId, abstract: abstract.trim(), url: `https://pubmed.ncbi.nlm.nih.gov/${cleanId}/` };
  }
}

export class EuropePmcConnector implements LiteratureConnector {
  id = "europepmc";
  name = "Europe PMC";
  description = "Life-science literature and full-text metadata from Europe PMC.";
  metadata = {
    capabilities: { search: true, fetch: true, citationGraph: "search_result" as const, abstracts: true, doi: true, fullTextLinks: true },
    queryHints: ["Use life-science terms and DOI/PMID identifiers.", "Good companion source for PubMed when full-text metadata matters."],
    bestFor: ["life sciences", "open full text metadata", "citation counts"]
  };
  async search(input: LiteratureSearchInput): Promise<PaperHit[]> {
    const size = Math.min(input.limit ?? 25, 50);
    const json = await getJson<any>(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(input.query)}&format=json&resultType=core&pageSize=${size}`);
    return (json.resultList?.result ?? []).map((r: any): PaperHit => ({
      id: r.source && r.id ? `${r.source}/${r.id}` : r.id,
      title: clean(r.title ?? "Untitled"),
      abstract: stripTags(r.abstractText ?? ""),
      authors: r.authorString ? r.authorString.split(",").map((s: string) => s.trim()).filter(Boolean) : undefined,
      year: Number(r.pubYear) || undefined,
      venue: r.journalInfo?.journal?.title ?? r.journalTitle,
      doi: normalizeDoi(r.doi),
      url: r.source && r.id ? `https://europepmc.org/article/${r.source}/${r.id}` : (r.doi ? `https://doi.org/${r.doi}` : undefined),
      sourceDb: "europepmc",
      citationCount: r.citedByCount,
      raw: r
    }));
  }
  async fetch(id: string): Promise<unknown> {
    const slash = id.indexOf("/");
    const query = slash > 0 ? `ext_id:${id.slice(slash + 1)} AND src:${id.slice(0, slash)}` : id;
    const json = await getJson<any>(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query)}&format=json&resultType=core&pageSize=1`);
    return json.resultList?.result?.[0] ?? null;
  }
}

export class SemanticScholarConnector implements LiteratureConnector {
  id = "semantic-scholar";
  name = "Semantic Scholar";
  description = "Academic graph metadata, citation counts, references, and citations.";
  metadata = {
    capabilities: { search: true, fetch: true, citationGraph: "fetch" as const, abstracts: true, doi: true, fullTextLinks: true },
    queryHints: ["Use paper titles for precise fetch/search.", "Use broad English topic terms for graph discovery.", "API key improves reliability and rate limits."],
    rateLimit: "Unauthenticated Graph API is rate limited; set SEMANTIC_SCHOLAR_API_KEY for sustained use.",
    bestFor: ["citation graph", "references and citations", "cross-domain academic metadata"]
  };
  async search(input: LiteratureSearchInput): Promise<PaperHit[]> {
    const limit = Math.min(input.limit ?? 25, 50);
    const key = process.env.SEMANTIC_SCHOLAR_API_KEY?.trim();
    const json = await getJson<any>(
      `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(input.query)}&limit=${limit}&fields=title,abstract,url,year,venue,citationCount,externalIds,authors.name,openAccessPdf`,
      key ? { "x-api-key": key } : undefined
    );
    return (json.data ?? []).map((p: any): PaperHit => ({
      id: p.paperId,
      title: clean(p.title ?? "Untitled"),
      abstract: p.abstract,
      authors: (p.authors ?? []).map((a: any) => a.name).filter(Boolean),
      year: p.year,
      venue: p.venue,
      doi: normalizeDoi(p.externalIds?.DOI),
      url: p.url,
      sourceDb: "semantic-scholar",
      citationCount: p.citationCount,
      raw: p
    }));
  }
  async fetch(id: string): Promise<unknown> {
    const key = process.env.SEMANTIC_SCHOLAR_API_KEY?.trim();
    return getJson(
      `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(id.trim())}?fields=title,abstract,url,year,venue,citationCount,externalIds,authors.name,openAccessPdf,references.paperId,references.title,references.year,references.externalIds,references.url,citations.paperId,citations.title,citations.year,citations.externalIds,citations.url`,
      key ? { "x-api-key": key } : undefined
    );
  }
}

export class BioRxivConnector implements LiteratureConnector {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  constructor(private server: "biorxiv" | "medrxiv") {
    this.id = server;
    this.name = server === "biorxiv" ? "bioRxiv" : "medRxiv";
    this.description = `${this.name} preprint metadata from Cold Spring Harbor.`;
  }
  metadata = {
    capabilities: { search: true, fetch: false, citationGraph: "none" as const, abstracts: true, doi: true, fullTextLinks: true },
    queryHints: ["Searches recent preprints by local keyword filtering.", "Use concise biomedical terms; broad generic terms can be noisy."],
    bestFor: ["recent biomedical preprints", "pre-publication findings"]
  };
  async search(input: LiteratureSearchInput): Promise<PaperHit[]> {
    const limit = input.limit ?? 25;
    const from = new Date(Date.now() - 1000 * 60 * 60 * 24 * 365 * 3).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    const json = await getJson<any>(`https://api.biorxiv.org/details/${this.server}/${from}/${to}/0`);
    const terms = input.query.toLowerCase().split(/\s+/).filter((t) => t.length > 3);
    return (json.collection ?? [])
      .filter((p: any) => terms.length === 0 || terms.some((term) => `${p.title} ${p.abstract}`.toLowerCase().includes(term)))
      .slice(0, limit)
      .map((p: any): PaperHit => ({
        id: `${this.server}:${p.doi}`,
        title: clean(p.title ?? p.doi ?? "Untitled preprint"),
        abstract: stripTags(p.abstract ?? ""),
        authors: p.authors ? String(p.authors).split(";").map((s) => s.trim()).filter(Boolean) : undefined,
        year: Number(String(p.date ?? "").slice(0, 4)) || undefined,
        venue: this.name,
        doi: normalizeDoi(p.doi),
        url: p.doi ? `https://www.${this.server}.org/content/${p.doi}v${p.version ?? "1"}` : undefined,
        sourceDb: this.id,
        raw: p
      }));
  }
}

function reconstructOpenAlexAbstract(index: Record<string, number[]> | null | undefined): string | undefined {
  if (!index) return undefined;
  const words: [string, number][] = [];
  for (const [word, positions] of Object.entries(index)) for (const pos of positions) words.push([word, pos]);
  return words.sort((a, b) => a[1] - b[1]).map(([word]) => word).join(" ");
}

function text(xml: string, tag: string): string {
  return xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))?.[1] ?? "";
}

function clean(value: string): string {
  return stripTags(value).replace(/\s+/g, " ").trim();
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function normalizeDoi(value?: string): string | undefined {
  const doi = value?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").trim();
  return doi || undefined;
}

function normalizeOpenAlexWorkId(value: string): string {
  const trimmed = value.trim();
  if (/^https:\/\/openalex\.org\/W/i.test(trimmed)) return trimmed.replace(/^https:\/\/openalex\.org\//i, "");
  if (/^W\d+$/i.test(trimmed)) return trimmed;
  return trimmed.replace(/^https?:\/\/api\.openalex\.org\/works\//i, "");
}

function normalizeArxivId(value: string): string | undefined {
  const trimmed = value.trim();
  const fromUrl = trimmed.match(/arxiv\.org\/(?:abs|pdf)\/([^?#\s]+)/i)?.[1];
  const raw = (fromUrl ?? trimmed).replace(/\.pdf$/i, "");
  const match = raw.match(/(?:arXiv:)?([a-z-]+\/\d{7}|\d{4}\.\d{4,5})(v\d+)?/i);
  return match?.[0]?.replace(/^arXiv:/i, "");
}

function arxivPdfUrl(entry: string): string | undefined {
  return entry.match(/<link[^>]+title="pdf"[^>]+href="([^"]+)"/)?.[1]
    ?? entry.match(/<link[^>]+href="([^"]+\.pdf[^"]*)"/)?.[1];
}

function arxivCategories(entry: string): string[] {
  return [...entry.matchAll(/<category[^>]+term="([^"]+)"/g)].map((m) => m[1]).filter(Boolean);
}

function connectorCapability(connector: LiteratureConnector): ConnectorMetadata {
  return connector.metadata ?? {
    capabilities: {
      search: true,
      fetch: Boolean(connector.fetch),
      citationGraph: connector.fetch ? "fetch" : "none",
      abstracts: true,
      doi: true,
      fullTextLinks: false
    },
    queryHints: ["Use concise scholarly keywords and source-native identifiers where available."],
    bestFor: ["general literature metadata"]
  };
}

function extractCitationGraph(record: unknown): { references: any[]; citations: any[] } {
  const value = record as any;
  if (!value) return { references: [], citations: [] };
  return {
    references: Array.isArray(value.references) ? value.references : [],
    citations: Array.isArray(value.citations) ? value.citations : []
  };
}

function citationGraphSummary(items: any[]): any[] {
  return items.slice(0, 25).map((item) => {
    if (typeof item === "string") return { id: item };
    return {
      id: item.paperId ?? item.id ?? item.DOI ?? item.doi,
      title: item.title ?? item.article_title,
      year: item.year,
      doi: normalizeDoi(item.externalIds?.DOI ?? item.DOI ?? item.doi),
      url: item.url
    };
  });
}

const objectSchema = { type: "object" };
const requiredString = { type: "string", minLength: 1 };
const paperArray = { type: "array", items: { type: "object" } };

export const scienceListDbsTool: ToolDefinition<any, any> = {
  id: "science_list_dbs",
  name: "Science List DBs",
  description: "List available literature databases.",
  inputSchema: { type: "object", properties: {} },
  outputSchema: objectSchema,
  permission: { kind: "network", default: "allow" },
  async execute(ctx) {
    const registry = getLiteratureConnectorRegistry(ctx.runtime);
    return {
      databases: registry.list().map((db) => {
        const metadata = connectorCapability(db);
        return {
          id: db.id,
          name: db.name,
          description: db.description,
          capabilities: metadata.capabilities,
          operations: ["search", db.fetch ? "fetch" : undefined].filter(Boolean),
          queryHints: metadata.queryHints,
          rateLimit: metadata.rateLimit,
          bestFor: metadata.bestFor ?? []
        };
      })
    };
  }
};

export const scienceSearchTool: ToolDefinition<any, any> = {
  id: "science_search",
  name: "Science Search",
  description: "Search a literature database by db id.",
  inputSchema: { type: "object", required: ["db", "query"], properties: { db: requiredString, query: requiredString, limit: { type: "integer", minimum: 1 } } },
  outputSchema: objectSchema,
  permission: { kind: "network", default: "allow" },
  async execute(ctx, input) {
    const registry = getLiteratureConnectorRegistry(ctx.runtime);
    const db = normalizeLiteratureDatabaseIds(input.db, registry)[0] ?? String(input.db);
    const connector = registry.get(db);
    if (!connector) {
      const structuredError = sourceError(String(input.db), "search", new SourceRequestError("unsupported", false, `Connector ${String(input.db)} is not registered.`));
      const artifact = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "search_error", db: input.db, query: input.query, error: structuredError }, null, 2) });
      return { ...structuredError, query: input.query, count: 0, results: [], artifactId: artifact.id };
    }
    try {
      const results = await connector.search({ query: String(input.query), limit: Number(input.limit ?? 25) });
      const artifact = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "search_results", db, query: input.query, requestedDb: input.db, results }, null, 2) });
      await ctx.recordProvenance({ nodes: [{ type: "artifact", refId: artifact.id, label: `Search results from ${db}` }], edges: [] });
      return { ok: true, db, query: input.query, count: results.length, results, artifactId: artifact.id };
    } catch (error) {
      const structuredError = sourceError(db, "search", error);
      const artifact = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "search_error", db, query: input.query, requestedDb: input.db, error: structuredError }, null, 2) });
      return { ...structuredError, query: input.query, count: 0, results: [], artifactId: artifact.id };
    }
  }
};

export const paperFetchTool: ToolDefinition<any, any> = {
  id: "paper_fetch",
  name: "Paper Fetch",
  description: "Fetch a single paper record from a literature connector when supported.",
  inputSchema: { type: "object", required: ["db", "id"], properties: { db: requiredString, id: requiredString } },
  outputSchema: objectSchema,
  permission: { kind: "network", default: "allow" },
  async execute(ctx, input) {
    const connector = getLiteratureConnectorRegistry(ctx.runtime).get(String(input.db));
    if (!connector) throw new RuntimeError("LITERATURE_DB_NOT_FOUND", String(input.db));
    if (!connector.fetch) {
      const error = sourceError(String(input.db), "fetch", new SourceRequestError("unsupported", false, `Connector ${input.db} does not support fetch.`));
      return { ...error, id: input.id, fetched: false, record: null };
    }
    try {
      const record = await connector.fetch(String(input.id));
      const graph = extractCitationGraph(record);
      const artifact = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "paper_fetch", db: input.db, id: input.id, record, citationGraph: graph }, null, 2) });
      return { ok: true, db: input.db, id: input.id, fetched: true, record, citationGraph: graph, artifactId: artifact.id };
    } catch (error) {
      const structuredError = sourceError(String(input.db), "fetch", error);
      const artifact = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "paper_fetch_error", db: input.db, id: input.id, error: structuredError }, null, 2) });
      return { ...structuredError, id: input.id, fetched: false, record: null, artifactId: artifact.id };
    }
  }
};

export const paperDeduplicateTool: ToolDefinition<any, any> = {
  id: "paper_deduplicate",
  name: "Paper Deduplicate",
  description: "Deduplicate papers by DOI and normalized title.",
  inputSchema: { type: "object", required: ["papers"], properties: { papers: paperArray } },
  outputSchema: objectSchema,
  permission: { kind: "runtime" },
  async execute(ctx, input) {
    const seen = new Map<string, PaperHit>();
    const duplicates: any[] = [];
    for (const paper of input.papers ?? []) {
      const key = paper.doi ? `doi:${normalizeDoi(String(paper.doi))}` : `title:${paper.title.toLowerCase().replace(/\W+/g, " ").trim()}:${paper.year ?? ""}`;
      if (seen.has(key)) duplicates.push({ keptId: seen.get(key)!.id, duplicateId: paper.id, reason: key.startsWith("doi:") ? "doi" : "title_year" });
      else seen.set(key, paper);
    }
    const papers = [...seen.values()];
    const artifact = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "deduplication", recordsBefore: (input.papers ?? []).length, recordsAfter: papers.length, deduped: papers, duplicates }, null, 2) });
    return { papers, duplicateCount: duplicates.length, duplicates, artifactId: artifact.id };
  }
};

export const citationChainTool: ToolDefinition<any, any> = {
  id: "citation_chain",
  name: "Citation Chain",
  description: "Collect forward/backward citation hints for seed papers where metadata supports it.",
  inputSchema: { type: "object", required: ["papers"], properties: { papers: paperArray, limit: { type: "integer", minimum: 1 } } },
  outputSchema: objectSchema,
  permission: { kind: "network", default: "allow" },
  async execute(ctx, input) {
    const seeds: PaperHit[] = input.papers ?? [];
    const records = [];
    const errors: SourceError[] = [];
    for (const paper of seeds.slice(0, Number(input.limit ?? 5))) {
      const connector = getLiteratureConnectorRegistry(ctx.runtime).get(paper.sourceDb);
      let fetched: unknown = null;
      let fetchArtifactId: string | undefined;
      if (connector?.fetch) {
        const fetchId = paper.id || paper.doi || paper.url;
        try {
          fetched = await connector.fetch(String(fetchId));
          const fetchArtifact = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "citation_chain_fetch", db: paper.sourceDb, id: fetchId, record: fetched }, null, 2) });
          fetchArtifactId = fetchArtifact.id;
        } catch (error) {
          errors.push(sourceError(paper.sourceDb, "citation_chain", error));
        }
      }
      const graph = extractCitationGraph(fetched ?? paper);
      const references = citationGraphSummary(graph.references.length ? graph.references : (paper.references ?? []));
      const citations = citationGraphSummary(graph.citations.length ? graph.citations : (paper.citations ?? []));
      records.push({
        paperId: paper.id,
        title: paper.title,
        sourceDb: paper.sourceDb,
        fetched: Boolean(fetched),
        fetchArtifactId,
        references,
        citations,
        referenceCount: references.length,
        citationCount: citations.length,
        note: references.length || citations.length ? "citation graph metadata collected" : connector?.fetch ? "fetch returned no citation graph metadata" : "connector does not support fetch"
      });
    }
    const artifact = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "citation_chaining", seedCount: seeds.length, records, errors }, null, 2) });
    return { ok: errors.length === 0, records, errors, artifactId: artifact.id };
  }
};

export const citationVerifyTool: ToolDefinition<any, any> = {
  id: "citation_verify",
  name: "Citation Verify",
  description: "Verify basic citation metadata and flag missing identifiers.",
  inputSchema: { type: "object", required: ["papers"], properties: { papers: paperArray } },
  outputSchema: objectSchema,
  permission: { kind: "runtime" },
  async execute(ctx, input) {
    const papers: PaperHit[] = input.papers ?? [];
    const results = papers.map((paper) => {
      const issues = [
        !paper.title ? "missing_title" : undefined,
        !paper.year ? "missing_year" : undefined,
        !paper.doi && !paper.url ? "missing_doi_or_url" : undefined,
        !paper.authors?.length ? "missing_authors" : undefined
      ].filter(Boolean);
      return { paperId: paper.id, title: paper.title, doi: paper.doi, url: paper.url, verified: issues.length === 0, issues };
    });
    const artifact = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "citation_verification", results }, null, 2) });
    return { ok: results.every((r) => r.verified), results, artifactId: artifact.id };
  }
};

export const bibtexWriteTool: ToolDefinition<any, any> = {
  id: "bibtex_write",
  name: "BibTeX Write",
  description: "Create BibTeX entries for included papers.",
  inputSchema: { type: "object", required: ["papers"], properties: { papers: paperArray } },
  outputSchema: objectSchema,
  permission: { kind: "runtime" },
  async execute(ctx, input) {
    const entries = (input.papers ?? []).map((paper: PaperHit, i: number) => renderBibtex(paper, i)).join("\n\n");
    const artifact = await ctx.createArtifact({ type: "bibtex", mediaType: "text/x-bibtex", content: entries });
    return { artifactId: artifact.id, entries };
  }
};

export const prismaFlowWriteTool: ToolDefinition<any, any> = {
  id: "prisma_flow_write",
  name: "PRISMA Flow Write",
  description: "Create a PRISMA-style flow artifact.",
  inputSchema: objectSchema,
  outputSchema: objectSchema,
  permission: { kind: "runtime" },
  async execute(ctx, input) {
    const artifact = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "prisma_flow", ...input }, null, 2) });
    return { artifactId: artifact.id };
  }
};

export const evidenceTableWriteTool: ToolDefinition<any, any> = {
  id: "evidence_table_write",
  name: "Evidence Table Write",
  description: "Write an evidence table artifact.",
  inputSchema: objectSchema,
  outputSchema: objectSchema,
  permission: { kind: "runtime" },
  async execute(ctx, input) {
    const artifact = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "evidence_table", ...input }, null, 2) });
    return { artifactId: artifact.id };
  }
};

export const citationCheckTool: ToolDefinition<any, any> = {
  id: "citation_check",
  name: "Citation Check",
  description: "Check whether cited paper ids exist in the supplied paper set.",
  inputSchema: { type: "object", required: ["papers", "citations"], properties: { papers: paperArray, citations: { type: "array", items: requiredString } } },
  outputSchema: objectSchema,
  permission: { kind: "runtime" },
  async execute(_ctx, input) {
    const ids = new Set((input.papers ?? []).map((p: PaperHit) => p.id));
    const missing = (input.citations ?? []).filter((id: string) => !ids.has(id));
    return { ok: missing.length === 0, missing };
  }
};

const agents = [
  { id: "literature-orchestrator", name: "Literature Orchestrator", description: "Coordinates PRISMA-style literature review tasks.", mode: "subagent" as const, prompt: "Coordinate a PRISMA-style literature review using artifacts for all intermediate outputs.", permissions: [], allowedTools: ["task", "artifact_read", "artifact_write", "finalize"], maxTurns: 8 },
  { id: "literature-query-agent", name: "Literature Query Agent", description: "Builds search plans and inclusion/exclusion criteria.", mode: "subagent" as const, prompt: "Define research question, concepts, selected queries, alternative queries, and IC/EC criteria before screening.", permissions: [], allowedTools: ["artifact_write", "finalize"], maxTurns: 6 },
  { id: "literature-search-agent", name: "Literature Search Agent", description: "Runs multi-database literature searches and citation chaining.", mode: "subagent" as const, prompt: "Search multiple scientific databases, record source errors, and avoid fabricating records.", permissions: [], allowedTools: ["science_list_dbs", "science_search", "paper_fetch", "citation_chain", "paper_deduplicate", "artifact_write", "finalize"], maxTurns: 6 },
  { id: "literature-screening-agent", name: "Literature Screening Agent", description: "Screens candidate papers using explicit IC/EC rules.", mode: "subagent" as const, prompt: "Apply explicit inclusion/exclusion criteria and record a reason for every decision.", permissions: [], allowedTools: ["artifact_read", "artifact_write", "finalize"], maxTurns: 6 },
  { id: "literature-eligibility-agent", name: "Literature Eligibility Agent", description: "Assesses eligible papers using available abstract/full-text metadata.", mode: "subagent" as const, prompt: "Assess abstract/full-text eligibility and record exclusion reasons.", permissions: [], allowedTools: ["artifact_read", "artifact_write", "finalize"], maxTurns: 6 },
  { id: "literature-quality-agent", name: "Literature Quality Agent", description: "Assigns evidence quality tiers.", mode: "subagent" as const, prompt: "Assign quality tiers using venue, peer review, citation metadata, recency, and available empirical detail.", permissions: [], allowedTools: ["artifact_read", "artifact_write", "finalize"], maxTurns: 6 },
  { id: "literature-synthesis-agent", name: "Literature Synthesis Agent", description: "Synthesizes evidence and contradictions thematically.", mode: "subagent" as const, prompt: "Synthesize evidence thematically. Every claim must cite evidence rows; explicitly flag contradictions.", permissions: [], allowedTools: ["artifact_read", "evidence_table_write", "artifact_write", "finalize"], maxTurns: 6 },
  { id: "literature-citation-agent", name: "Literature Citation Agent", description: "Verifies citations and writes BibTeX.", mode: "subagent" as const, prompt: "Verify citations and generate BibTeX. Mark unverified records explicitly.", permissions: [], allowedTools: ["citation_verify", "bibtex_write", "artifact_read", "artifact_write", "finalize"], maxTurns: 6 },
  { id: "literature-reviewer-agent", name: "Literature Reviewer", description: "Checks citation, evidence, claim, and PRISMA integrity.", mode: "subagent" as const, prompt: "Blindly audit citation support, untraceable claims, screening completeness, and PRISMA count consistency. Record findings if needed.", permissions: [], allowedTools: ["artifact_read", "citation_check", "review_finding_write", "finalize"], maxTurns: 6 }
];

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
          const topicProfile = topicProfileFromQueries(agentQueries, ctx.input, ctx.metadata.topicProfile);
          return { artifactIds: briefArtifact ? [briefArtifact.id] : [], statePatch: { limit: Number(agentProtocol.limit ?? ctx.metadata.limit ?? 25), dbs, criteria: agentProtocol.criteria ?? agentQueries.criteria ?? defaultCriteria(), queryPlan: agentQueries, topicProfile, researchBriefArtifactId: briefArtifact?.id } };
        }
        const limit = Number(ctx.metadata.limit ?? 25);
        const dbs = metadataDbs.length ? metadataDbs : ["openalex", "semantic-scholar", "crossref"];
        const criteria = defaultCriteria();
        const queryPlan = buildQueryPlan(ctx.input, dbs, criteria, ctx.metadata.topicProfile);
        const briefArtifact = await ensureResearchBriefArtifact(ctx);
        const protocol = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "protocol", question: ctx.input, databases: dbs, limit, criteria, conceptDefinition: queryPlan.conceptDefinition, appliedPreferences: protocolPreferenceSummary(ctx.metadata), workflow: ctx.contract.stages.map((s) => s.id) }, null, 2) });
        const queries = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify(queryPlan, null, 2) });
        return { artifactIds: [briefArtifact?.id, protocol.id, queries.id].filter(Boolean) as string[], statePatch: { limit, dbs, criteria, queryPlan, topicProfile: topicProfileFromQueries(queryPlan, ctx.input, ctx.metadata.topicProfile), researchBriefArtifactId: briefArtifact?.id, protocolArtifactId: protocol.id, queriesArtifactId: queries.id } };
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
        const selectedQueries = normalizeSelectedQueries(queryPlan).map((query) => ({
          ...query,
          database: normalizeLiteratureDatabaseIds(query.database, registry)[0] ?? query.database
        }));
        for (const db of dbs) {
          const querySpec = selectedQueries.find((q: any) => q.database === db);
          const queries = uniqueQueries([querySpec?.query ?? ctx.input, ...(querySpec?.fallbackQueries ?? []), ...dbFallbackQueries(db, ctx.input, ctx.state.topicProfile as TopicProfile | undefined)]);
          const { out, artifactIds, errors } = await searchWithFallback(ctx, db, queries, limit);
          allPapers.push(...(out.results ?? []));
          searchCounts[db] = out.count ?? 0;
          sourceErrors.push(...errors);
          if (out.ok === false && !errors.includes(out)) sourceErrors.push(out);
          else if (out.error) sourceErrors.push({ db, error: out.error });
          searchArtifactIds.push(...artifactIds);
        }
        const chain = await ctx.tool({ toolId: "citation_chain", input: { papers: allPapers.slice(0, 5), limit: 5 } });
        const citationChainArtifactId = (chain.output as any).artifactId as string;
        const citationChainRecords = (chain.output as any).records ?? [];
        const citationChainHintsFound = citationChainRecords.reduce((sum: number, record: any) => sum + Number(record.referenceCount ?? 0) + Number(record.citationCount ?? 0), 0);
        const recordsIdentifiedThroughCitationChaining = 0;
        if (Array.isArray((chain.output as any).errors)) sourceErrors.push(...(chain.output as any).errors);
        const identification = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "identification", searchCounts, sourceErrors, appliedPreferences: protocolPreferenceSummary(ctx.metadata), recordsIdentifiedThroughDatabaseSearching: allPapers.length, recordsIdentifiedThroughCitationChaining, citationChainHintsFound }, null, 2) });
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
        const agentScreeningHasPreferences = !hasResearchBrief(ctx.metadata) || agentScreening?.decisions?.every((d: any) => typeof d.preferenceScore === "number");
        if (agentScreening?.decisions && agentScreeningHasPreferences) {
          const screeningDecisions = agentScreening.decisions;
          const screenedIn = screeningDecisions.filter((d: any) => d.decision === "include").map((d: any) => deduped.find((p) => p.id === d.paperId)!).filter(Boolean);
          return { statePatch: { screeningDecisions, screenedIn } };
        }
        const criteria = ctx.state.criteria ?? defaultCriteria();
        const topicProfile = (ctx.state.topicProfile as TopicProfile | undefined) ?? topicProfileFromQueries(ctx.state.queryPlan, ctx.input, ctx.metadata.topicProfile);
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

function defaultCriteria() {
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

async function ensureResearchBriefArtifact(ctx: any): Promise<Artifact | null> {
  if (!hasResearchBrief(ctx.metadata)) return null;
  const existing = await readStageArtifact(ctx.services, ctx.artifactIds, "research_brief");
  if (existing) return null;
  return ctx.createArtifact({
    type: "json",
    mediaType: "application/json",
    content: JSON.stringify({
      stage: "research_brief",
      researchQuestion: ctx.input,
      researchBrief: ctx.metadata.researchBrief,
      compiledMetadata: compactObject({
        topicProfile: ctx.metadata.topicProfile,
        sourcePreferences: ctx.metadata.sourcePreferences,
        evidencePreferences: ctx.metadata.evidencePreferences,
        outputPreferences: ctx.metadata.outputPreferences,
        inclusionCriteria: ctx.metadata.inclusionCriteria,
        exclusionCriteria: ctx.metadata.exclusionCriteria,
        dbs: ctx.metadata.dbs,
        limit: ctx.metadata.limit
      }),
      audit: {
        source: "runtime metadata",
        createdByStage: "protocol_query",
        note: "This artifact freezes the user brief and compiled metadata used by downstream screening, eligibility, and synthesis checks."
      }
    }, null, 2)
  });
}

function hasResearchBrief(metadata: any): boolean {
  return Boolean(metadata?.researchBrief);
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

function protocolPreferenceSummary(metadata: any): any {
  return compactObject({
    sourcePreferences: metadata?.sourcePreferences,
    evidencePreferences: metadata?.evidencePreferences,
    outputPreferences: metadata?.outputPreferences,
    inclusionCriteria: metadata?.inclusionCriteria,
    exclusionCriteria: metadata?.exclusionCriteria
  });
}

const literatureStageVerifiers: StageVerifierDefinition[] = [
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
      const conceptTerms = Array.isArray(queries?.concepts) ? queries.concepts.flatMap((concept: any) => [concept.name, concept.label, ...(concept.synonyms ?? [])]).filter(Boolean) : [];
      const hasDefinition = Boolean(queries?.conceptDefinition?.definition || queries?.concept_definition?.definition || conceptTerms.length);
      const hasCore = coreTerms.length >= 3 || termsOf(conceptTerms).length >= 3;
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
      const topicProfile = topicProfileFromQueries(queries);
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

async function readStageArtifact(services: RuntimeServices, artifactIds: string[], stage: string): Promise<any | null> {
  for (const id of [...artifactIds].reverse()) {
    const artifact = await services.artifactStore.get(id);
    if (!artifact || artifact.mediaType !== "application/json") continue;
    try {
      const parsed = JSON.parse((await services.artifactStore.read(id)).toString("utf8"));
      if (parsed?.stage === stage) return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

function getQuestion(value: any): string | undefined {
  return value?.question ?? value?.researchQuestion ?? value?.research_question;
}

function normalizeDatabases(value: any): string[] {
  const databases = value?.databases ?? value?.databasePlan ?? value?.database_plan ?? [];
  if (!Array.isArray(databases)) return [];
  return databases.map((db: any) => typeof db === "string" ? db : (db?.id ?? db?.name ?? db?.database)).filter(Boolean).map(String);
}

const databaseAliases: Record<string, string> = {
  openalex: "openalex",
  "open alex": "openalex",
  arxiv: "arxiv",
  "semantic scholar": "semantic-scholar",
  semanticscholar: "semantic-scholar",
  "semantic-scholar": "semantic-scholar",
  crossref: "crossref",
  pubmed: "pubmed",
  "pub med": "pubmed",
  europepmc: "europepmc",
  "europe pmc": "europepmc",
  biorxiv: "biorxiv",
  "bio rxiv": "biorxiv",
  medrxiv: "medrxiv",
  "med rxiv": "medrxiv"
};

export function normalizeLiteratureDatabaseIds(value: any, registry?: LiteratureConnectorRegistry, fallback: string[] = []): string[] {
  const available = registry ? new Set(registry.list().map((connector) => connector.id)) : new Set<string>();
  const aliases = new Map<string, string>();
  for (const [alias, id] of Object.entries(databaseAliases)) aliases.set(databaseKey(alias), id);
  for (const connector of registry?.list() ?? []) {
    aliases.set(databaseKey(connector.id), connector.id);
    aliases.set(databaseKey(connector.name), connector.id);
  }

  const normalized: string[] = [];
  for (const candidate of databaseCandidates(value)) {
    const direct = String(candidate).trim();
    if (!direct) continue;
    const id = aliases.get(databaseKey(direct)) ?? direct;
    if (available.size && !available.has(id)) continue;
    if (!normalized.includes(id)) normalized.push(id);
  }
  return normalized.length ? normalized : fallback;
}

function databaseCandidates(value: any): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => databaseCandidates(item));
  if (typeof value === "string") return [value];
  if (typeof value === "object") {
    return [value.id, value.name, value.database, value.db, value.source].filter((item) => typeof item === "string");
  }
  return [String(value)];
}

function databaseKey(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeSelectedQueries(value: any): { database?: string; query?: string; rationale?: string; fallbackQueries?: string[] }[] {
  const raw = value?.selectedQueries ?? value?.selected_queries ?? value?.queries ?? [];
  if (!Array.isArray(raw)) return [];
  return raw.map((query: any) => ({
    database: query?.database ?? query?.db ?? query?.source,
    query: query?.query ?? query?.queryString ?? query?.query_string,
    rationale: query?.rationale ?? query?.query_logic,
    fallbackQueries: Array.isArray(query?.fallbackQueries ?? query?.fallback_queries) ? (query.fallbackQueries ?? query.fallback_queries).map(String) : undefined
  })).filter((query) => query.database || query.query);
}

async function searchWithFallback(ctx: any, db: string, queries: string[], limit: number): Promise<{ out: any; artifactIds: string[]; errors: any[] }> {
  const artifactIds: string[] = [];
  const errors: any[] = [];
  let lastOut: any = { ok: false, db, count: 0, results: [] };
  for (let index = 0; index < queries.length; index += 1) {
    const query = queries[index];
    const result = await ctx.tool({ toolId: "science_search", input: { db, query, limit: index === 0 ? limit : Math.min(limit, db === "arxiv" ? 10 : limit) } });
    const out = result.output as any;
    lastOut = out;
    if (out.artifactId) artifactIds.push(out.artifactId);
    if (out.ok === false) {
      errors.push({ ...out, fallbackAttempt: index, fallbackAvailable: index < queries.length - 1 });
      if (out.retryable && index < queries.length - 1) continue;
    }
    return { out, artifactIds, errors };
  }
  return { out: lastOut, artifactIds, errors };
}

function uniqueQueries(queries: any[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const query of queries) {
    const value = String(query ?? "").trim();
    if (!value) continue;
    const key = normalizeText(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

type TopicProfile = {
  topicLabel?: string;
  coreTerms: string[];
  domainTerms: string[];
  modifierTerms: string[];
};

type PreferenceScore = {
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

function buildQueryPlan(question: string, dbs: string[], criteria: unknown, metadataProfile?: unknown): any {
  const topicProfile = topicProfileFromMetadata(metadataProfile, question);
  const broadQuery = booleanOr(topicProfile.coreTerms);
  const trendQuery = `${broadQuery} AND (review OR survey OR roadmap OR trend OR "current status" OR "future directions")`;
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
    criteria,
    selectedQueries: dbs.map((db) => databaseSearchQuery(db, trendQuery, domainQuery, topicProfile)),
    alternativeQueries: dbs.flatMap((db) => [
      { database: db, query: broadQuery, rationale: "High-precision core concept query." },
      { database: db, query: domainQuery, rationale: "Domain-expansion query from the runtime topic profile." }
    ])
  };
}

function databaseSearchQuery(db: string, trendQuery: string, domainQuery: string, topicProfile: TopicProfile): any {
  const fallbackQueries = dbFallbackQueries(db, topicProfile.topicLabel ?? "", topicProfile);
  if (db === "arxiv") {
    return {
      database: db,
      query: booleanOr(topicProfile.coreTerms.slice(0, 2)),
      fallbackQueries,
      rationale: "arXiv API is more reliable with short technical queries; use fallback queries for recall instead of one long Boolean expression."
    };
  }
  return {
    database: db,
    query: domainQuery ? `${trendQuery} OR ${domainQuery}` : trendQuery,
    fallbackQueries,
    rationale: "Expanded query with core concept anchors, domain terms, and trend/review modifiers."
  };
}

function dbFallbackQueries(db: string, question = "", profile?: TopicProfile): string[] {
  const topicProfile = profile ?? topicProfileFromMetadata(undefined, question);
  const seeds = db === "arxiv"
    ? [...topicProfile.coreTerms.slice(0, 3), ...topicProfile.domainTerms.slice(0, 2)]
    : topicProfile.coreTerms.slice(0, 3);
  return uniqueQueries(seeds.map(quoteQueryTerm));
}

export function toArxivSearchQuery(query: string): string {
  const terms = arxivTerms(query);
  if (!terms.length) return `all:${query}`;
  return terms.map((term) => `all:"${term.replace(/"/g, "")}"`).join(" OR ");
}

function arxivTerms(query: string): string[] {
  const quoted = [...query.matchAll(/"([^"]+)"/g)].map((match) => match[1]).filter(Boolean);
  const fallback = quoted.length ? [] : extractSearchTerms(query);
  return [...new Set([...quoted, ...fallback].map((term) => term.trim()).filter(Boolean))].slice(0, 3);
}

function topicProfileFromMetadata(value: unknown, question: string): TopicProfile {
  const profile = value && typeof value === "object" ? value as any : {};
  const coreTerms = termsOf(profile.coreTerms ?? profile.core_terms);
  const domainTerms = termsOf(profile.domainTerms ?? profile.domain_terms);
  const modifierTerms = termsOf(profile.modifierTerms ?? profile.modifier_terms);
  const extracted = extractSearchTerms(question);
  return {
    topicLabel: typeof profile.topicLabel === "string" ? profile.topicLabel : question,
    coreTerms: coreTerms.length ? coreTerms : extracted,
    domainTerms,
    modifierTerms: modifierTerms.length ? modifierTerms : defaultModifierTerms()
  };
}

function topicProfileFromQueries(queries: any, question = "", metadataProfile?: unknown): TopicProfile {
  const fallback = topicProfileFromMetadata(metadataProfile, question);
  const conceptTerms = conceptTermsOf(queries?.concepts);
  return {
    topicLabel: queries?.researchQuestion ?? queries?.question ?? fallback.topicLabel,
    coreTerms: termsOf(queries?.coreTerms).length ? termsOf(queries?.coreTerms) : conceptTerms.length ? conceptTerms : fallback.coreTerms,
    domainTerms: termsOf(queries?.domainTerms).length ? termsOf(queries?.domainTerms) : fallback.domainTerms,
    modifierTerms: termsOf(queries?.modifierTerms).length ? termsOf(queries?.modifierTerms) : fallback.modifierTerms
  };
}

function termsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((s) => s.trim()).filter(Boolean) : [];
}

function conceptTermsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueQueries(value.flatMap((concept: any) => [
    concept?.name,
    concept?.label,
    concept?.term,
    ...(Array.isArray(concept?.synonyms) ? concept.synonyms : [])
  ]));
}

function defaultModifierTerms(): string[] {
  return ["development status", "current status", "trend", "trends", "future direction", "future directions", "roadmap", "review", "survey", "现状", "趋势", "发展"];
}

function extractSearchTerms(value: string): string[] {
  const quoted = [...value.matchAll(/"([^"]+)"/g)].map((match) => match[1]).filter(Boolean);
  const acronyms = [...value.matchAll(/\b[A-Z][A-Z0-9]{2,}\b/g)].map((match) => match[0]);
  const englishPhrases = value
    .replace(/["()]/g, " ")
    .split(/\b(?:AND|OR|WITH|FOR|IN|ON|OF|THE|A|AN)\b|[,;，；:：]/i)
    .map((part) => part.trim())
    .filter((part) => /[a-zA-Z]/.test(part) && part.length >= 4);
  const chinese = value
    .replace(/[A-Za-z0-9"()]/g, " ")
    .split(/[\s,;，；:：的和与及、]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2 && !defaultModifierTerms().includes(part));
  const whole = value.trim() ? [value.trim()] : [];
  return uniqueQueries([...quoted, ...acronyms, ...englishPhrases, ...chinese, ...whole]).slice(0, 8);
}

function quoteQueryTerm(term: string): string {
  return /\s/.test(term) ? `"${term.replace(/"/g, "")}"` : term;
}

function booleanOr(terms: string[]): string {
  return uniqueQueries(terms).map(quoteQueryTerm).join(" OR ");
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function selectedQueryDbs(queries: any): string[] {
  const selected = Array.isArray(queries?.selectedQueries) ? queries.selectedQueries : [];
  return selected.map((q: any) => q.database).filter((db: unknown): db is string => typeof db === "string" && db.length > 0);
}

async function listArtifactsByType(services: RuntimeServices, artifactIds: string[], type: string): Promise<Artifact[]> {
  const out: Artifact[] = [];
  for (const id of artifactIds) {
    const artifact = await services.artifactStore.get(id);
    if (artifact?.type === type) out.push(artifact);
  }
  return out;
}

function inferConcepts(question: string, profile?: TopicProfile): any[] {
  const topicProfile = profile ?? topicProfileFromMetadata(undefined, question);
  return topicProfile.coreTerms.slice(0, 10).map((name, index) => ({ name, synonyms: [], required: index === 0 }));
}

function topicAnchorScore(paper: PaperHit, profile: TopicProfile): { anchored: boolean; score: number; coreHits: string[]; domainHits: string[]; modifierHits: string[] } {
  const haystack = normalizeText(`${paper.title} ${paper.abstract ?? ""} ${paper.venue ?? ""}`);
  const coreHits = profile.coreTerms.filter((term) => haystack.includes(normalizeText(term)));
  const domainHits = profile.domainTerms.filter((term) => haystack.includes(normalizeText(term)));
  const modifierHits = profile.modifierTerms.filter((term) => haystack.includes(normalizeText(term)));
  const anchored = coreHits.length > 0 || (domainHits.length > 0 && /\b(ai|artificial intelligence|machine learning|deep learning|foundation model|neural network)\b/i.test(haystack));
  const score = coreHits.length * 3 + domainHits.length * 1.5 + modifierHits.length * 0.2 + (paper.abstract ? 0.3 : 0) + (paper.doi || paper.url ? 0.1 : 0);
  return { anchored, score, coreHits, domainHits, modifierHits };
}

function scorePaperAgainstBrief(paper: PaperHit, metadata: any, profile: TopicProfile): PreferenceScore {
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

function screenPaper(_question: string, paper: PaperHit, profile: TopicProfile, preference?: PreferenceScore): any {
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

function assessEligibility(paper: PaperHit, metadata: any = {}, preference?: PreferenceScore, quality?: any): any {
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

function assessQuality(paper: PaperHit, _metadata: any = {}): any {
  const venue = (paper.venue ?? "").toLowerCase();
  const isPreprint = /arxiv|biorxiv|medrxiv/.test(venue) || ["arxiv", "biorxiv", "medrxiv"].includes(paper.sourceDb);
  const highCitation = Number(paper.citationCount ?? 0) >= 100;
  const tier = !isPreprint && highCitation ? "Tier 1" : !isPreprint ? "Tier 2" : paper.abstract ? "Tier 3" : "Tier 4";
  return {
    paperId: paper.id,
    tier,
    justification: tier === "Tier 1" ? "Peer-reviewed or curated source with high citation signal." : tier === "Tier 2" ? "Identifiable non-preprint venue or curated database record." : tier === "Tier 3" ? "Preprint or preliminary record with abstract-level evidence." : "Weak metadata-only evidence."
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

function meetsMinQuality(tier: string, minQuality: string): boolean {
  return qualityRank(tier) <= qualityRank(minQuality);
}

function preferenceAlignment(score?: PreferenceScore): any {
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

function summarizePreferenceScores(scores: PreferenceScore[]): any {
  const hardExcluded = scores.filter((score) => score.hardExcluded).length;
  const averageScore = scores.length ? scores.reduce((sum, score) => sum + score.score, 0) / scores.length : 0;
  return {
    recordsScored: scores.length,
    hardExcluded,
    averageScore: Number(averageScore.toFixed(2)),
    topPreferenceMatches: [...scores].sort((a, b) => b.score - a.score).slice(0, 5).map((score) => ({ paperId: score.paperId, score: score.score, reasons: score.reasons }))
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectContradictions(rows: any[]): any[] {
  const positives = rows.filter((r) => /\bimprove|increase|better|outperform|support/i.test(r.quoteOrSummary));
  const negatives = rows.filter((r) => /\bnot|fail|worse|decrease|contradict|limit/i.test(r.quoteOrSummary));
  if (positives.length && negatives.length) {
    return [{ type: "potential_method_or_context_conflict", supports: positives.slice(0, 3).map((r) => r.paperId), contrasts: negatives.slice(0, 3).map((r) => r.paperId), explanation: "Automated lexical scan found both positive and limiting language; manual review should determine whether this is a real contradiction or context difference." }];
  }
  return [];
}

function countTiers(quality: any[]): Record<string, number> {
  return quality.reduce((acc, q) => ({ ...acc, [q.tier]: (acc[q.tier] ?? 0) + 1 }), {} as Record<string, number>);
}

function renderBibtex(paper: PaperHit, index: number): string {
  const key = `paper${index + 1}_${String(paper.year ?? "nd")}`;
  const type = paper.venue?.toLowerCase().includes("journal") ? "article" : "misc";
  return `@${type}{${key},\n  title = {${paper.title.replace(/[{}]/g, "")}},\n  author = {${(paper.authors ?? ["Unknown"]).join(" and ")}},\n  year = {${paper.year ?? "n.d."}},\n  journal = {${paper.venue ?? paper.sourceDb}},\n  doi = {${paper.doi ?? ""}},\n  url = {${paper.url ?? ""}}\n}`;
}

function renderSynthesis(question: string, papers: PaperHit[], rows: any[], quality: any[], contradictions: any[], prisma: any, metadata: any = {}, preferenceScores: PreferenceScore[] = []): string {
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

export const literaturePack: CapabilityPack = {
  id: "literature",
  name: "Literature Research Pack",
  version: "0.3.0",
  description: "PRISMA-style literature review workflows and scholarly database connectors.",
  agents,
  tools: [scienceListDbsTool, scienceSearchTool, paperFetchTool, paperDeduplicateTool, citationChainTool, citationVerifyTool, bibtexWriteTool, prismaFlowWriteTool, evidenceTableWriteTool, citationCheckTool],
  reviewers: [],
  workflows: [literatureReviewWorkflow],
  stageContracts: [literatureReviewStageContract],
  activate(services) {
    getLiteratureConnectorRegistry(services);
    for (const verifier of literatureStageVerifiers) {
      if (!services.verifierRegistry.get(verifier.id)) services.verifierRegistry.register(verifier);
    }
  }
};

export default literaturePack;
