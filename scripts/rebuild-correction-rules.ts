/**
 * One-time (re)build of the distilled correction-rules block.
 * Run after deploying the corrections-distillation change, or any time you
 * want to force a fresh distillation. No-op when the DB has no corrections.
 *
 * Run with: npx tsx scripts/rebuild-correction-rules.ts
 */
import "dotenv/config";
import { rebuildCorrectionRules } from "../server/correction-rules";
import { storage } from "../server/storage";

async function main() {
  const count = await storage.countCorrections();
  if (count === 0) {
    console.log("no corrections in the database — nothing to distill");
    return;
  }
  await rebuildCorrectionRules();
  const stored = await storage.getCorrectionRules();
  console.log(`stored rules (${stored?.rulesText.length ?? 0} chars):\n`);
  console.log(stored?.rulesText ?? "(none)");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("rebuild failed:", err);
    process.exit(1);
  });
