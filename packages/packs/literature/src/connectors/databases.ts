type ConnectorLike = { id: string; name: string };
type ConnectorRegistryLike = { list(): ConnectorLike[] };

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

export function normalizeLiteratureDatabaseIds(value: any, registry?: ConnectorRegistryLike, fallback: string[] = []): string[] {
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
