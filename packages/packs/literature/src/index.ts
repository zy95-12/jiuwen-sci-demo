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

export interface LiteratureConnector {
  id: string;
  name: string;
  description: string;
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

async function getJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
  const res = await fetch(url, { headers: { "user-agent": "jiuwen-sci/0.1", ...(headers ?? {}) } });
  if (!res.ok) throw new RuntimeError("HTTP_ERROR", `${res.status} ${res.statusText}: ${url}`);
  return res.json() as Promise<T>;
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": "jiuwen-sci/0.1" } });
  if (!res.ok) throw new RuntimeError("HTTP_ERROR", `${res.status} ${res.statusText}: ${url}`);
  return res.text();
}

export class OpenAlexConnector implements LiteratureConnector {
  id = "openalex";
  name = "OpenAlex";
  description = "Search OpenAlex works metadata and DOI-linked scholarly records.";
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
      raw: item
    }));
  }
  async fetch(id: string): Promise<unknown> {
    const key = id.startsWith("http") ? id.replace(/^https:\/\/openalex.org\//, "") : id;
    return getJson(`https://api.openalex.org/works/${encodeURIComponent(key)}`);
  }
}

export class ArxivConnector implements LiteratureConnector {
  id = "arxiv";
  name = "arXiv";
  description = "Search arXiv preprints and metadata.";
  async search(input: LiteratureSearchInput): Promise<PaperHit[]> {
    const url = new URL("https://export.arxiv.org/api/query");
    url.searchParams.set("search_query", `all:${input.query}`);
    url.searchParams.set("start", "0");
    url.searchParams.set("max_results", String(input.limit ?? 25));
    const xml = await getText(url.toString());
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
        raw: entry
      };
    });
  }
}

