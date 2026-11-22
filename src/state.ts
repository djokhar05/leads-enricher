import fs from "node:fs";
import path from "node:path";
import type { LeadJobState } from "./types";

// Creates host-local state, input, or output directories recursively.
export const ensureDir = (directory: string): void => {
  fs.mkdirSync(directory, { recursive: true });
};

// JSON state is written to a temporary file and renamed so readers observe
// a complete snapshot instead of partially written job metadata.
export const atomicWriteJson = (filePath: string, value: unknown): void => {
  ensureDir(path.dirname(filePath));
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporary, filePath);
};

// Updates the timestamp and atomically replaces one job snapshot.
export const saveJobState = (
  directory: string,
  state: LeadJobState,
): LeadJobState => {
  ensureDir(directory);
  const updated = { ...state, updatedAt: new Date().toISOString() };
  atomicWriteJson(path.join(directory, `${state.id}.json`), updated);
  return updated;
};

// Job listings are derived from durable local JSON files, not process memory.
export const loadJobStates = (directory: string): LeadJobState[] => {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      try {
        return JSON.parse(
          fs.readFileSync(path.join(directory, name), "utf8"),
        ) as LeadJobState;
      } catch {
        return null;
      }
    })
    .filter((state): state is LeadJobState => state !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
};
