import type { Express } from "express";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { batchJobPatchSchema, batchJobRequestSchema, calibrationRequestSchema, saveFileRequestSchema } from "@shared/schema";
import { storage } from "./storage";
import { runRoleSync } from "./role-sync";
import {
  AUGMENTED_LIBRARY,
  getCombinedLibrary,
  getLibraryDigest,
  invalidateRoleLibraryCache,
} from "./role-library";
import {
  matchCandidateLLM,
  buildMatchParams,
  buildBatchSystemBlocks,
  checkHardBlock,
  processMatchContent,
  MODEL as MATCH_MODEL,
  type CorrectionExample,
} from "./matcher-llm";
import {
  getCorrectionsPromptBlock,
  invalidateCorrectionRulesCache,
  rebuildCorrectionRules,
} from "./correction-rules";
import { filterRowForMatching } from "@shared/match-columns";
import Anthropic from "@anthropic-ai/sdk";

const ADMIN_PASSCODE_HASH = process.env.ADMIN_PASSCODE_HASH;
const SHARED_HISTORY_HASH = "shared-admin-history";

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf-8").digest("hex");
}

function isAdminRequest(req: { header(name: string): string | undefined }): boolean {
  const passcode = req.header("x-admin-passcode")?.trim();
  if (!passcode || !ADMIN_PASSCODE_HASH) return false;
  const candidate = Buffer.from(hashSecret(passcode), "hex");
  const expected = Buffer.from(ADMIN_PASSCODE_HASH, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function requireAdmin(req: { header(name: string): string | undefined }, res: any): boolean {
  if (isAdminRequest(req)) return true;
  res.status(401).json({ message: "Admin passcode required" });
  return false;
}

const MAX_SAVED_FILES = 500;
const MAX_CALIBRATIONS = 3000;
const MAX_BATCH_JOBS = 2000;
const TIPPING_POINT = 50;

async function sendSlackNotification(text: string): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("[slack] SLACK_WEBHOOK_URL not set — skipping notification");
    return;
  }
  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (resp.ok) {
      console.log("[slack] notification sent");
    } else {
      console.warn("[slack] non-2xx:", resp.status, await resp.text());
    }
  } catch (err) {
    console.warn("[slack] notification failed:", err);
  }
}

async function generateCalibrationAnalysis(corrections: CorrectionExample[]): Promise<string> {
  const analysisClient = new Anthropic();
  const correctionLines = corrections
    .map(
      (c, i) =>
        `${i + 1}. ${c.candidateName || "Unnamed"}: routed to "${c.originalDepartment}" → corrected to "${c.correctedDepartment}"` +
        (c.feedbackReason ? ` | Note: ${c.feedbackReason}` : ""),
    )
    .join("\n");

  const resp = await analysisClient.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 1024,
    thinking: { type: "disabled" },
    messages: [
      {
        role: "user",
        content: `You are reviewing ${corrections.length} recruiter corrections for an AI candidate-matching system that routes candidates to departments: Data Engineering, Analytics, Machine Learning, Advisory, Business Architecture, Managed Services, PMO, Sales.

Here are all the corrections (original system routing → what recruiter changed it to):

${correctionLines}

Provide a concise analysis in three sections:
1. PATTERNS: The 2-3 most common misrouting patterns (which departments are confused most often and why)
2. ROOT CAUSES: What signals the system is likely over- or under-weighting that causes these misroutes
3. PROMPT RECOMMENDATIONS: Specific, actionable text changes to add to the department descriptions to fix the top misroutes (quote exact additions or clarifications)

Be direct and specific. This will be shared with a recruiter who will update the system prompt.`,
      },
    ],
  });

  const textBlock = resp.content.find((b: { type: string }) => b.type === "text") as
    | { type: "text"; text: string }
    | undefined;
  return textBlock?.text ?? "Analysis could not be generated.";
}

// Flattens a candidate row into the key: value text the hard-block regexes
// and the LLM prompt consume. Kept identical to the historical format.
function rowToText(row: Record<string, string>): string {
  return Object.entries(row)
    .filter(([, v]) => String(v ?? "").trim().length > 0)
    .map(([k, v]) => `${k}: ${String(v).slice(0, 3000)}`)
    .join("\n");
}

