// Deterministic person extraction runs before any paid model call. Every name
// returned here is copied from the fetched page, so it needs no verification.

const TITLE =
  "Co-?Founder|Founder|Owner|CEO|Chief Executive Officer|President|Principal|Managing Director|Managing Partner|Director|Partner";
const NAME = "[A-Z][a-zA-Z'-]{1,20}(?: [A-Z]\\.)?(?: [A-Z][a-zA-Z'-]{1,20})";

const nameBeforeTitle = new RegExp(`(${NAME})\\s*[,|–—-]?\\s*(?:${TITLE})\\b`, "g");
const titleBeforeName = new RegExp(`\\b(?:${TITLE})\\s*[:,|–—-]?\\s*(${NAME})`, "g");

const nonNameWords = new Set([
  "about", "and", "best", "business", "call", "click", "client", "company", "contact",
  "customer", "for", "from", "get", "hello", "home", "info", "learn", "leadership", "meet",
  "mission", "new", "of", "office", "our", "read", "sales", "service", "services", "story",
  "support", "team", "the", "vision", "we", "welcome", "with", "you", "your",
]);

const looksLikePerson = (name: string): boolean =>
  name.split(/\s+/).every((word) => !nonNameWords.has(word.toLowerCase()));

const LEADERSHIP_CUE =
  /\b(founder|co-?founder|owner|ceo|chief executive|president|principal|managing (?:director|partner)|director|partner|our team|meet the team|leadership|about us|who we are)\b/gi;

// Sends the model only the text around leadership cues, which keeps prompts small.
export const leadershipSnippet = (text: string, maxChars = 2_000): string => {
  const windows: Array<[number, number]> = [];
  for (const match of text.matchAll(LEADERSHIP_CUE)) {
    const start = Math.max(0, (match.index ?? 0) - 200);
    const end = Math.min(text.length, (match.index ?? 0) + match[0].length + 200);
    const last = windows.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else windows.push([start, end]);
  }
  return windows
    .map(([start, end]) => text.slice(start, end).trim())
    .join(" … ")
    .slice(0, maxChars);
};

export const normalizeForMatch = (value: string): string =>
  value.replace(/\s+/g, " ").trim().toLowerCase();

// A model-returned name is accepted only when it appears verbatim in the text it was given.
export const appearsInSource = (name: string, sourceText: string): boolean =>
  normalizeForMatch(sourceText).includes(normalizeForMatch(name));

export const extractJsonLdPeople = (html: string): string[] => {
  const names: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const type = record["@type"];
    const isPerson = type === "Person" || (Array.isArray(type) && type.includes("Person"));
    if (isPerson && typeof record.name === "string") names.push(record.name.trim());
    Object.values(record).forEach(visit);
  };
  for (const match of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      visit(JSON.parse(match[1]));
    } catch {
      continue;
    }
  }
  return [...new Set(names)];
};

// Matches "Jane Smith, Founder" and "Founder: Jane Smith" in stripped page text.
export const extractTitledNames = (text: string): string[] => {
  const names: string[] = [];
  for (const pattern of [nameBeforeTitle, titleBeforeName]) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1].trim();
      if (looksLikePerson(name)) names.push(name);
    }
  }
  return [...new Set(names)];
};

export const extractDeterministicNames = (research: {
  people?: string[];
  text: string;
}): string[] => [...new Set([...(research.people ?? []), ...extractTitledNames(research.text)])];
