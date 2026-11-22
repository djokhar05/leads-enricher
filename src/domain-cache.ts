interface DomainCacheEntry {
  value: unknown;
  expiresAt: number;
}

const entries = new Map<string, DomainCacheEntry>();
const maxEntries = 10_000;

export const getDomainCache = (domain: string): unknown => {
  const entry = entries.get(domain.trim().toLowerCase());
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    entries.delete(domain.trim().toLowerCase());
    return undefined;
  }
  return entry.value;
};

export const setDomainCache = (
  domain: string,
  value: unknown,
  ttlMs = 24 * 60 * 60 * 1000,
): void => {
  const key = domain.trim().toLowerCase();
  if (!key) return;
  if (entries.size >= maxEntries && !entries.has(key)) {
    const oldest = entries.keys().next().value as string | undefined;
    if (oldest) entries.delete(oldest);
  }
  entries.set(key, { value, expiresAt: Date.now() + ttlMs });
};

export const clearDomainCache = (): void => {
  entries.clear();
};

export const domainCacheStats = () => ({
  size: entries.size,
  maxSize: maxEntries,
});
