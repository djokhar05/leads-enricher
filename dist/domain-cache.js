"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.domainCacheStats = exports.clearDomainCache = exports.setDomainCache = exports.getDomainCache = void 0;
const entries = new Map();
const maxEntries = 10_000;
const getDomainCache = (domain) => {
    const entry = entries.get(domain.trim().toLowerCase());
    if (!entry)
        return undefined;
    if (entry.expiresAt <= Date.now()) {
        entries.delete(domain.trim().toLowerCase());
        return undefined;
    }
    return entry.value;
};
exports.getDomainCache = getDomainCache;
const setDomainCache = (domain, value, ttlMs = 24 * 60 * 60 * 1000) => {
    const key = domain.trim().toLowerCase();
    if (!key)
        return;
    if (entries.size >= maxEntries && !entries.has(key)) {
        const oldest = entries.keys().next().value;
        if (oldest)
            entries.delete(oldest);
    }
    entries.set(key, { value, expiresAt: Date.now() + ttlMs });
};
exports.setDomainCache = setDomainCache;
const clearDomainCache = () => {
    entries.clear();
};
exports.clearDomainCache = clearDomainCache;
const domainCacheStats = () => ({
    size: entries.size,
    maxSize: maxEntries,
});
exports.domainCacheStats = domainCacheStats;
