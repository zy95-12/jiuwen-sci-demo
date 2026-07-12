export function uniqueQueries(queries: any[]): string[] {
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

export function termsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((s) => s.trim()).filter(Boolean) : [];
}

export function conceptTermsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueQueries(value.flatMap((concept: any) => [
    concept?.name,
    concept?.label,
    concept?.term,
    ...(Array.isArray(concept?.synonyms) ? concept.synonyms : []),
    ...(Array.isArray(concept?.keywords) ? concept.keywords : []),
    ...(Array.isArray(concept?.terms) ? concept.terms : [])
  ]));
}

export function defaultModifierTerms(): string[] {
  return ["development status", "current status", "trend", "trends", "future direction", "future directions", "roadmap", "review", "survey", "现状", "趋势", "发展"];
}

export function isModifierOnlyTerm(term: string): boolean {
  const normalized = normalizeText(term);
  if (defaultModifierTerms().map(normalizeText).includes(normalized)) return true;
  const compact = term.replace(/\s+/g, "");
  return /^[现状趋势发展当前未来方向综述]+$/.test(compact);
}

export function extractSearchTerms(value: string): string[] {
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
    .filter((part) => part.length >= 2 && !isModifierOnlyTerm(part));
  const whole = value.trim() ? [value.trim()] : [];
  return uniqueQueries([...quoted, ...acronyms, ...englishPhrases, ...chinese, ...whole]).slice(0, 8);
}

export function quoteQueryTerm(term: string): string {
  return /\s/.test(term) ? `"${term.replace(/"/g, "")}"` : term;
}

export function booleanOr(terms: string[]): string {
  return uniqueQueries(terms).map(quoteQueryTerm).join(" OR ");
}

export function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

export function slugify(value: string): string {
  return normalizeText(value).replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

