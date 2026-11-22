import fs from "node:fs";

export const diskUsage = (directory: string) => {
  try {
    const stats = fs.statfsSync(directory);
    const blockSize = Number(stats.bsize || 0);
    const total = blockSize * Number(stats.blocks || 0);
    const free = blockSize * Number(stats.bavail || 0);
    return {
      totalBytes: total,
      freeBytes: free,
      usedBytes: Math.max(total - free, 0),
      usagePercent: total > 0
        ? Math.round(((total - free) / total) * 100)
        : 0,
    };
  } catch {
    return {
      totalBytes: 0,
      freeBytes: 0,
      usedBytes: 0,
      usagePercent: 0,
      unavailable: true,
    };
  }
};

export const memoryUsage = () => {
  const usage = process.memoryUsage();
  return {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    heapTotalBytes: usage.heapTotal,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
  };
};
