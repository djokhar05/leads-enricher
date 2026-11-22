import fs from "node:fs";
import path from "node:path";
import { config } from "./config";

export interface AuditEntry {
  timestamp: string;
  hostId: string;
  action: string;
  jobId?: string;
  status: "success" | "failure";
  metadata?: Record<string, unknown>;
}

export const appendAudit = (entry: AuditEntry): void => {
  fs.mkdirSync(config.auditDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  fs.appendFileSync(
    path.join(config.auditDir, `${date}.jsonl`),
    `${JSON.stringify(entry)}\n`,
    "utf8",
  );
};

export const loadAuditEntries = (limit = 200): AuditEntry[] => {
  if (!fs.existsSync(config.auditDir)) return [];
  const entries: AuditEntry[] = [];
  for (const name of fs.readdirSync(config.auditDir)
    .filter((item) => item.endsWith(".jsonl"))
    .sort()
    .reverse()) {
    try {
      const lines = fs.readFileSync(path.join(config.auditDir, name), "utf8")
        .split("\n")
        .filter(Boolean)
        .reverse();
      for (const line of lines) {
        entries.push(JSON.parse(line) as AuditEntry);
        if (entries.length >= limit) return entries;
      }
    } catch {
      // Leave malformed audit lines untouched for operator inspection.
    }
  }
  return entries;
};
