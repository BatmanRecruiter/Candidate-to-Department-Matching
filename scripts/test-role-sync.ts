/**
 * Verify role-sync logic: normalization, dedupe by job_id, and that synced
 * roles are surfaced through the combined library used by the matcher.
 *
 * This test runs against a temporary SQLite file so it doesn't pollute the
 * real data.db. It mocks the Greenhouse fetch by stubbing global.fetch.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const TMP_DB = path.resolve(process.cwd(), `data.test-${Date.now()}.db`);
// Point storage at a throwaway DB before importing it.
process.chdir(process.cwd());
process.env.DATABASE_PATH = TMP_DB;

// better-sqlite3 reads the literal path "data.db" in server/storage.ts.
// Easiest reliable approach: cd into a temp dir for the run, then load.
const tmpDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-rolesync-"));
process.chdir(tmpDir);

let errors = 0;
function assert(cond: any, msg: string) {
  if (!cond) {
    console.error("  FAIL:", msg);
    errors++;
  } else {
    console.log("  ok:", msg);
  }
}

async function main() {
  // Stub fetch to return a fake Greenhouse response.
  const fakeJobs = [
    {
      id: 9000001,
      title: "Senior Data Engineer",
      absolute_url: "https://www.phdata.io/jobs?gh_jid=9000001",
      location: { name: "US-Remote" },
      departments: [{ name: "Data Engineering" }],
      content:
        "<p>We are hiring a Senior Data Engineer. 5+ years of experience with Snowflake, dbt, AWS. " +
        "Required: SQL, Python, Spark. <strong>Preferred:</strong> Databricks, Kafka.</p>",
    },
    {
      id: 9000002,
      title: "Director, Advisory",
      absolute_url: "https://www.phdata.io/jobs?gh_jid=9000002",
      location: { name: "Bengaluru, India" },
      departments: [{ name: "Advisory" }],
      content:
        "<p>10+ years leading advisory engagements. Stakeholder management, change management, " +
        "strategy. Snowflake and Power BI experience.</p>",
    },
    {
      id: 9000003,
      title: "Job With No Department",
      location: { name: "US" },
      departments: [],
      content: "<p>Invalid posting.</p>",
    },
  ];

  (globalThis as any).fetch = async (_url: string) => ({
    ok: true,
    status: 200,
    async json() {
      return { jobs: fakeJobs, meta: { total: fakeJobs.length } };
    },
  });

  // Dynamic import AFTER cwd swap so storage picks up the temp dir.
  const { runRoleSync, syncedRoleToLibraryJob } = await import(
    "../server/role-sync"
  );
  const { storage } = await import("../server/storage");

  console.log("--- first sync ---");
  const r1 = await runRoleSync("manual");
  console.log(JSON.stringify(r1, null, 2));
  assert(r1.status === "partial", "first run is partial because one job has no department");
  assert(r1.rolesFound === 3, "rolesFound counts all 3 in the response");
  assert(r1.rolesNew === 2, "rolesNew counts the 2 valid jobs");
  assert(r1.rolesUpdated === 0, "rolesUpdated is 0 on a clean DB");

  // Round-trip a row through the library shape used by the matcher.
  const stored = await storage.listSyncedRoles(true);
  assert(stored.length === 2, "two active synced roles persisted");
  const de = stored.find((r) => r.jobId === "9000001")!;
  const job = syncedRoleToLibraryJob(de);
  assert(job.department === "Data Engineering", "department preserved");
  assert(job.title === "Senior Data Engineer", "title preserved");
  assert(job.required_skills.includes("Snowflake"), "skill vocab finds Snowflake");
  assert(job.required_skills.includes("Python"), "skill vocab finds Python");
  assert(job.region === "US", "region inferred as US for US-Remote");
  assert(job.required_yoe === 5, "5+ years parsed");
  assert(
    job.url === "https://www.phdata.io/jobs?gh_jid=9000001",
    "absolute_url passed through",
  );

  const india = stored.find((r) => r.jobId === "9000002")!;
  assert(india.region === "India", "Bengaluru location infers India region");

  console.log("\n--- second sync (idempotent) ---");
  const r2 = await runRoleSync("manual");
  assert(r2.rolesNew === 0, "second run adds zero new roles");
  assert(r2.rolesUpdated === 2, "second run updates the 2 valid roles");
  assert(r2.rolesDeactivated === 0, "no roles deactivated when same listing");

  console.log("\n--- third sync with role removed ---");
  // Drop the India role from the listing this time.
  (globalThis as any).fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { jobs: [fakeJobs[0]], meta: { total: 1 } };
    },
  });
  const r3 = await runRoleSync("manual");
  assert(r3.rolesDeactivated === 1, "missing role gets deactivated");
  const activeAfter = (await storage.listSyncedRoles(true)).length;
  assert(activeAfter === 1, "one active role remains");
  const allAfter = (await storage.listSyncedRoles(false)).length;
  assert(allAfter === 2, "deactivated role is retained in table (not deleted)");

  console.log("\n--- sync run history ---");
  const last = await storage.latestSyncRun();
  assert(last?.source === "manual", "latest run recorded with source");
  assert((last?.rolesDeactivated || 0) === 1, "latest run has deactivation count");

  console.log("\n--- error path ---");
  (globalThis as any).fetch = async () => ({
    ok: false,
    status: 503,
    async json() {
      return {};
    },
  });
  const rErr = await runRoleSync("automated");
  assert(rErr.status === "error", "non-2xx fetch results in error status");
  assert(typeof rErr.errorMessage === "string", "error message recorded");

  console.log(`\nDone. ${errors === 0 ? "ALL OK" : `${errors} FAILURES`}`);
}

main()
  .catch((e) => {
    console.error(e);
    errors++;
  })
  .finally(() => {
    // Cleanup
    try {
      const here = process.cwd();
      for (const f of fs.readdirSync(here)) {
        if (f.startsWith("data.db")) fs.unlinkSync(path.join(here, f));
      }
      process.chdir(path.resolve(here, ".."));
      fs.rmSync(here, { recursive: true, force: true });
    } catch {}
    process.exit(errors === 0 ? 0 : 1);
  });
