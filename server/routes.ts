import type { Express } from "express";
import { createServer } from "node:http";
import type { Server } from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { augmentRoleLibrary, type RoleLibraryJob } from "@shared/matcher";
import { calibrationRequestSchema, saveFileRequestSchema } from "@shared/schema";
import { storage } from "./storage";
import { runRoleSync, syncedRoleToLibraryJob } from "./role-sync";
import {
  matchCandidateLLM,
  buildMatchParams,
  checkHardBlock,
  processMatchContent,
  type CorrectionExample,
} from "./matcher-llm";
import Anthropic from "@anthropic-ai/sdk";
// Statically import the role library so esbuild bundles it into the
// production server build. The dev server also reads the file from disk as a
// fallback so regenerating the JSON without restarting works.
import BUNDLED_LIBRARY from "../shared/role-library.json";

function _dirname(): string {
  try {
    // CJS at runtime
    // @ts-ignore
    if (typeof __dirname !== "undefined") return __dirname as unknown as string;
  } catch {}
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

// Read the role library JSON once at startup. We bundle a snapshot under
// shared/role-library.json. The build script (scripts/build-role-library.ts)
// regenerates it from the source .txt files.
function loadLibrary(): { generated_at: string; jobs: RoleLibraryJob[] } {
  const candidates = [
    path.resolve(process.cwd(), "shared/role-library.json"),
    path.resolve(_dirname(), "../shared/role-library.json"),
    path.resolve(_dirname(), "../../shared/role-library.json"),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, "utf-8"));
      }
    } catch {}
  }
  // Fallback: the bundled snapshot baked into the build.
  if (BUNDLED_LIBRARY && Array.isArray((BUNDLED_LIBRARY as any).jobs)) {
    return BUNDLED_LIBRARY as { generated_at: string; jobs: RoleLibraryJob[] };
  }
  console.warn("[role-library] could not find role-library.json");
  return { generated_at: new Date().toISOString(), jobs: [] };
}

const LIBRARY = loadLibrary();
const AUGMENTED_LIBRARY = {
  ...LIBRARY,
  jobs: augmentRoleLibrary(LIBRARY.jobs),
};
console.log(
  `[role-library] loaded ${AUGMENTED_LIBRARY.jobs.length} jobs (generated ${AUGMENTED_LIBRARY.generated_at})`,
);

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
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
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
  // Combine the bundled (historical) library with any active synced roles,
  // deduped by job_id. Bundled roles win on ID conflict so historical context
  // is preserved exactly as-shipped.
  async function buildCombinedLibrary(): Promise<{
    generated_at: string;
    jobs: RoleLibraryJob[];
    bundled_count: number;
    synced_count: number;
  }> {
    const synced = await storage.listSyncedRoles(true);
    const bundledIds = new Set(AUGMENTED_LIBRARY.jobs.map((j) => j.job_id).filter(Boolean));
    const additions: RoleLibraryJob[] = [];
    for (const row of synced) {
      if (bundledIds.has(row.jobId)) continue;
      additions.push(syncedRoleToLibraryJob(row));
    }
    return {
      generated_at: AUGMENTED_LIBRARY.generated_at,
      jobs: [...AUGMENTED_LIBRARY.jobs, ...additions],
      bundled_count: AUGMENTED_LIBRARY.jobs.length,
      synced_count: additions.length,
    };
  }

  app.get("/api/role-library", async (_req, res, next) => {
    try {
      const combined = await buildCombinedLibrary();
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
      const combined = await buildCombinedLibrary();
      res.json({
        ok: true,
        jobs: combined.jobs.length,
        bundled_jobs: combined.bundled_count,
        synced_jobs: combined.synced_count,
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
      const result = await matchCandidateLLM(row, corrections);
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
  // Accepts parsed candidate rows, submits them to the Anthropic Batch API
  // (50% cost vs real-time), and returns the Anthropic batch ID immediately.
  // Hard-block candidates are resolved instantly and returned alongside the ID.
  app.post("/api/match/batch", async (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      const { rows, fileName } = req.body as {
        rows: Record<string, string>[];
        fileName: string;
      };
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ message: "rows must be a non-empty array" });
      }
      if (rows.length > 2000) {
        return res.status(400).json({ message: "Maximum 2000 rows per batch" });
      }

      const rawCorrections = await storage.listCorrections();
      const corrections: CorrectionExample[] = rawCorrections.map((c) => ({
        candidateName: c.candidateName,
        originalDepartment: c.originalDepartment,
        correctedDepartment: c.correctedDepartment,
        feedbackReason: c.feedbackReason,
      }));

      const batchClient = new Anthropic();
      const batchRequests: Array<{ custom_id: string; params: unknown }> = [];
      const preResolved: Record<number, unknown> = {};

      for (let i = 0; i < rows.length; i++) {
        const candidateText = Object.entries(rows[i])
          .filter(([, v]) => String(v ?? "").trim().length > 0)
          .map(([k, v]) => `${k}: ${String(v).slice(0, 3000)}`)
          .join("\n");
        const hardBlock = checkHardBlock(candidateText);
        if (hardBlock) {
          preResolved[i] = hardBlock;
        } else {
          batchRequests.push({
            custom_id: `candidate-${i}`,
            params: buildMatchParams(rows[i], corrections),
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
      });
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
