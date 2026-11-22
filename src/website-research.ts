import { isIP } from "node:net";

export interface WebsiteResearchResult {
  url: string;
  title: string;
  text: string;
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
): Promise<WebsiteResearchResult | null> => {
  if (!validPublicDomain(domain)) return null;
  try {
    const url = `https://${domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}`;
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: { Accept: "text/html" },
    });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return null;
    const html = (await response.text()).slice(0, 1_000_000);
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch
      ? stripHtml(titleMatch[1]).slice(0, 300)
      : "";
    const text = stripHtml(html).slice(0, 12_000);
    if (!text) return null;
    return {
      url,
      title,
      text,
      source: "company-domain",
    };
  } catch {
    return null;
  }
};
