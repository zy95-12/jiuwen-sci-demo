import { toArxivSearchQuery } from "./arxiv-query.js";
import { arxivCategories, arxivPdfUrl, clean, normalizeArxivId, normalizeDoi, normalizeOpenAlexWorkId, reconstructOpenAlexAbstract, stripTags, text } from "./common.js";
import { getJson, getText } from "./http.js";
import type { LiteratureConnector, LiteratureSearchInput, PaperHit } from "../types.js";

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
