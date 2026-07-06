/**
 * One-time backfill of role summaries.
 *
 * - Summarizes every bundled role in shared/role-library.json (plus the
 *   internal Business Architecture role) and writes the results to
 *   shared/role-summaries.json, keyed by job_id. Commit that file.
 * - Summarizes every synced_roles row whose summary column is null and
 *   writes the summary back to the database.
 *
 * Idempotent: roles that already have a summary are skipped, so re-running
 * only fills gaps. Pass --regenerate to rewrite EVERY summary (use after
 * changing the summarizer prompt). Requires ANTHROPIC_API_KEY and DATABASE_URL.
 *
 * Run with: npx tsx scripts/backfill-role-summaries.ts [--regenerate]
 */
import "dotenv/config";
import * as fs from "node:fs";
import * as path from "node:path";
import { augmentRoleLibrary, type RoleLibraryJob } from "../shared/matcher";
import { summarizeRole } from "../server/role-summary";
import { storage } from "../server/storage";

const LIBRARY_PATH = path.resolve(process.cwd(), "shared/role-library.json");
const SUMMARIES_PATH = path.resolve(process.cwd(), "shared/role-summaries.json");
const REGENERATE = process.argv.includes("--regenerate");

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY must be set to run this backfill");
  process.exit(1);
}

function sortedRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

async function main() {
  // --- Bundled roles → shared/role-summaries.json sidecar ---
  const library = JSON.parse(fs.readFileSync(LIBRARY_PATH, "utf-8")) as {
    jobs: RoleLibraryJob[];
  };
  const jobs = augmentRoleLibrary(library.jobs);
  let summaries: Record<string, string> = {};
  try {
    summaries = JSON.parse(fs.readFileSync(SUMMARIES_PATH, "utf-8"));
  } catch {}

  let bundledNew = 0;
  let bundledSkipped = 0;
  for (const job of jobs) {
    if (!job.job_id) continue;
    if (!REGENERATE && summaries[job.job_id]) {
      bundledSkipped++;
      continue;
    }
    console.log(`[bundled] summarizing ${job.title} (${job.job_id})`);
    summaries[job.job_id] = await summarizeRole(job.title, job.department, job.body);
    bundledNew++;
    // Persist after every role so a crash doesn't lose paid-for progress.
    fs.writeFileSync(
      SUMMARIES_PATH,
      JSON.stringify(sortedRecord(summaries), null, 2) + "\n",
    );
  }
  console.log(
    `[bundled] done: ${bundledNew} generated, ${bundledSkipped} already had summaries`,
  );

  // --- Synced roles → synced_roles.summary column ---
  const synced = await storage.listSyncedRoles(false);
  let syncedNew = 0;
  let syncedSkipped = 0;
  for (const row of synced) {
    if (!REGENERATE && row.summary) {
      syncedSkipped++;
      continue;
    }
    console.log(`[synced] summarizing ${row.title} (${row.jobId})`);
    const summary = await summarizeRole(row.title, row.department, row.body);
    await storage.updateSyncedRoleSummary(row.jobId, summary);
    syncedNew++;
  }
  console.log(
    `[synced] done: ${syncedNew} generated, ${syncedSkipped} already had summaries`,
  );
}

main().catch((err) => {
  console.error("backfill failed:", err);
  process.exit(1);
});
