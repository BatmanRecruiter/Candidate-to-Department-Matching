import { pgTable, text, integer, bigint } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Template keeps users table to satisfy storage scaffolding; unused.
export const users = pgTable("users", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const savedFiles = pgTable("saved_files", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  historyKeyHash: text("history_key_hash").notNull(),
  kind: text("kind").notNull(),
  fileName: text("file_name").notNull(),
  rowCount: integer("row_count").notNull(),
  columnCount: integer("column_count").notNull(),
  byteSize: integer("byte_size").notNull(),
  csvText: text("csv_text").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const syncedRoles = pgTable("synced_roles", {
  jobId: text("job_id").primaryKey(),
  department: text("department").notNull(),
  title: text("title").notNull(),
  location: text("location").notNull(),
  url: text("url").notNull(),
  region: text("region").notNull(),
  seniority: text("seniority").notNull(),
  requiredYoe: integer("required_yoe"),
  requiredSkills: text("required_skills").notNull(), // JSON-encoded string[]
  preferredSkills: text("preferred_skills").notNull(), // JSON-encoded string[]
  body: text("body").notNull(),
  searchText: text("search_text").notNull(),
  source: text("source").notNull(), // "greenhouse" | "manual"
  summary: text("summary"), // LLM-generated responsibilities/qualifications digest, filled once per role
  isActive: integer("is_active").notNull().default(1),
  firstSeenAt: bigint("first_seen_at", { mode: "number" }).notNull(),
  lastSeenAt: bigint("last_seen_at", { mode: "number" }).notNull(),
});

export const syncRuns = pgTable("sync_runs", {
  id: text("id").primaryKey(),
  startedAt: bigint("started_at", { mode: "number" }).notNull(),
  finishedAt: bigint("finished_at", { mode: "number" }).notNull(),
  status: text("status").notNull(),
  source: text("source").notNull(), // "manual" | "automated"
  rolesFound: integer("roles_found").notNull().default(0),
  rolesNew: integer("roles_new").notNull().default(0),
  rolesUpdated: integer("roles_updated").notNull().default(0),
  rolesDeactivated: integer("roles_deactivated").notNull().default(0),
  errorMessage: text("error_message"),
});

export type SyncedRole = typeof syncedRoles.$inferSelect;
export type SyncRun = typeof syncRuns.$inferSelect;

// Single-row table ("current") holding the Haiku-distilled routing rules
// derived from all recruiter corrections. Rebuilt when a correction lands —
// never per request — so the prompt's corrections block stays bounded.
export const correctionRules = pgTable("correction_rules", {
  id: text("id").primaryKey(),
  rulesText: text("rules_text").notNull(),
  correctionCount: integer("correction_count").notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export type CorrectionRules = typeof correctionRules.$inferSelect;

export const calibrations = pgTable("calibrations", {
  id: text("id").primaryKey(),
  historyKeyHash: text("history_key_hash").notNull(),
  candidateKey: text("candidate_key").notNull(),
  candidateName: text("candidate_name").notNull(),
  originalDepartment: text("original_department").notNull(),
  originalRole: text("original_role").notNull(),
  originalConfidence: integer("original_confidence").notNull(),
  isCorrect: integer("is_correct").notNull(),
  correctedDepartment: text("corrected_department").notNull(),
  correctedRole: text("corrected_role").notNull(),
  feedbackReason: text("feedback_reason").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

// Durable record of every submitted batch job. Makes Neon — not the browser's
// localStorage — the source of truth so a billed Anthropic batch can never be
// orphaned by a client-side crash. The row is inserted with status "submitting"
// BEFORE the Anthropic create() call (intent-log-before-side-effect), then
// updated with the real batch_id. csvText/preResolved are the large fields and
// are excluded from list queries (see BatchJobSummary) to avoid egress cost.
export const batchJobs = pgTable("batch_jobs", {
  id: text("id").primaryKey(),
  batchId: text("batch_id"), // Anthropic batch id; NULL until create() returns (or for all-hard-blocked jobs)
  status: text("status").notNull(), // submitting | pending | complete | error | canceled
  fileName: text("file_name").notNull(),
  rowCount: integer("row_count").notNull(),
  csvText: text("csv_text").notNull(), // full original CSV — rebuilds exports; NEVER selected in list queries
  preResolved: text("pre_resolved").notNull(), // JSON-encoded Record<number, MatchResult> of hard-blocked rows
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const insertSavedFileSchema = createInsertSchema(savedFiles).omit({
  id: true,
  createdAt: true,
});

export const saveFileRequestSchema = z.object({
  runId: z.string().min(1).max(120).optional(),
  kind: z.enum(["upload", "export"]),
  fileName: z.string().min(1).max(240),
  rowCount: z.number().int().min(0),
  columnCount: z.number().int().min(0),
  csvText: z.string().min(1).max(5_000_000),
});

export const calibrationRequestSchema = z.object({
  candidateKey: z.string().min(1).max(500),
  candidateName: z.string().min(1).max(240),
  originalDepartment: z.string().min(1).max(240),
  originalRole: z.string().min(1).max(300),
  originalConfidence: z.number().int().min(0).max(3),
  isCorrect: z.boolean(),
  correctedDepartment: z.string().max(240).optional().default(""),
  correctedRole: z.string().max(300).optional().default(""),
  feedbackReason: z.string().max(1200).optional().default(""),
});

export type InsertSavedFile = z.infer<typeof insertSavedFileSchema>;
export type SaveFileRequest = z.infer<typeof saveFileRequestSchema>;
export type SavedFile = typeof savedFiles.$inferSelect;
export type SavedFileSummary = Omit<SavedFile, "csvText" | "historyKeyHash">;
export type CalibrationRequest = z.infer<typeof calibrationRequestSchema>;
export type Calibration = typeof calibrations.$inferSelect;
export type CalibrationSummary = Omit<Calibration, "historyKeyHash">;

// Batch jobs. A "complete" all-hard-blocked job (no Anthropic batch) is created
// straight from the client via POST; billed jobs are created server-side by the
// /api/match/batch submit flow. status is the only field the client PATCHes.
const BATCH_STATUS = ["submitting", "pending", "complete", "error", "canceled"] as const;
export const batchJobRequestSchema = z.object({
  batchId: z.string().max(200).nullable().optional(),
  status: z.enum(BATCH_STATUS),
  fileName: z.string().min(1).max(240),
  rowCount: z.number().int().min(0),
  csvText: z.string().min(1).max(5_000_000),
  preResolved: z.string().max(10_000_000), // JSON-encoded; generous bound
});
export const batchJobPatchSchema = z.object({
  status: z.enum(BATCH_STATUS),
});
export type BatchJobRequest = z.infer<typeof batchJobRequestSchema>;
export type BatchJob = typeof batchJobs.$inferSelect;
export type BatchJobSummary = Omit<BatchJob, "csvText" | "preResolved">;

// Re-export matcher / template types for client + server use.
export type { RoleLibraryJob, MatchResult } from "./matcher";
