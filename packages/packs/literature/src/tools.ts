import { RuntimeError, type ToolDefinition } from "@jiuwen-sci/core";
import { citationGraphSummary, connectorCapability, extractCitationGraph, normalizeDoi } from "./connectors/common.js";
import { normalizeLiteratureDatabaseIds } from "./connectors/databases.js";
import { SourceRequestError, sourceError } from "./connectors/http.js";
import { getLiteratureConnectorRegistry } from "./connectors/registry.js";
import { renderBibtex } from "./reporting.js";
import type { PaperHit, SourceError } from "./types.js";

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
      await ctx.emit({ type: "literature.search.failed", sessionId: ctx.sessionId, agentId: ctx.agentId, db: input.db, query: input.query, error: structuredError.message, errorType: structuredError.errorType, retryable: structuredError.retryable, artifactId: artifact.id });
      return { ...structuredError, query: input.query, count: 0, results: [], artifactId: artifact.id };
    }
    await ctx.emit({ type: "literature.search.started", sessionId: ctx.sessionId, agentId: ctx.agentId, db, requestedDb: input.db, query: input.query, limit: Number(input.limit ?? 25) });
    try {
      const results = await connector.search({ query: String(input.query), limit: Number(input.limit ?? 25) });
      const artifact = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "search_results", db, query: input.query, requestedDb: input.db, results }, null, 2) });
      await ctx.recordProvenance({ nodes: [{ type: "artifact", refId: artifact.id, label: `Search results from ${db}` }], edges: [] });
      await ctx.emit({ type: "literature.search.completed", sessionId: ctx.sessionId, agentId: ctx.agentId, db, requestedDb: input.db, query: input.query, count: results.length, artifactId: artifact.id, papers: summarizePapers(results) });
      return { ok: true, db, query: input.query, count: results.length, results, artifactId: artifact.id };
    } catch (error) {
      const structuredError = sourceError(db, "search", error);
      const artifact = await ctx.createArtifact({ type: "json", mediaType: "application/json", content: JSON.stringify({ stage: "search_error", db, query: input.query, requestedDb: input.db, error: structuredError }, null, 2) });
      await ctx.emit({ type: "literature.search.failed", sessionId: ctx.sessionId, agentId: ctx.agentId, db, requestedDb: input.db, query: input.query, error: structuredError.message, errorType: structuredError.errorType, retryable: structuredError.retryable, artifactId: artifact.id });
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

export const literatureTools = [
  scienceListDbsTool,
  scienceSearchTool,
  paperFetchTool,
  paperDeduplicateTool,
  citationChainTool,
  citationVerifyTool,
  bibtexWriteTool,
  prismaFlowWriteTool,
  evidenceTableWriteTool,
  citationCheckTool
];

function summarizePapers(papers: PaperHit[]): any[] {
  return papers.slice(0, 5).map((paper) => ({
    id: paper.id,
    title: paper.title,
    year: paper.year,
    venue: paper.venue,
    doi: paper.doi,
    sourceDb: paper.sourceDb,
    url: paper.url
  }));
}
