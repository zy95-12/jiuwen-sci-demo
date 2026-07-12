import { extractSearchTerms } from "../utils/text.js";

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
