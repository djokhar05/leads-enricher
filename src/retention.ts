import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import { loadJobStates } from "./state";

export interface RetentionPreview {
  cutoff: string;
  jobs: Array<{
    id: string;
    status: string;
    updatedAt: string;
    inputPath: string;
    outputPath: string;
  }>;
  files: string[];
}

export const previewRetention = (): RetentionPreview => {
  const cutoffMs = Date.now() - config.retentionDays * 24 * 60 * 60 * 1000;
  const cutoff = new Date(cutoffMs).toISOString();
  const jobs = loadJobStates(config.stateDir)
    .filter((job) =>
      ["completed", "failed"].includes(job.status) &&
      new Date(job.updatedAt).getTime() < cutoffMs
    )
    .map((job) => ({
      id: job.id,
      status: job.status,
      updatedAt: job.updatedAt,
      inputPath: job.inputPath,
      outputPath: job.outputPath,
    }));

  const files: string[] = [];
  for (const job of jobs) {
    for (const target of [job.inputPath, job.outputPath]) {
      if (!target || !fs.existsSync(target)) continue;
      const stat = fs.statSync(target);
      if (stat.isFile()) files.push(target);
    }
  }
  return { cutoff, jobs, files };
};

export const applyRetention = (): RetentionPreview => {
  const preview = previewRetention();
  for (const job of preview.jobs) {
    const snapshot = path.join(config.stateDir, `${job.id}.json`);
    if (fs.existsSync(snapshot)) fs.unlinkSync(snapshot);
  }
  for (const file of preview.files) {
    fs.unlinkSync(file);
  }
  return preview;
};
