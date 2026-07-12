import type { Artifact } from "@jiuwen-sci/core";
import { compactObject, hasResearchBrief } from "../protocol/metadata.js";
import { readStageArtifact } from "../runtime/artifacts.js";

export async function ensureResearchBriefArtifact(ctx: any): Promise<Artifact | null> {
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

export async function searchWithFallback(ctx: any, db: string, queries: string[], limit: number): Promise<{ out: any; artifactIds: string[]; errors: any[] }> {
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

export function selectedQueryDbs(queries: any): string[] {
  const selected = queries?.selectedQueries ?? queries?.selected_queries ?? [];
  return selected.map((q: any) => q.database).filter((db: unknown): db is string => typeof db === "string" && db.length > 0);
}
