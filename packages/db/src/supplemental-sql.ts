import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function readSql(name: string): string {
  const candidates = [join(here, name), join(here, "../src", name)];
  for (const path of candidates) {
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  throw new Error(`Missing SQL file ${name} (looked in ${candidates.join(", ")})`);
}

/** RLS policies, role grants, and FR-1.6 trigger — applied after drizzle-kit migrate. */
export function loadSupplementalSql(): string[] {
  return ["rls.sql", "grants.sql", "triggers.sql"].map(readSql);
}
