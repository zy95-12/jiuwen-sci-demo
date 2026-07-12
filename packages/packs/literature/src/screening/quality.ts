import type { PaperHit } from "../types.js";

export function assessQuality(paper: PaperHit, _metadata: any = {}): any {
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
