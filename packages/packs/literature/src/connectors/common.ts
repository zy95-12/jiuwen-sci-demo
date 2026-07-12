import type { ConnectorMetadata, LiteratureConnector } from "../types.js";

export function reconstructOpenAlexAbstract(index: Record<string, number[]> | null | undefined): string | undefined {
  if (!index) return undefined;
  const words: [string, number][] = [];
  for (const [word, positions] of Object.entries(index)) for (const pos of positions) words.push([word, pos]);
  return words.sort((a, b) => a[1] - b[1]).map(([word]) => word).join(" ");
}

export function text(xml: string, tag: string): string {
  return xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))?.[1] ?? "";
}

export function clean(value: string): string {
  return stripTags(value).replace(/\s+/g, " ").trim();
}

export function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

export function normalizeDoi(value?: string): string | undefined {
  const doi = value?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").trim();
  return doi || undefined;
}

export function normalizeOpenAlexWorkId(value: string): string {
  const trimmed = value.trim();
  if (/^https:\/\/openalex\.org\/W/i.test(trimmed)) return trimmed.replace(/^https:\/\/openalex\.org\//i, "");
  if (/^W\d+$/i.test(trimmed)) return trimmed;
  return trimmed.replace(/^https?:\/\/api\.openalex\.org\/works\//i, "");
}

export function normalizeArxivId(value: string): string | undefined {
  const trimmed = value.trim();
  const fromUrl = trimmed.match(/arxiv\.org\/(?:abs|pdf)\/([^?#\s]+)/i)?.[1];
  const raw = (fromUrl ?? trimmed).replace(/\.pdf$/i, "");
  const match = raw.match(/(?:arXiv:)?([a-z-]+\/\d{7}|\d{4}\.\d{4,5})(v\d+)?/i);
  return match?.[0]?.replace(/^arXiv:/i, "");
}

export function arxivPdfUrl(entry: string): string | undefined {
  return entry.match(/<link[^>]+title="pdf"[^>]+href="([^"]+)"/)?.[1]
    ?? entry.match(/<link[^>]+href="([^"]+\.pdf[^"]*)"/)?.[1];
}

export function arxivCategories(entry: string): string[] {
  return [...entry.matchAll(/<category[^>]+term="([^"]+)"/g)].map((m) => m[1]).filter(Boolean);
}

export function connectorCapability(connector: LiteratureConnector): ConnectorMetadata {
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

export function extractCitationGraph(record: unknown): { references: any[]; citations: any[] } {
  const value = record as any;
  if (!value) return { references: [], citations: [] };
  return {
    references: Array.isArray(value.references) ? value.references : [],
    citations: Array.isArray(value.citations) ? value.citations : []
  };
}

export function citationGraphSummary(items: any[]): any[] {
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
