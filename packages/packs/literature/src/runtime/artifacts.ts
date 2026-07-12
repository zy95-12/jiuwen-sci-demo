import type { Artifact, RuntimeServices } from "@jiuwen-sci/core";

export async function readStageArtifact(services: RuntimeServices, artifactIds: string[], stage: string): Promise<any | null> {
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

export async function listArtifactsByType(services: RuntimeServices, artifactIds: string[], type: string): Promise<Artifact[]> {
  const out: Artifact[] = [];
  for (const id of artifactIds) {
    const artifact = await services.artifactStore.get(id);
    if (artifact?.type === type) out.push(artifact);
  }
  return out;
}
