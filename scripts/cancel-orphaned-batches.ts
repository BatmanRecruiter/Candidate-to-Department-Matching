/**
 * EMERGENCY one-off: cancel batches whose IDs were lost to the localStorage
 * quota crash. Lists every batch, cancels any created in the last 2 hours that
 * has not already ended, and prints a before -> after table. list()/cancel()
 * are free.
 *
 * Run: npx tsx scripts/cancel-orphaned-batches.ts
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const cutoff = Date.now() - TWO_HOURS_MS;

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set — aborting.");
    process.exit(1);
  }

  // 1. Collect batches created in the last 2h (SDK auto-paginates).
  const recent: Anthropic.Messages.Batches.MessageBatch[] = [];
  for await (const b of client.messages.batches.list({ limit: 100 })) {
    if (new Date(b.created_at).getTime() >= cutoff) recent.push(b);
  }
  recent.sort((a, b) => a.created_at.localeCompare(b.created_at));

  console.log(`Found ${recent.length} batch(es) created in the last 2 hours.\n`);

  // 2. Cancel any not-yet-ended batch; capture status before -> after.
  const rows: Array<Record<string, unknown>> = [];
  for (const b of recent) {
    const before = b.processing_status;
    let after: string = before;
    if (before !== "ended" && before !== "canceling") {
      try {
        const c = await client.messages.batches.cancel(b.id);
        after = c.processing_status;
      } catch (e) {
        after = `cancel-failed: ${(e as Error).message}`;
      }
    }
    const rc = b.request_counts;
    rows.push({
      id: b.id,
      created_at: b.created_at,
      "before->after": `${before} -> ${after}`,
      processing: rc.processing,
      succeeded: rc.succeeded,
      errored: rc.errored,
      canceled: rc.canceled,
    });
  }

  console.table(rows);

  const billed = rows.reduce((n, r) => n + (r.succeeded as number), 0);
  console.log(
    `\n${recent.length} batch(es) processed. Total already-SUCCEEDED (billed) ` +
      `requests across them: ${billed}. Cancels stop everything still processing.`,
  );
}

main().catch((e) => {
  console.error("Script failed:", e);
  process.exit(1);
});