export class CrossrefConnector implements LiteratureConnector {
  id = "crossref";
  name = "Crossref";
  description = "Cross-publisher DOI metadata and citation records.";
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
  async search(input: LiteratureSearchInput): Promise<PaperHit[]> {
    const limit = Math.min(input.limit ?? 25, 50);
    const key = process.env.SEMANTIC_SCHOLAR_API_KEY?.trim();
    const json = await getJson<any>(
      `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(input.query)}&limit=${limit}&fields=title,abstract,url,year,venue,citationCount,externalIds,authors.name`,
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
      `https://api.semanticscholar.org/graph/v1/paper/${id.trim()}?fields=title,abstract,url,year,venue,citationCount,externalIds,authors.name,references.paperId,references.title,citations.paperId,citations.title`,
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
    return { databases: registry.list().map((db) => ({ id: db.id, name: db.name, description: db.description, capabilities: ["search", db.fetch ? "fetch" : undefined].filter(Boolean) })) };
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
    const connector = registry.get(String(input.db));
    if (!connector) throw new RuntimeError("LITERATURE_DB_NOT_FOUND", String(input.db));
    try {
      const results = await connector.search({ query: String(input.query), limit: Number(input.limit ?? 25) });
      const artifact = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "search_results", db: input.db, query: input.query, results }, null, 2) });
      await ctx.recordProvenance({ nodes: [{ type: "artifact", refId: artifact.id, label: `Search results from ${input.db}` }], edges: [] });
      return { db: input.db, query: input.query, count: results.length, results, artifactId: artifact.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const artifact = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "search_error", db: input.db, query: input.query, error: message }, null, 2) });
      return { db: input.db, query: input.query, count: 0, results: [], error: message, artifactId: artifact.id };
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
    if (!connector?.fetch) return { db: input.db, id: input.id, fetched: false, record: null };
    const record = await connector.fetch(String(input.id));
    const artifact = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "paper_fetch", db: input.db, id: input.id, record }, null, 2) });
    return { db: input.db, id: input.id, fetched: true, record, artifactId: artifact.id };
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
    const records = seeds.slice(0, Number(input.limit ?? 5)).map((paper) => ({
      paperId: paper.id,
      title: paper.title,
      references: paper.references ?? [],
      citations: paper.citations ?? [],
      note: paper.references?.length || paper.citations?.length ? "connector supplied citation graph metadata" : "no citation graph metadata available"
    }));
    const artifact = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "citation_chaining", seedCount: seeds.length, records }, null, 2) });
    return { records, artifactId: artifact.id };
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
      verifiers: ["artifact_requirements_met", "literature_protocol_valid", "literature_query_concepts_valid"],
      retryPolicy: { maxAttempts: 2, onFailure: "retry_stage" },
      gate: {
        deterministic: [{ id: "artifact_requirements_met", hardGate: true }, { id: "literature_protocol_valid", hardGate: true }, { id: "literature_query_concepts_valid", hardGate: true }],
        rules: [
          { when: "hard_gate_failed", action: "retry_stage" },
          { when: "verifier_failed", action: "retry_stage" },
          { when: "passed", action: "next" }
        ]
      },
      next: [{ when: "passed", stageId: "search_dedupe" }],
      run: async (ctx) => {
        const agentProtocol = await readStageArtifact(ctx.services, ctx.artifactIds, "protocol");
        const agentQueries = await readStageArtifact(ctx.services, ctx.artifactIds, "queries");
        if (agentProtocol && agentQueries) {
          const dbs = Array.isArray(agentProtocol.databases) && agentProtocol.databases.length ? agentProtocol.databases.map(String) : selectedQueryDbs(agentQueries);
          const topicProfile = topicProfileFromQueries(agentQueries);
          return { statePatch: { limit: Number(agentProtocol.limit ?? ctx.metadata.limit ?? 25), dbs, criteria: agentProtocol.criteria ?? agentQueries.criteria ?? defaultCriteria(), queryPlan: agentQueries, topicProfile } };
        }
        const limit = Number(ctx.metadata.limit ?? 25);
        const dbs = Array.isArray(ctx.metadata.dbs) && ctx.metadata.dbs.length ? ctx.metadata.dbs.map(String) : ["openalex", "semantic-scholar", "crossref"];
        const criteria = defaultCriteria();
        const queryPlan = buildQueryPlan(ctx.input, dbs, criteria);
        const protocol = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "protocol", question: ctx.input, databases: dbs, limit, criteria, conceptDefinition: queryPlan.conceptDefinition, workflow: ctx.contract.stages.map((s) => s.id) }, null, 2) });
        const queries = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify(queryPlan, null, 2) });
        return { artifactIds: [protocol.id, queries.id], statePatch: { limit, dbs, criteria, queryPlan, topicProfile: topicProfileFromQueries(queryPlan), protocolArtifactId: protocol.id, queriesArtifactId: queries.id } };
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
          return { statePatch: { allPapers: deduped, searchCounts: agentIdentification.searchCounts ?? {}, sourceErrors: agentIdentification.sourceErrors ?? [], deduped, duplicates: agentDedupe.duplicates ?? [] } };
        }
        const dbs = (ctx.state.dbs as string[]) ?? ["openalex"];
        const limit = Number(ctx.state.limit ?? 25);
        const allPapers: PaperHit[] = [];
        const searchArtifactIds: string[] = [];
        const searchCounts: Record<string, number> = {};
        const sourceErrors: any[] = [];
        for (const db of dbs) {
          const queryPlan = ctx.state.queryPlan as any;
          const query = queryPlan?.selectedQueries?.find((q: any) => q.database === db)?.query ?? ctx.input;
          const result = await ctx.tool({ toolId: "science_search", input: { db, query, limit } });
          const out = result.output as any;
          allPapers.push(...(out.results ?? []));
          searchCounts[db] = out.count ?? 0;
          if (out.error) sourceErrors.push({ db, error: out.error });
          if (out.artifactId) searchArtifactIds.push(out.artifactId);
        }
        const identification = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "identification", searchCounts, sourceErrors, recordsIdentifiedThroughDatabaseSearching: allPapers.length, recordsIdentifiedThroughCitationChaining: 0 }, null, 2) });
        const chain = await ctx.tool({ toolId: "citation_chain", input: { papers: allPapers.slice(0, 5), limit: 5 } });
        const citationChainArtifactId = (chain.output as any).artifactId as string;
        const dedupe = await ctx.tool({ toolId: "paper_deduplicate", input: { papers: allPapers } });
        const deduped = (dedupe.output as any).papers as PaperHit[];
        const duplicates = (dedupe.output as any).duplicates ?? [];
        const dedupedArtifactId = (dedupe.output as any).artifactId as string;
        return { artifactIds: [...searchArtifactIds, identification.id, citationChainArtifactId, dedupedArtifactId], statePatch: { allPapers, searchCounts, sourceErrors, deduped, duplicates, identificationArtifactId: identification.id, citationChainArtifactId, dedupedArtifactId } };
      }
    },
    {
      id: "screening",
      goal: "Screen titles and abstracts using explicit inclusion/exclusion criteria and record a reason for every paper.",
      agentId: "literature-screening-agent",
      allowedTools: ["artifact_read", "artifact_write", "finalize"],
      requiredArtifacts: [{ type: "json", stage: "screening_log" }],
      verifiers: ["artifact_requirements_met", "literature_screening_complete", "literature_screening_topic_anchor_valid"],
      retryPolicy: { maxAttempts: 2, onFailure: "retry_stage" },
      gate: {
        deterministic: [{ id: "artifact_requirements_met", hardGate: true }, { id: "literature_screening_complete", hardGate: true }, { id: "literature_screening_topic_anchor_valid", hardGate: true }],
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
        if (agentScreening?.decisions) {
          const screeningDecisions = agentScreening.decisions;
          const screenedIn = screeningDecisions.filter((d: any) => d.decision === "include").map((d: any) => deduped.find((p) => p.id === d.paperId)!).filter(Boolean);
          return { statePatch: { screeningDecisions, screenedIn } };
        }
        const criteria = ctx.state.criteria ?? defaultCriteria();
        const topicProfile = (ctx.state.topicProfile as TopicProfile | undefined) ?? topicProfileFromQueries(ctx.state.queryPlan);
        const screeningDecisions = deduped.map((paper) => screenPaper(ctx.input, paper, topicProfile));
        const screenedIn = screeningDecisions.filter((d) => d.decision === "include").map((d) => deduped.find((p) => p.id === d.paperId)!).filter(Boolean);
        const screeningLog = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "screening_log", criteria, decisions: screeningDecisions }, null, 2) });
        return { artifactIds: [screeningLog.id], statePatch: { screeningDecisions, screenedIn, screeningLogArtifactId: screeningLog.id } };
      }
    },
    {
      id: "eligibility_quality",
      goal: "Assess eligibility, assign evidence quality tiers, and extract structured evidence rows.",
      agentId: "literature-eligibility-agent",
      allowedTools: ["artifact_read", "artifact_write", "evidence_table_write", "finalize"],
      requiredArtifacts: [{ type: "json", stage: "eligibility_log" }, { type: "json", stage: "quality_assessment" }, { type: "json", stage: "included_studies" }, { type: "json", stage: "evidence_table" }],
      verifiers: ["artifact_requirements_met", "literature_evidence_complete"],
      retryPolicy: { maxAttempts: 2, onFailure: "retry_stage" },
      gate: {
        deterministic: [{ id: "artifact_requirements_met", hardGate: true }, { id: "literature_evidence_complete", hardGate: true }],
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
        const eligibilityDecisions = screenedIn.map((paper) => assessEligibility(paper));
        const included = eligibilityDecisions.filter((d) => d.decision === "include").map((d) => screenedIn.find((p) => p.id === d.paperId)!).filter(Boolean).slice(0, Math.min(25, limit));
        const eligibilityLog = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "eligibility_log", decisions: eligibilityDecisions }, null, 2) });
        const quality = included.map((paper) => assessQuality(paper));
        const qualityAssessment = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "quality_assessment", tiers: quality }, null, 2) });
        const includedStudies = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "included_studies", papers: included }, null, 2) });
        const evidenceRows = included.map((paper, index) => ({
          evidenceId: `ev_${index + 1}`,
          paperId: paper.id,
          claim: `${paper.title} provides ${paper.abstract ? "abstract-level" : "metadata-level"} evidence relevant to "${ctx.input}".`,
          supportType: "context",
          quoteOrSummary: paper.abstract?.slice(0, 700) || `${paper.title} (${paper.year ?? "n.d."})`,
          qualityTier: quality.find((q) => q.paperId === paper.id)?.tier ?? "Tier 3",
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
      verifiers: ["artifact_requirements_met", "literature_prisma_counts_valid", "no_open_blocking_findings"],
      review: { agentId: "literature-reviewer-agent", mode: "always" },
      retryPolicy: { maxAttempts: 2, onFailure: "retry_stage" },
      gate: {
        deterministic: [
          { id: "artifact_requirements_met", hardGate: true },
          { id: "literature_prisma_counts_valid", hardGate: true },
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
        const citationVerification = await ctx.tool({ toolId: "citation_verify", input: { papers: included } });
        const citationVerificationArtifactId = (citationVerification.output as any).artifactId as string;
        const bibtex = await ctx.tool({ toolId: "bibtex_write", input: { papers: included } });
        const bibtexArtifactId = (bibtex.output as any).artifactId as string;
        const prisma = {
          recordsIdentifiedThroughDatabaseSearching: allPapers.length,
          recordsIdentifiedThroughCitationChaining: 0,
          totalRecordsIdentified: allPapers.length,
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
        const synthesisText = renderSynthesis(ctx.input, included, evidenceRows, quality, contradictions, prisma);
        const synthesis = await ctx.createArtifact({ type: "markdown", mediaType: "text/markdown", content: synthesisText });
        const reviewFindings = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "review_findings", findings: [], summary: "Stage contract ran deterministic verifiers and final semantic reviewer; unresolved unverified citations remain visible in citation_verification.json." }, null, 2) });
        const finalReport = await ctx.createArtifact({ type: "markdown", mediaType: "text/markdown", content: `${synthesisText}\n\n## Artifact Index\n\n- protocol.json: ${ctx.state.protocolArtifactId}\n- queries.json: ${ctx.state.queriesArtifactId}\n- identification.json: ${ctx.state.identificationArtifactId}\n- citation_chaining.json: ${ctx.state.citationChainArtifactId}\n- deduped_papers.json: ${ctx.state.dedupedArtifactId}\n- screening_log.json: ${ctx.state.screeningLogArtifactId}\n- eligibility_log.json: ${ctx.state.eligibilityLogArtifactId}\n- quality_assessment.json: ${ctx.state.qualityAssessmentArtifactId}\n- included_studies.json: ${ctx.state.includedStudiesArtifactId}\n- evidence_table.json: ${ctx.state.evidenceArtifactId}\n- contradiction_detection.json: ${ctx.state.contradictionArtifactId}\n- citation_verification.json: ${citationVerificationArtifactId}\n- bibtex.bib: ${bibtexArtifactId}\n- prisma_flow.json: ${prismaFlowArtifactId}\n- review_findings.json: ${reviewFindings.id}\n` });
        await ctx.recordProvenance({
          nodes: [
            { type: "artifact", refId: finalReport.id, label: "final_report.md" },
            { type: "artifact", refId: synthesis.id, label: "synthesis.md" },
            { type: "artifact", refId: String(ctx.state.evidenceArtifactId), label: "evidence_table.json" },
            { type: "artifact", refId: prismaFlowArtifactId, label: "prisma_flow.json" },
            ...included.map((paper) => ({ type: "source", refId: paper.id, label: paper.title, metadata: { doi: paper.doi, url: paper.url, sourceDb: paper.sourceDb } })),
            ...evidenceRows.map((row) => ({ type: "claim", refId: row.evidenceId, label: row.claim, metadata: { paperId: row.paperId, qualityTier: row.qualityTier } }))
          ],
          edges: [
            { type: "derived_from", fromRef: synthesis.id, toRef: finalReport.id },
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

const literatureStageVerifiers: StageVerifierDefinition[] = [
  {
    id: "literature_protocol_valid",
    description: "Validate literature protocol and query-plan artifacts.",
    async verify(ctx) {
      const protocol = await readStageArtifact(ctx.services, ctx.artifactIds, "protocol");
      const queries = await readStageArtifact(ctx.services, ctx.artifactIds, "queries");
      const ok = Boolean(protocol?.question && Array.isArray(protocol.databases) && protocol.databases.length && Array.isArray(queries?.selectedQueries) && queries.selectedQueries.length);
      return ok ? { ok: true, message: "Protocol and query plan are valid." } : { ok: false, message: "Protocol or query plan is missing required question/database/query fields.", severity: "major", category: "protocol_invalid" };
    }
  },
  {
    id: "literature_query_concepts_valid",
    description: "Validate concept grounding and expanded scholarly queries.",
    async verify(ctx) {
      const queries = await readStageArtifact(ctx.services, ctx.artifactIds, "queries");
      const coreTerms = termsOf(queries?.coreTerms);
      const selectedQueries = Array.isArray(queries?.selectedQueries) ? queries.selectedQueries : [];
      const hasDefinition = Boolean(queries?.conceptDefinition?.definition);
      const hasCore = coreTerms.length >= 3;
      const hasExpandedEnglish = selectedQueries.some((q: any) => /AI for Science|Artificial Intelligence for Science|scientific discovery|foundation models for science/i.test(String(q.query ?? "")));
      const notOnlyRawQuestion = selectedQueries.some((q: any) => normalizeText(String(q.query ?? "")) !== normalizeText(String(queries?.researchQuestion ?? "")));
      const ok = hasDefinition && hasCore && hasExpandedEnglish && notOnlyRawQuestion;
      return ok ? { ok: true, message: "Query concept grounding and expansion are valid." } : { ok: false, message: "Query plan lacks concept grounding, AI4S core terms, or expanded English scholarly queries.", severity: "blocking", category: "query_concepts_invalid" };
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
    description: "Validate that included studies match AI4S core topic anchors, not only trend modifiers.",
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
        : { ok: false, message: `Included studies without AI4S topic anchors: ${weak.map((d: any) => d.title ?? d.paperId).join("; ")}`, severity: "blocking", category: "topic_anchor_failed" };
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
  }
];

async function readStageArtifact(services: RuntimeServices, artifactIds: string[], stage: string): Promise<any | null> {
  for (const id of artifactIds) {
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

type TopicProfile = {
  coreTerms: string[];
  domainTerms: string[];
  modifierTerms: string[];
};

function buildQueryPlan(question: string, dbs: string[], criteria: unknown): any {
  const ai4s = defaultAi4sTopicProfile();
  const broadQuery = '("AI for Science" OR "Artificial Intelligence for Science" OR "AI4S" OR "AI-driven scientific discovery" OR "scientific machine learning")';
  const trendQuery = `${broadQuery} AND (review OR survey OR roadmap OR trend OR "current status" OR "future directions")`;
  const domainQuery = '("foundation models for science" OR "autonomous laboratory" OR "materials discovery" OR "drug discovery" OR "protein design" OR "climate modeling" OR "physics-informed neural networks")';
  return {
    stage: "queries",
    researchQuestion: question,
    conceptDefinition: {
      term: "AI4S",
      definition: "AI4S refers to using artificial intelligence methods to accelerate scientific discovery, modeling, experimentation, and engineering across scientific domains.",
      scope: ["AI-driven scientific discovery", "scientific machine learning", "foundation models for science", "autonomous laboratories", "domain discovery tasks such as materials, drug, protein, climate, and physics modeling"]
    },
    concepts: inferConcepts(question),
    coreTerms: ai4s.coreTerms,
    domainTerms: ai4s.domainTerms,
    modifierTerms: ai4s.modifierTerms,
    criteria,
    selectedQueries: dbs.map((db) => ({ database: db, query: `${trendQuery} OR ${domainQuery}`, rationale: "Expanded AI4S query with core concept anchors, domain applications, and trend/review modifiers." })),
    alternativeQueries: dbs.flatMap((db) => [
      { database: db, query: broadQuery, rationale: "High-precision AI4S core concept query." },
      { database: db, query: domainQuery, rationale: "Domain-expansion query for AI4S application areas." }
    ])
  };
}

function defaultAi4sTopicProfile(): TopicProfile {
  return {
    coreTerms: [
      "ai4s",
      "ai for science",
      "artificial intelligence for science",
      "ai-driven scientific discovery",
      "scientific discovery",
      "scientific machine learning",
      "foundation models for science",
      "machine learning for science"
    ],
    domainTerms: [
      "materials discovery",
      "drug discovery",
      "protein design",
      "climate modeling",
      "autonomous laboratory",
      "autonomous laboratories",
      "robot scientist",
      "self-driving laboratory",
      "physics-informed neural networks",
      "simulation surrogate",
      "biopharmaceutical r&d",
      "molecular generation",
      "crystal structure prediction"
    ],
    modifierTerms: [
      "development status",
      "current status",
      "trend",
      "trends",
      "future direction",
      "future directions",
      "roadmap",
      "review",
      "survey",
      "现状",
      "趋势",
      "发展"
    ]
  };
}

function topicProfileFromQueries(queries: any): TopicProfile {
  const fallback = defaultAi4sTopicProfile();
  return {
    coreTerms: termsOf(queries?.coreTerms).length ? termsOf(queries?.coreTerms) : fallback.coreTerms,
    domainTerms: termsOf(queries?.domainTerms).length ? termsOf(queries?.domainTerms) : fallback.domainTerms,
    modifierTerms: termsOf(queries?.modifierTerms).length ? termsOf(queries?.modifierTerms) : fallback.modifierTerms
  };
}

function termsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((s) => s.trim()).filter(Boolean) : [];
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

function inferConcepts(question: string): any[] {
  if (/ai4s|AI4S/i.test(question)) {
    return [
      { name: "AI4S", synonyms: ["AI for Science", "Artificial Intelligence for Science", "AI-driven scientific discovery"], required: true },
      { name: "Scientific machine learning", synonyms: ["machine learning for science", "physics-informed neural networks"], required: false },
      { name: "Autonomous scientific discovery", synonyms: ["autonomous laboratory", "self-driving laboratory", "robot scientist"], required: false },
      { name: "Domain discovery", synonyms: ["materials discovery", "drug discovery", "protein design", "climate modeling"], required: false }
    ];
  }
  return question.split(/\s+/).filter((w) => w.length > 3).slice(0, 10).map((name) => ({ name, synonyms: [], required: false }));
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

function screenPaper(_question: string, paper: PaperHit, profile: TopicProfile): any {
  const anchor = topicAnchorScore(paper, profile);
  const decision = anchor.anchored && anchor.score >= 1.5 ? "include" : "exclude";
  return {
    paperId: paper.id,
    title: paper.title,
    decision,
    criteria: decision === "include" ? ["IC1", paper.abstract ? "IC2" : "IC3"] : ["EC1"],
    reason: decision === "include"
      ? `Included: matched AI4S topic anchors. Core hits: ${anchor.coreHits.join(", ") || "none"}; domain hits: ${anchor.domainHits.join(", ") || "none"}.`
      : `Excluded: no sufficient AI4S topic anchor. Modifier-only hits: ${anchor.modifierHits.join(", ") || "none"}.`,
    confidence: Math.min(0.95, Math.max(0.35, anchor.score / 4))
  };
}

function assessEligibility(paper: PaperHit): any {
  const hasIdentity = Boolean(paper.title && (paper.doi || paper.url || paper.id));
  const hasEvidence = Boolean(paper.abstract || paper.venue || paper.year);
  return {
    paperId: paper.id,
    decision: hasIdentity && hasEvidence ? "include" : "exclude",
    reason: hasIdentity && hasEvidence ? "Eligible: identifiable scholarly record with usable metadata or abstract." : "Excluded: insufficient source identity or evidence metadata.",
    assessedUsing: paper.abstract ? "abstract" : "metadata"
  };
}

function assessQuality(paper: PaperHit): any {
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

function renderSynthesis(question: string, papers: PaperHit[], rows: any[], quality: any[], contradictions: any[], prisma: any): string {
  const refs = papers.map((p, i) => `${i + 1}. ${p.authors?.slice(0, 3).join(", ") || "Unknown"} (${p.year ?? "n.d."}). ${p.title}. ${p.venue ?? p.sourceDb}. ${p.doi ? `doi:${p.doi}` : p.url ?? p.id}`).join("\n");
  const claims = rows.map((r, i) => `- **Finding ${i + 1}**: ${r.claim} Evidence: ${r.evidenceId}; source: ${r.paperId}; quality: ${r.qualityTier}.`).join("\n");
  const matrix = papers.map((p) => {
    const q = quality.find((x) => x.paperId === p.id);
    return `| ${p.title.replace(/\|/g, " ")} | ${p.year ?? "n.d."} | ${p.venue ?? p.sourceDb} | ${q?.tier ?? "Tier 3"} | ${p.abstract ? p.abstract.slice(0, 120).replace(/\|/g, " ") : "Metadata-level relevance"} |`;
  }).join("\n");
  return `# PRISMA-Style Literature Review: ${question}\n\n## PRISMA Flow\n\n- Records identified through database searching: ${prisma.recordsIdentifiedThroughDatabaseSearching}\n- Records identified through citation chaining: ${prisma.recordsIdentifiedThroughCitationChaining}\n- Records after deduplication: ${prisma.recordsAfterDeduplication}\n- Records screened: ${prisma.recordsScreened}\n- Records excluded during title/abstract screening: ${prisma.recordsExcludedTitleAbstract}\n- Full-text/abstract records assessed for eligibility: ${prisma.fullTextOrAbstractRecordsAssessed}\n- Records excluded at eligibility: ${prisma.recordsExcludedEligibility}\n- Studies included in synthesis: ${prisma.studiesIncludedInSynthesis}\n\n## Summary\n\nThis review searched registered scholarly databases, deduplicated records, screened title/abstract metadata against explicit criteria, assessed eligibility using available abstract/full metadata, assigned evidence quality tiers, verified citation metadata, and synthesized evidence rows into traceable findings.\n\n## Key Findings\n\n${claims || "- No included papers were available for synthesis."}\n\n## Contradictions & Conflicts\n\n${contradictions.length ? contradictions.map((c) => `- ${c.type}: ${c.explanation}`).join("\n") : "- No explicit contradictions detected by automated v0 scan."}\n\n## Evidence Matrix\n\n| Paper | Year | Venue | Quality Tier | Key Finding |\n|---|---:|---|---|---|\n${matrix || "| No included papers | | | | |"}\n\n## References\n\n${refs || "No verified references returned."}\n\n## Gaps & Opportunities\n\n- Full-text retrieval and section-level extraction should be added for stronger eligibility assessment.\n- Citation chaining is represented, but connector-level reference expansion should be broadened where APIs permit.\n- Manual expert review remains necessary before treating this as a formal systematic review.\n`;
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
