/**
 * One-time backfill: persist Anthropic batch results into batch_jobs.results
 * for complete jobs that predate the results column. Retrieves via the SDK
 * directly (never the HTTP route), so no Slack notification can fire.
 * Idempotent: storeBatchResults writes only while results is still null, and
 * archived jobs are included (they're hidden, not deleted).
 *
 * Run: node node_modules/tsx/dist/cli.mjs scripts/backfill-batch-results.ts
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { neon } from "@neondatabase/serverless";
import { storage } from "../server/storage";
import { processMatchContent } from "../server/matcher-llm";
import { HUMAN_REVIEW } from "../shared/matcher";

async function main() {
  if (!process.env.ANTHROPIC_API_KEY || !process.env.DATABASE_URL) {
    console.error("ANTHROPIC_API_KEY and DATABASE_URL must be set — aborting.");
    process.exit(1);
  }
  const client = new Anthropic();
  const sql = neon(process.env.DATABASE_URL);

  const jobs = (await sql`
    select id, batch_id, file_name from batch_jobs
    where status = 'complete' and batch_id is not null and results is null
    order by created_at asc
  `) as { id: string; batch_id: string; file_name: string }[];

  console.log(`${jobs.length} complete job(s) need results backfilled.\n`);

  let stored = 0;
  let skipped = 0;
  let failed = 0;
  for (const [i, job] of jobs.entries()) {
    const label = `[${i + 1}/${jobs.length}] ${job.file_name} (${job.batch_id})`;
    try {
      const batch = await client.messages.batches.retrieve(job.batch_id);
      if (batch.processing_status !== "ended") {
        console.log(`${label}: batch is ${batch.processing_status} — skipped.`);
        skipped++;
        continue;
      }

      // Mirror the GET /api/match/batch/:id mapping exactly, so backfilled
      // results match what a live completion poll would have stored.
      const results: Record<number, unknown> = {};
      for await (const item of await client.messages.batches.results(job.batch_id)) {
        const idx = parseInt((item.custom_id as string).replace("candidate-", ""), 10);
        if ((item.result as { type: string }).type === "succeeded") {
          const msg = (item.result as { type: "succeeded"; message: { content: unknown[] } })
            .message;
          results[idx] = processMatchContent(
            msg.content as Array<{ type: string; text?: string }>,
          );
        } else {
          results[idx] = {
            best_job: null,
            best_score: 0,
            department: HUMAN_REVIEW,
            role: "",
            rationale: `Batch item ${item.result.type ?? "failed"}.`,
            confidence: "?",
            best_dept_score: 0,
            candidate_yoe: null,
            candidate_region: "",
          };
        }
      }

      const { wrote } = await storage.storeBatchResults(job.batch_id, JSON.stringify(results));
      if (wrote) {
        console.log(`${label}: stored ${Object.keys(results).length} results.`);
        stored++;
      } else {
        console.log(`${label}: results already stored — skipped.`);
        skipped++;
      }
    } catch (err) {
      console.error(`${label}: FAILED —`, err instanceof Error ? err.message : err);
      failed++;
    }
  }

  console.log(`\nDone. stored=${stored} skipped=${skipped} failed=${failed} of ${jobs.length}.`);
  if (failed > 0) process.exitCode = 1;
}

main();
