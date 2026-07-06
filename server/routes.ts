import type { Express } from "express";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { calibrationRequestSchema, saveFileRequestSchema } from "@shared/schema";
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
  type CorrectionExample,
} from "./matcher-llm";
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
const TIPPING_POINT = 50;

async function sendSlackNotification(text: string): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
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
      const rawCorrections = await storage.listCorrections();
      const corrections: CorrectionExample[] = rawCorrections.map((c) => ({
        candidateName: c.candidateName,
        originalDepartment: c.originalDepartment,
        correctedDepartment: c.correctedDepartment,
        feedbackReason: c.feedbackReason,
      }));
      const libraryDigest = await getLibraryDigest();
      const result = await matchCandidateLLM(row, corrections, libraryDigest);
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
  // -> $1/$5 batched). Estimates are labeled as such — chars/3.6 per token is
  // deliberately conservative (overestimates slightly).
  const BATCH_INPUT_USD_PER_MTOK = 1.0;
  const BATCH_OUTPUT_USD_PER_MTOK = 5.0;
  const EST_OUTPUT_TOKENS_PER_ROW = 250; // max_tokens is 512; rationales run ~150-300
  const MAX_BATCH_ROWS = 500; // also bounds request-payload memory (see OOM note below)
  const estimateTokens = (chars: number) => Math.ceil(chars / 3.6);

  // Accepts parsed candidate rows, submits them to the Anthropic Batch API
  // (50% cost vs real-time), and returns the Anthropic batch ID immediately.
  // Hard-block candidates are resolved instantly and returned alongside the ID.
  app.post("/api/match/batch", async (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      const { rows, fileName, confirmCost } = req.body as {
        rows: Record<string, string>[];
        fileName: string;
        confirmCost?: boolean;
      };
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ message: "rows must be a non-empty array" });
      }
      if (rows.length > MAX_BATCH_ROWS) {
        return res
          .status(400)
          .json({ message: `Maximum ${MAX_BATCH_ROWS} rows per batch` });
      }

      const rawCorrections = await storage.listCorrections();
      const corrections: CorrectionExample[] = rawCorrections.map((c) => ({
        candidateName: c.candidateName,
        originalDepartment: c.originalDepartment,
        correctedDepartment: c.correctedDepartment,
        feedbackReason: c.feedbackReason,
      }));

      const libraryDigest = await getLibraryDigest();
      // Built ONCE per batch and shared by reference across all rows. Never
      // rebuild the prompt per row: 2000 copies of a multi-KB string is what
      // put the 512MB Render instance out of memory.
      const systemBlocks = buildBatchSystemBlocks(corrections, libraryDigest);
      const batchClient = new Anthropic();
      const batchRequests: Array<{ custom_id: string; params: unknown }> = [];
      const preResolved: Record<number, unknown> = {};
      let candidateChars = 0;

      for (let i = 0; i < rows.length; i++) {
        const candidateText = Object.entries(rows[i])
          .filter(([, v]) => String(v ?? "").trim().length > 0)
          .map(([k, v]) => `${k}: ${String(v).slice(0, 3000)}`)
          .join("\n");
        const hardBlock = checkHardBlock(candidateText);
        if (hardBlock) {
          preResolved[i] = hardBlock;
        } else {
          candidateChars += candidateText.length;
          batchRequests.push({
            custom_id: `candidate-${i}`,
            params: buildMatchParams(rows[i], systemBlocks),
          });
        }
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
      const systemChars = systemBlocks.reduce((n, b) => n + b.text.length, 0);
      const systemTokens = estimateTokens(systemChars);
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

      const batch = await batchClient.messages.batches.create({
        requests: batchRequests as Parameters<
          typeof batchClient.messages.batches.create
        >[0]["requests"],
      });

      res.json({
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

      res.json({ status: "ended", requestCounts: batch.request_counts, results });

      // Fire-and-forget Slack notification when batch completes.
      const fileName = typeof req.query.fileName === "string" ? req.query.fileName : "batch job";
      const counts = batch.request_counts as { succeeded: number; errored: number };
      sendSlackNotification(
        `*phData Matcher — Batch Complete* ✓\n` +
        `File: ${fileName}\n` +
        `${counts.succeeded} candidates scored` +
        (counts.errored > 0 ? `, ${counts.errored} errors` : "") +
        `\nResults have been auto-loaded in the app.`,
      ).catch(() => {});
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
