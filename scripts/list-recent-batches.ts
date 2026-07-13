/**
 * Audit tool: list the most recent Message Batches visible to this
 * ANTHROPIC_API_KEY (batches are workspace-scoped, so this only shows batches
 * created by the key in .env). Read-only — batches.list() is free.
 *
 * Run: npx tsx scripts/list-recent-batches.ts [limit]
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
const LIMIT = Number(process.argv[2] ?? 25);

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set — aborting.");
    process.exit(1);
  }

  const now = Date.now();
  const rows: Array<Record<string, unknown>> = [];
  for await (const b of client.messages.batches.list({ limit: 100 })) {
    const rc = b.request_counts;
    const ageMin = Math.round((now - new Date(b.created_at).getTime()) / 60000);
    rows.push({
      id: b.id,
      created_at: b.created_at,
      age_min: ageMin,
      status: b.processing_status,
      processing: rc.processing,
      succeeded: rc.succeeded,
      errored: rc.errored,
      canceled: rc.canceled,
    });
    if (rows.length >= LIMIT) break;
  }

  console.log(`This key sees ${rows.length} batch(es) (showing up to ${LIMIT}, newest first):\n`);
  console.table(rows);
  if (rows.length === 0) {
    console.log(
      "\n⚠️  This key sees NO batches at all. Either nothing was ever submitted " +
        "under this key, or the batches live in a DIFFERENT workspace (different key).",
    );
  }
}

main().catch((e) => {
  console.error("Script failed:", e);
  process.exit(1);
});
