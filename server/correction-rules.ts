import Anthropic from "@anthropic-ai/sdk";
import { storage } from "./storage";
import type { CalibrationSummary } from "@shared/schema";
import type { CorrectionExample } from "./matcher-llm";

/**
 * Corrections distillation.
 *
 * The old corrections block appended EVERY correction as a full worked
 * example, so it grew without bound and was paid per candidate in every
 * batch. Instead, all corrections are distilled ONCE (per new correction)
 * into a compact rules block stored in the correction_rules table, plus the
 * 5 most recent raw examples for few-shot value. The full correction history
 * in the calibrations table is untouched — this only changes what rides in
 * the prompt. Rebuilds happen when a correction lands, never per request.
 */

const RULES_MODEL = "claude-haiku-4-5";
const RECENT_EXAMPLES = 5;
// Deterministic hard cap on the stored rules text (~400 tokens). The block is
// paid per candidate in batch runs; a runaway distillation must not be able
// to silently inflate every request.
const MAX_RULES_CHARS = 1600;

const DISTILL_SYSTEM = `You maintain routing rules for an AI recruiter-matching system that assigns candidates to phData departments: Data Engineering, Analytics, Machine Learning, Advisory, Business Architecture, Managed Services, PMO, Sales. You will receive recruiter corrections (system routed X, recruiter corrected to Y, with notes). Compress ALL of them into telegraphic routing rules, grouped by misroute pattern — general rules, not case files. Format: one rule per line, "- <profile pattern> -> <correct department>, not <wrong department> (<why, few words>)". Merge similar corrections into one rule. Order rules by how many corrections support them. Maximum 350 words. No preamble, no markdown headers — output only the rule lines.`;

function toExample(c: CalibrationSummary): CorrectionExample {
  return {
    candidateName: c.candidateName,
    originalDepartment: c.originalDepartment,
    correctedDepartment: c.correctedDepartment,
    feedbackReason: c.feedbackReason,
  };
}

// Same per-correction format the prompt has always used for worked examples.
function formatCorrectionExamples(corrections: CorrectionExample[]): string {
  return corrections
    .map(
      (c, i) =>
        `[${i + 1}] ${c.candidateName || "Candidate"}\n` +
        `    System routed to: ${c.originalDepartment}\n` +
        `    Recruiter corrected to: ${c.correctedDepartment}\n` +
        `    Recruiter note: ${c.feedbackReason?.trim() || "(no note provided)"}`,
    )
    .join("\n\n");
}

function capRules(text: string): string {
  return text.length > MAX_RULES_CHARS
    ? `${text.slice(0, MAX_RULES_CHARS - 1)}…`
    : text;
}

export async function distillCorrections(
  corrections: CorrectionExample[],
): Promise<string> {
  const lines = corrections
    .map(
      (c, i) =>
        `${i + 1}. ${c.candidateName || "Unnamed"}: routed to "${c.originalDepartment}" -> corrected to "${c.correctedDepartment}"` +
        (c.feedbackReason ? ` | Note: ${c.feedbackReason}` : ""),
    )
    .join("\n");
  // Plain UNCACHED call — deliberate exception to the cachedMessage
  // convention: this is a one-shot distillation whose prompt is never read
  // back from cache, so a cache_control marker would pay the 1h write
  // premium (2x input) for nothing.
  const client = new Anthropic();
  const resp = await client.messages.create({
    model: RULES_MODEL,
    max_tokens: 500,
    system: DISTILL_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Corrections (${corrections.length} total):\n\n${lines}`,
      },
    ],
  });
  const textBlock = resp.content.find((b: { type: string }) => b.type === "text") as
    | { type: "text"; text: string }
    | undefined;
  const text = textBlock?.text?.trim();
  if (!text) throw new Error("distillation response contained no text");
  return text;
}

// In-memory cache of the composed prompt block, invalidated when a
// correction lands (same pattern as the role-library digest cache).
let blockCache: string | null = null;

export function invalidateCorrectionRulesCache(): void {
  blockCache = null;
}

export async function getCorrectionsPromptBlock(): Promise<string> {
  if (blockCache !== null) return blockCache;
  const corrections = await storage.listCorrections(); // createdAt DESC
  if (corrections.length === 0) {
    blockCache = "";
    return blockCache;
  }
  const stored = await storage.getCorrectionRules();
  const recent = corrections.slice(0, RECENT_EXAMPLES).map(toExample);
  const parts: string[] = [];
  if (stored?.rulesText) {
    parts.push(
      `MATCHING RULES LEARNED FROM ${stored.correctionCount} RECRUITER CORRECTIONS — apply these when a candidate fits the described pattern:\n\n${stored.rulesText}`,
    );
  }
  parts.push(
    `MOST RECENT CORRECTIONS (verbatim examples):\n\n${formatCorrectionExamples(recent)}\n\nIf a new candidate resembles one of these profiles, route them as the recruiter corrected, not as the system originally guessed.`,
  );
  blockCache = parts.join("\n\n");
  return blockCache;
}

// Distills all corrections and stores the result. Failure keeps the previous
// stored rules — this must never break the calibration write path.
export async function rebuildCorrectionRules(): Promise<void> {
  const corrections = await storage.listCorrections();
  if (corrections.length === 0) return;
  const rules = capRules(await distillCorrections(corrections.map(toExample)));
  await storage.upsertCorrectionRules({
    id: "current",
    rulesText: rules,
    correctionCount: corrections.length,
    updatedAt: Date.now(),
  });
  invalidateCorrectionRulesCache();
  console.log(
    `[correction-rules] distilled ${corrections.length} corrections into ${rules.length} chars`,
  );
}