export async function registerRoutes(
  httpServer: Server,
  app: Express,
): Promise<Server> {
  app.get("/api/role-library", async (_req, res, next) => {
    try {
      const combined = await getCombinedLibrary();
      res.json({
        generated_at: combined.generated_at,
        jobs: combined.jobs,
      });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/health", async (_req, res, next) => {
    try {
      const combined = await getCombinedLibrary();
      res.json({
        ok: true,
        // Which commit is actually live. Render injects RENDER_GIT_COMMIT on
        // every deploy; lets a deploy be verified from outside without dashboard
        // access. Falls back to "unknown" locally.
        commit: (process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? "unknown").slice(0, 7),
        jobs: combined.jobs.length,
        bundled_jobs: combined.bundled_count,
        synced_jobs: combined.synced_count,
        synced_active_jobs: combined.synced_active_count,
      });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/role-sync/status", async (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      const lastRun = await storage.latestSyncRun();
      const synced = await storage.listSyncedRoles(false);
      const active = synced.filter((r) => r.isActive === 1).length;
      res.json({
        lastRun: lastRun ?? null,
        syncedRolesTotal: synced.length,
        syncedRolesActive: active,
        bundledRolesCount: AUGMENTED_LIBRARY.jobs.length,
      });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/role-sync", async (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      const result = await runRoleSync("manual");
      // Even a partial/errored run may have upserted rows — always refresh.
      invalidateRoleLibraryCache();
      const httpStatus = result.status === "error" ? 502 : 200;
      res.status(httpStatus).json(result);
    } catch (err) {
      next(err);
    }
  });

  // Same logic, separate route so a weekly automation (cron / webhook) can be
  // pointed at a stable URL. Auth is still admin-only via the passcode header.
  app.post("/api/role-sync/automated", async (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      const result = await runRoleSync("automated");
      invalidateRoleLibraryCache();
      const httpStatus = result.status === "error" ? 502 : 200;
      res.status(httpStatus).json(result);
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/saved-files", async (_req, res, next) => {
    try {
      if (!requireAdmin(_req, res)) return;
      res.json(await storage.listSavedFiles());
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/saved-files/:id", async (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      const file = await storage.getSavedFile(req.params.id);
      if (!file) return res.status(404).json({ message: "Saved file not found" });
      const { historyKeyHash: _historyKeyHash, ...safeFile } = file;
      res.json(safeFile);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/saved-files", async (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      const parsed = saveFileRequestSchema.parse(req.body);
      const now = Date.now();
      if ((await storage.countSavedFiles()) >= MAX_SAVED_FILES) {
        return res.status(429).json({
          message: `Saved file limit reached (${MAX_SAVED_FILES}).`,
        });
      }
      const saved = await storage.createSavedFile({
        id: randomUUID(),
        runId: parsed.runId || randomUUID(),
        historyKeyHash: SHARED_HISTORY_HASH,
        kind: parsed.kind,
        fileName: parsed.fileName,
        rowCount: parsed.rowCount,
        columnCount: parsed.columnCount,
        byteSize: Buffer.byteLength(parsed.csvText, "utf-8"),
        csvText: parsed.csvText,
        createdAt: now,
      });
      const { csvText: _csvText, historyKeyHash: _historyKeyHash, ...summary } = saved;
      res.status(201).json(summary);
    } catch (err) {
      next(err);
    }
  });

  // Batch jobs — durable server-side record of submitted batches (the source of
  // truth over the client's localStorage). List omits the big csvText/preResolved
  // blobs; GET :id returns the full row and is only hit when rebuilding an export.
  app.get("/api/batch-jobs", async (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      res.json(await storage.listBatchJobs());
    } catch (err) {
      next(err);
    }
  });

  // Registered BEFORE /:id so the literal segment isn't captured as a job id.
  // Summary projection only — same egress discipline as the live list.
  app.get("/api/batch-jobs/archived", async (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      res.json(await storage.listArchivedBatchJobs());
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/batch-jobs/:id", async (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      const job = await storage.getBatchJob(req.params.id);
      if (!job) return res.status(404).json({ message: "Batch job not found" });
      res.json(job);
    } catch (err) {
      next(err);
    }
  });

  // Client-initiated create — used for all-hard-blocked ("complete") jobs that
  // never hit the Anthropic batch API. Billed jobs are created server-side by
  // the /api/match/batch submit flow, not here.
  app.post("/api/batch-jobs", async (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      const parsed = batchJobRequestSchema.parse(req.body);
      if ((await storage.countBatchJobs()) >= MAX_BATCH_JOBS) {
        return res.status(429).json({
          message: `Batch job limit reached (${MAX_BATCH_JOBS}).`,
        });
      }
      const created = await storage.createBatchJob({
        id: randomUUID(),
        batchId: parsed.batchId ?? null,
        status: parsed.status,
        fileName: parsed.fileName,
        rowCount: parsed.rowCount,
        csvText: parsed.csvText,
        preResolved: parsed.preResolved,
        submissionId: parsed.submissionId ?? null,
        createdAt: Date.now(),
      });
      const { csvText: _csvText, preResolved: _preResolved, ...summary } = created;
      res.status(201).json(summary);
    } catch (err) {
      next(err);
    }
  });

  // Client-driven status transitions only (complete | canceled | error). The
  // submit flow mutates the row directly via storage, not through this route.
  app.patch("/api/batch-jobs/:id", async (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      const parsed = batchJobPatchSchema.parse(req.body);
      const existing = await storage.getBatchJob(req.params.id);
      if (!existing) return res.status(404).json({ message: "Batch job not found" });
      await storage.updateBatchJob(req.params.id, { status: parsed.status });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // Restore one soft-hidden job. Deliberately its own route (not a widened
  // PATCH) so clients can never write `archived` arbitrarily.
  app.post("/api/batch-jobs/:id/unarchive", async (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      const existing = await storage.getBatchJob(req.params.id);
      if (!existing) return res.status(404).json({ message: "Batch job not found" });
      await storage.setBatchJobArchived(req.params.id, false);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // Soft-hide every job ("Clear all"): archive rather than delete so the durable
  // billing record is never lost. Reversible via the archived flag.
  app.post("/api/batch-jobs/archive", async (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      await storage.archiveAllBatchJobs();
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/calibrations", async (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      res.json(await storage.listCalibrations());
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/match", async (req, res, next) => {
    try {
      const { row } = req.body as { row: Record<string, string> };
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        return res.status(400).json({ message: "row must be a plain object" });
      }
      // Hard-block regexes scan ALL row text (not named columns), so an
      // excluded column could carry a block signal. The scan is free regex —
      // run it on the FULL row first; only the LLM payload is filtered.
      const hardBlock = checkHardBlock(rowToText(row));
      if (hardBlock) {
        return res.json(hardBlock);
      }
      // Server-side allowlist (defense-in-depth — the client filters too):
      // only match-relevant columns reach the LLM.
      const { row: matchRow, dropped } = filterRowForMatching(row);
      if (dropped > 0) {
        console.log(`[match-columns] /api/match: dropped ${dropped} columns`);
      }
      const correctionsBlock = await getCorrectionsPromptBlock();
      const libraryDigest = await getLibraryDigest();
      const result = await matchCandidateLLM(matchRow, correctionsBlock, libraryDigest);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/calibrations", async (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      const parsed = calibrationRequestSchema.parse(req.body);
      if ((await storage.countCalibrations()) >= MAX_CALIBRATIONS) {
        return res.status(429).json({
          message: `Calibration limit reached (${MAX_CALIBRATIONS}).`,
        });
      }
      const isCorrection = !parsed.isCorrect;
      const correctionCountBefore = isCorrection ? await storage.countCorrections() : 0;

      const saved = await storage.createCalibration({
        id: randomUUID(),
        historyKeyHash: SHARED_HISTORY_HASH,
        candidateKey: parsed.candidateKey,
        candidateName: parsed.candidateName,
        originalDepartment: parsed.originalDepartment,
        originalRole: parsed.originalRole,
        originalConfidence: parsed.originalConfidence,
        isCorrect: parsed.isCorrect ? 1 : 0,
        correctedDepartment: parsed.correctedDepartment,
        correctedRole: parsed.correctedRole,
        feedbackReason: parsed.feedbackReason,
        createdAt: Date.now(),
      });
      const { historyKeyHash: _historyKeyHash, ...safeCalibration } = saved;
      res.status(201).json(safeCalibration);

      if (isCorrection) {
        // The recent-5 examples changed immediately; the distilled rules
        // rebuild fire-and-forget (one Haiku call). Failure keeps the old
        // rules — it must never affect the calibration write.
        invalidateCorrectionRulesCache();
        rebuildCorrectionRules().catch((err) => {
          console.warn("[correction-rules] rebuild failed:", err);
        });
      }

      // Fire-and-forget: send Slack notification when corrections cross the tipping point.
      if (isCorrection && correctionCountBefore === TIPPING_POINT - 1) {
        storage.listCorrections().then(async (corrections) => {
          const examples: CorrectionExample[] = corrections.map((c) => ({
            candidateName: c.candidateName,
            originalDepartment: c.originalDepartment,
            correctedDepartment: c.correctedDepartment,
            feedbackReason: c.feedbackReason,
          }));
          try {
            const analysis = await generateCalibrationAnalysis(examples);
            await sendSlackNotification(
              `*phData Matcher — Calibration Tipping Point Reached (${TIPPING_POINT} corrections)*\n\n${analysis}\n\n_Open the admin panel to view and act on this analysis._`,
            );
            console.log("[calibration] tipping point Slack notification sent");
          } catch (err) {
            console.warn("[calibration] tipping point analysis/Slack failed:", err);
          }
        });
      }
    } catch (err) {
      next(err);
    }
  });

  // --- Batch API endpoints ---
  // Pre-flight cost guard: batch submissions are two-phase. A request without
  // confirmCost:true returns a USD estimate and creates NOTHING; the client
  // shows the estimate, gets explicit confirmation, and resends with
  // confirmCost:true. Rates are USD per million tokens for claude-sonnet-5 at
  // the 50% Batch API discount (intro pricing through 2026-08-31: $2/$10 list
  // -> $1/$5 batched). The system prompt (the dominant cost) is counted
  // EXACTLY via the free count_tokens endpoint — this prompt tokenizes far
  // denser than typical prose, so chars-based guesses under-report it. The
  // chars/3 heuristic (which over-reports for prose) is used for candidate
  // rows and as the fallback if count_tokens fails: a cost guard may
  // overestimate, never underestimate.
  const BATCH_INPUT_USD_PER_MTOK = 1.0;
  const BATCH_OUTPUT_USD_PER_MTOK = 5.0;
  const EST_OUTPUT_TOKENS_PER_ROW = 250; // max_tokens is 512; rationales run ~150-300
  const MAX_BATCH_ROWS = 1100; // cost/memory bound. The per-row prompt-duplication OOM
  // that justified the old 500 cap is fixed (systemBlocks is built once and shared by
  // reference below); this ceiling caps worst-case batch spend (no cache on this path).
  const estimateTokens = (chars: number) => Math.ceil(chars / 3);

  // Accepts parsed candidate rows, submits them to the Anthropic Batch API
  // (50% cost vs real-time), and returns the Anthropic batch ID immediately.
  // Hard-block candidates are resolved instantly and returned alongside the ID.
  app.post("/api/match/batch", async (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      const { rows, fileName, confirmCost, csvText, submissionId } = req.body as {
        rows: Record<string, string>[];
        fileName: string;
        confirmCost?: boolean;
        csvText?: string; // full original CSV; required only on the confirmed submit
        submissionId?: string; // groups one drop's jobs ("this run"); confirmed submit only
      };
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ message: "rows must be a non-empty array" });
      }
      if (rows.length > MAX_BATCH_ROWS) {
        return res
          .status(400)
          .json({ message: `Maximum ${MAX_BATCH_ROWS} rows per batch` });
      }

      const correctionsBlock = await getCorrectionsPromptBlock();
      const libraryDigest = await getLibraryDigest();
      // Built ONCE per batch and shared by reference across all rows. Never
      // rebuild the prompt per row: 2000 copies of a multi-KB string is what
      // put the 512MB Render instance out of memory.
      const systemBlocks = buildBatchSystemBlocks(correctionsBlock, libraryDigest);
      const batchClient = new Anthropic();
      const batchRequests: Array<{ custom_id: string; params: unknown }> = [];
      const preResolved: Record<number, unknown> = {};
      let candidateChars = 0;
      let droppedColumns = 0;

      for (let i = 0; i < rows.length; i++) {
        // Hard-block regexes scan ALL row text (not named columns), so an
        // excluded column could carry a block signal. The scan is free regex —
        // run it on the FULL row; only the LLM payload/estimate is filtered.
        const hardBlock = checkHardBlock(rowToText(rows[i]));
        if (hardBlock) {
          preResolved[i] = hardBlock;
          continue;
        }
        // Server-side allowlist (defense-in-depth — the client filters too):
        // applied before the cost estimate and the batch payload.
        const { row: matchRow, dropped } = filterRowForMatching(rows[i]);
        droppedColumns += dropped;
        candidateChars += rowToText(matchRow).length;
        batchRequests.push({
          custom_id: `candidate-${i}`,
          params: buildMatchParams(matchRow, systemBlocks),
        });
      }
      if (droppedColumns > 0) {
        console.log(
          `[match-columns] ${fileName}: dropped ${droppedColumns} column values across ${rows.length} rows from the LLM payload`,
        );
      }

      if (batchRequests.length === 0) {
        return res.json({
          batchId: null,
          rowCount: rows.length,
          preResolved,
          fileName,
          allPreResolved: true,
        });
      }

      // Cost estimate: hard-blocked rows are free; every other row pays the
      // full system prompt (no caching on the batch path) plus its own text.
      const llmRows = batchRequests.length;
      let systemTokens: number;
      try {
        const counted = await batchClient.messages.countTokens({
          model: MATCH_MODEL,
          system: systemBlocks,
          messages: [{ role: "user", content: "x" }],
        });
        systemTokens = counted.input_tokens;
      } catch {
        const systemChars = systemBlocks.reduce((n, b) => n + b.text.length, 0);
        systemTokens = estimateTokens(systemChars);
      }
      const estimatedInputTokens =
        llmRows * systemTokens + estimateTokens(candidateChars);
      const estimatedOutputTokens = llmRows * EST_OUTPUT_TOKENS_PER_ROW;
      const estimatedCostUsd =
        (estimatedInputTokens * BATCH_INPUT_USD_PER_MTOK +
          estimatedOutputTokens * BATCH_OUTPUT_USD_PER_MTOK) /
        1_000_000;

      if (confirmCost !== true) {
        // Phase 1: estimate only. Nothing was submitted to Anthropic.
        return res.json({
          requiresConfirmation: true,
          fileName,
          rowCount: rows.length,
          llmRows,
          systemTokens,
          estimatedInputTokens,
          estimatedCostUsd,
        });
      }

      console.log(
        `[batch-cost] ${fileName}: ${llmRows} LLM rows (${rows.length} total), ` +
          `~${systemTokens} system tokens/row, ~${estimatedInputTokens} input tokens, ` +
          `estimated ~$${estimatedCostUsd.toFixed(2)}`,
      );

      // csvText is required on the confirmed submit so the batch_jobs row can
      // rebuild exports without the client's localStorage.
      if (typeof csvText !== "string" || csvText.length === 0 || csvText.length > 5_000_000) {
        return res
          .status(400)
          .json({ message: "csvText (1..5,000,000 chars) is required to submit a batch" });
      }
      if ((await storage.countBatchJobs()) >= MAX_BATCH_JOBS) {
        return res
          .status(429)
          .json({ message: `Batch job limit reached (${MAX_BATCH_JOBS}).` });
      }

      // Durable-record ordering: write the intent row BEFORE the billable
      // Anthropic call, so a crash between create() and the id-update can never
      // leave a billed batch with no server record. If create() throws, the
      // "submitting" row is a harmless dangling record (nothing was billed) that
      // reconciliation (Fix 4) can prune.
      const jobId = randomUUID();
      await storage.createBatchJob({
        id: jobId,
        batchId: null,
        status: "submitting",
        fileName,
        rowCount: rows.length,
        csvText,
        preResolved: JSON.stringify(preResolved),
        submissionId:
          typeof submissionId === "string" && submissionId.length > 0 && submissionId.length <= 64
            ? submissionId
            : null,
        createdAt: Date.now(),
      });

      const batch = await batchClient.messages.batches.create({
        requests: batchRequests as Parameters<
          typeof batchClient.messages.batches.create
        >[0]["requests"],
      });

      // Reconcile the row with the real batch id. If this update throws after a
      // successful create(), we still return batch.id and log — the row is
      // recoverable by id/createdAt.
      try {
        await storage.updateBatchJob(jobId, { batchId: batch.id, status: "pending" });
      } catch (updateErr) {
        console.error(
          `[batch] row ${jobId} created batch ${batch.id} but status update failed:`,
          updateErr,
        );
      }

      res.json({
        jobId,
        batchId: batch.id,
        rowCount: rows.length,
        preResolved,
        fileName,
        allPreResolved: false,
        estimatedCostUsd,
      });
    } catch (err) {
      next(err);
    }
  });

  // Cancels an in-flight Anthropic batch. Requests the batch already finished
  // internally stay billed, but no further candidates are processed.
  app.post("/api/match/batch/:id/cancel", async (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      const batchClient = new Anthropic();
      const batch = await batchClient.messages.batches.cancel(req.params.id);
      res.json({ status: batch.processing_status });
    } catch (err) {
      next(err);
    }
  });

  // Checks Anthropic batch status. When ended, streams results, processes them,
  // and returns the full MatchResult array indexed to the original row order.
  app.get("/api/match/batch/:id", async (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      const batchClient = new Anthropic();
      const batch = await batchClient.messages.batches.retrieve(req.params.id);

      if (batch.processing_status !== "ended") {
        return res.json({
          status: batch.processing_status,
          requestCounts: batch.request_counts,
          results: null,
        });
      }

      const results: Record<number, unknown> = {};
      for await (const item of await batchClient.messages.batches.results(
        req.params.id,
      )) {
        const idx = parseInt((item.custom_id as string).replace("candidate-", ""), 10);
        if ((item.result as { type: string }).type === "succeeded") {
          const msg = (item.result as { type: "succeeded"; message: { content: unknown[] } }).message;
          results[idx] = processMatchContent(
            msg.content as Array<{ type: string; text?: string }>,
          );
        } else {
          const { HUMAN_REVIEW } = await import("@shared/matcher");
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

      // Persist results once, keyed by batch id (write-only-if-null). wrote=true
      // is the atomic first-completion signal that gates the one-time Slack
      // notify — re-polls and downloads can never refire it. A persist failure
      // must not block the response; the next poll retries the write.
      let firstCompletion = false;
      try {
        firstCompletion = (
          await storage.storeBatchResults(req.params.id, JSON.stringify(results))
        ).wrote;
      } catch (persistErr) {
        console.error(`[batch] persisting results failed id=${req.params.id}:`, persistErr);
      }

      res.json({ status: "ended", requestCounts: batch.request_counts, results });

      console.log(
        `[batch] complete id=${req.params.id} env=${process.env.NODE_ENV} rows=${Object.keys(results).length} firstCompletion=${firstCompletion}`,
      );

      if (firstCompletion) {
        // Fire-and-forget Slack notification, first completion only.
        const fileName = typeof req.query.fileName === "string" ? req.query.fileName : "batch job";
        const counts = batch.request_counts as { succeeded: number; errored: number };
        sendSlackNotification(
          `*phData Matcher — Batch Complete* ✓\n` +
          `File: ${fileName}\n` +
          `${counts.succeeded} candidates scored` +
          (counts.errored > 0 ? `, ${counts.errored} errors` : "") +
          `\nResults have been auto-loaded in the app.`,
        ).catch((err) => console.warn("[slack] batch notification failed:", err));
      }
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/calibrations/analysis", async (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      const corrections = await storage.listCorrections();
      const correctionCount = corrections.length;
      const tippingPointReached = correctionCount >= TIPPING_POINT;

      if (req.query.generate !== "true") {
        return res.json({ correctionCount, tippingPoint: TIPPING_POINT, tippingPointReached, analysis: null });
      }

      if (correctionCount === 0) {
        return res.json({ correctionCount, tippingPoint: TIPPING_POINT, tippingPointReached, analysis: "No corrections recorded yet." });
      }

      const examples: CorrectionExample[] = corrections.map((c) => ({
        candidateName: c.candidateName,
        originalDepartment: c.originalDepartment,
        correctedDepartment: c.correctedDepartment,
        feedbackReason: c.feedbackReason,
      }));

      const analysis = await generateCalibrationAnalysis(examples);

      if (process.env.SLACK_WEBHOOK_URL) {
        sendSlackNotification(
          `*phData Matcher — Calibration Analysis (${correctionCount} corrections)*\n\n${analysis}`,
        ).catch((err) => console.warn("[slack] send failed:", err));
      }

      res.json({ correctionCount, tippingPoint: TIPPING_POINT, tippingPointReached, analysis });
    } catch (err) {
      next(err);
    }
  });

  return httpServer;
}
