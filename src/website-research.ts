import { isIP } from "node:net";
import { extractJsonLdPeople, extractTitledNames } from "./person-extraction";

export interface WebsiteResearchResult {
  url: string;
  title: string;
  text: string;
  people?: string[];
  source: "company-domain";
}

const stripHtml = (html: string): string =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();

const validPublicDomain = (domain: string): boolean => {
  const normalized = domain.trim().toLowerCase();
  if (!normalized || normalized.length > 253) return false;
  if (isIP(normalized)) return false;
  if (!/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/.test(normalized)) {
    return false;
  }
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(normalized)) return false;
  return true;
};

export const researchCompanyDomain = async (
  domain: string,
  signal?: AbortSignal,
): Promise<WebsiteResearchResult | null> => {
  signal?.throwIfAborted();
  if (!validPublicDomain(domain)) return null;
  try {
    const url = `https://${domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}`;
    let title = "";
    let text = "";
    let sourceUrl = url;
    const people = new Set<string>();
    const paths = ["", "/about", "/team", "/leadership"];
    const bareDomain = domain.replace(/^www\./, "").toLowerCase();
    for (const path of paths) {
      signal?.throwIfAborted();
      const pageUrl = `${url}${path}`;
      try {
        const response = await fetch(pageUrl, {
          redirect: "follow",
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(8_000)])
            : AbortSignal.timeout(5_000),
          headers: { Accept: "text/html" },
        });
        const finalHost = new URL(response.url).hostname.replace(/^www\./, "").toLowerCase();
        if (finalHost !== bareDomain) continue;
        if (!response.ok) continue;
        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("text/html")) continue;
        const html = (await response.text()).slice(0, 750_000);
        const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        if (!title) {
          title = titleMatch
            ? stripHtml(titleMatch[1]).slice(0, 300)
            : "";
        }
        for (const name of extractJsonLdPeople(html)) people.add(name);
        const pageText = stripHtml(html).slice(0, 3_000);
        if (pageText) {
          if (!text) sourceUrl = pageUrl;
          text = `${text}\n${pageText}`.slice(0, 6_000);
        }
        if (
          people.size > 0 ||
          extractTitledNames(pageText).length > 0
        ) {
          break;
        }
      } catch {
        signal?.throwIfAborted();
        continue;
      }
    }
    if (!text) return null;
    return {
      url: sourceUrl,
      title,
      text,
      people: [...people],
      source: "company-domain",
    };
  } catch {
    signal?.throwIfAborted();
    return null;
  }
};

export const researchCompanySearch = async (
  companyName: string,
  address?: string,
): Promise<WebsiteResearchResult | null> => {
  const query = [companyName, address]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");
  if (!query) return null;
  const searchQuery = `${query} owner founder CEO team contact`;
  const enc = encodeURIComponent(searchQuery);
  const searches = [
    `https://www.google.com/search?q=${enc}`,
    `https://www.bing.com/search?q=${enc}`,
    `https://html.duckduckgo.com/html/?q=${enc}`,
  ];
  let combinedText = "";
  let sourceUrl = searches[0];
  for (const url of searches) {
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(8_000),
        headers: {
          Accept: "text/html",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        },
      });
      if (!response.ok) continue;
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/html")) continue;
      const html = (await response.text()).slice(0, 750_000);
      const text = stripHtml(html).slice(0, 5_000);
      if (text) {
        if (!combinedText) sourceUrl = url;
        combinedText = `${combinedText}\nSource: ${url}\n${text}`.slice(
          0,
          12_000,
        );
      }
    } catch {
      continue;
    }
  }
  if (!combinedText) return null;
  return {
    url: sourceUrl,
    title: companyName,
    text: combinedText,
    source: "company-domain",
  };
};
