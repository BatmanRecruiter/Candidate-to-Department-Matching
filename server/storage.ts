import { batchJobs, calibrations, correctionRules, savedFiles, syncedRoles, syncRuns, users } from '@shared/schema';
import type {
  BatchJob,
  BatchJobSummary,
  Calibration,
  CalibrationSummary,
  CorrectionRules,
  SavedFile,
  SavedFileSummary,
  SyncedRole,
  SyncRun,
  User,
  InsertUser,
} from '@shared/schema';
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { and, count, desc, eq, isNull, ne } from "drizzle-orm";

const sql = neon(process.env.DATABASE_URL!);
export const db = drizzle({ client: sql });

export interface IStorage {
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  listSavedFiles(): Promise<SavedFileSummary[]>;
  getSavedFile(id: string): Promise<SavedFile | undefined>;
  countSavedFiles(): Promise<number>;
  createSavedFile(file: SavedFile): Promise<SavedFile>;
  listBatchJobs(): Promise<BatchJobSummary[]>;
  listArchivedBatchJobs(): Promise<BatchJobSummary[]>;
  setBatchJobArchived(id: string, archived: boolean): Promise<void>;
  getBatchJob(id: string): Promise<BatchJob | undefined>;
  countBatchJobs(): Promise<number>;
  createBatchJob(job: typeof batchJobs.$inferInsert): Promise<BatchJob>;
  updateBatchJob(
    id: string,
    patch: Partial<Pick<BatchJob, "batchId" | "status">>,
  ): Promise<void>;
  storeBatchResults(batchId: string, resultsJson: string): Promise<{ wrote: boolean }>;
  archiveAllBatchJobs(): Promise<void>;
  listCalibrations(): Promise<CalibrationSummary[]>;
  listCorrections(): Promise<CalibrationSummary[]>;
  countCalibrations(): Promise<number>;
  countCorrections(): Promise<number>;
  createCalibration(calibration: Calibration): Promise<Calibration>;
  getCorrectionRules(): Promise<CorrectionRules | undefined>;
  upsertCorrectionRules(rules: CorrectionRules): Promise<void>;
  listSyncedRoles(activeOnly?: boolean): Promise<SyncedRole[]>;
  upsertSyncedRole(
    role: SyncedRole,
  ): Promise<{ inserted: boolean; needsSummary: boolean }>;
  updateSyncedRoleSummary(jobId: string, summary: string): Promise<void>;
  deactivateSyncedRolesNotIn(activeIds: string[], now: number): Promise<number>;
  recordSyncRun(run: SyncRun): Promise<SyncRun>;
  latestSyncRun(): Promise<SyncRun | undefined>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: number): Promise<User | undefined> {
    const [row] = await db.select().from(users).where(eq(users.id, id));
    return row;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [row] = await db.select().from(users).where(eq(users.username, username));
    return row;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [row] = await db.insert(users).values(insertUser).returning();
    return row;
  }

  async listSavedFiles(): Promise<SavedFileSummary[]> {
    return db
      .select({
        id: savedFiles.id,
        runId: savedFiles.runId,
        kind: savedFiles.kind,
        fileName: savedFiles.fileName,
        rowCount: savedFiles.rowCount,
        columnCount: savedFiles.columnCount,
        byteSize: savedFiles.byteSize,
        createdAt: savedFiles.createdAt,
      })
      .from(savedFiles)
      .orderBy(desc(savedFiles.createdAt))
      .limit(50);
  }

  async getSavedFile(id: string): Promise<SavedFile | undefined> {
    const [row] = await db.select().from(savedFiles).where(eq(savedFiles.id, id));
    return row;
  }

  async createSavedFile(file: SavedFile): Promise<SavedFile> {
    const [row] = await db.insert(savedFiles).values(file).returning();
    return row;
  }

  async countSavedFiles(): Promise<number> {
    const [row] = await db.select({ value: count() }).from(savedFiles);
    return row?.value ?? 0;
  }

  // Batch jobs. listBatchJobs mirrors listSavedFiles: an explicit column
  // projection that OMITS the large csvText + preResolved blobs so the list
  // endpoint never pays egress for them. getBatchJob returns the full row
  // (incl. csvText) and is only hit when rebuilding an export.
  async listBatchJobs(): Promise<BatchJobSummary[]> {
    return db
      .select({
        id: batchJobs.id,
        batchId: batchJobs.batchId,
        status: batchJobs.status,
        fileName: batchJobs.fileName,
        rowCount: batchJobs.rowCount,
        submissionId: batchJobs.submissionId, // tiny string — the "this run" grouping key; results stays excluded
        createdAt: batchJobs.createdAt,
        archived: batchJobs.archived,
      })
      .from(batchJobs)
      .where(eq(batchJobs.archived, false))
      .orderBy(desc(batchJobs.createdAt))
      .limit(100);
  }

  // Same projection discipline as listBatchJobs (no csvText/preResolved/results
  // egress) — just the soft-hidden rows for the "Show archived" view.
  async listArchivedBatchJobs(): Promise<BatchJobSummary[]> {
    return db
      .select({
        id: batchJobs.id,
        batchId: batchJobs.batchId,
        status: batchJobs.status,
        fileName: batchJobs.fileName,
        rowCount: batchJobs.rowCount,
        submissionId: batchJobs.submissionId,
        createdAt: batchJobs.createdAt,
        archived: batchJobs.archived,
      })
      .from(batchJobs)
      .where(eq(batchJobs.archived, true))
      .orderBy(desc(batchJobs.createdAt))
      .limit(100);
  }

  async setBatchJobArchived(id: string, archived: boolean): Promise<void> {
    await db.update(batchJobs).set({ archived }).where(eq(batchJobs.id, id));
  }

  async getBatchJob(id: string): Promise<BatchJob | undefined> {
    const [row] = await db.select().from(batchJobs).where(eq(batchJobs.id, id));
    return row;
  }

  async countBatchJobs(): Promise<number> {
    const [row] = await db.select({ value: count() }).from(batchJobs);
    return row?.value ?? 0;
  }

  async createBatchJob(job: typeof batchJobs.$inferInsert): Promise<BatchJob> {
    const [row] = await db.insert(batchJobs).values(job).returning();
    return row;
  }

  // Mirrors updateSyncedRoleSummary's update-set-where shape. Used by the submit
  // flow to flip "submitting" -> "pending" with the real batch_id, and by the
  // PATCH endpoint for client-driven status transitions.
  async updateBatchJob(
    id: string,
    patch: Partial<Pick<BatchJob, "batchId" | "status">>,
  ): Promise<void> {
    await db.update(batchJobs).set(patch).where(eq(batchJobs.id, id));
  }

  // Persist a completed batch's results, keyed by the Anthropic batch id.
  // Writes ONLY while results is still null — the returned wrote=true is the
  // atomic "first completion" signal that gates the one-time Slack notify.
  // Idempotent, so repeat polls and the backfill script can call it freely.
  async storeBatchResults(
    batchId: string,
    resultsJson: string,
  ): Promise<{ wrote: boolean }> {
    const updated = await db
      .update(batchJobs)
      .set({ results: resultsJson })
      .where(and(eq(batchJobs.batchId, batchId), isNull(batchJobs.results)))
      .returning({ id: batchJobs.id });
    return { wrote: updated.length > 0 };
  }

  // "Clear all" soft-hide: mark every visible job archived instead of deleting,
  // so a durable billing record is never lost (reversible via the flag).
  async archiveAllBatchJobs(): Promise<void> {
    await db
      .update(batchJobs)
      .set({ archived: true })
      .where(eq(batchJobs.archived, false));
  }

  async listCalibrations(): Promise<CalibrationSummary[]> {
    return db
      .select({
        id: calibrations.id,
        candidateKey: calibrations.candidateKey,
        candidateName: calibrations.candidateName,
        originalDepartment: calibrations.originalDepartment,
        originalRole: calibrations.originalRole,
        originalConfidence: calibrations.originalConfidence,
        isCorrect: calibrations.isCorrect,
        correctedDepartment: calibrations.correctedDepartment,
        correctedRole: calibrations.correctedRole,
        feedbackReason: calibrations.feedbackReason,
        createdAt: calibrations.createdAt,
      })
      .from(calibrations)
      .orderBy(desc(calibrations.createdAt))
      .limit(500);
  }

  async createCalibration(calibration: Calibration): Promise<Calibration> {
    const [row] = await db.insert(calibrations).values(calibration).returning();
    return row;
  }

  async listCorrections(): Promise<CalibrationSummary[]> {
    return db
      .select({
        id: calibrations.id,
        candidateKey: calibrations.candidateKey,
        candidateName: calibrations.candidateName,
        originalDepartment: calibrations.originalDepartment,
        originalRole: calibrations.originalRole,
        originalConfidence: calibrations.originalConfidence,
        isCorrect: calibrations.isCorrect,
        correctedDepartment: calibrations.correctedDepartment,
        correctedRole: calibrations.correctedRole,
        feedbackReason: calibrations.feedbackReason,
        createdAt: calibrations.createdAt,
      })
      .from(calibrations)
      .where(ne(calibrations.isCorrect, 1))
      .orderBy(desc(calibrations.createdAt))
      .limit(200);
  }

  async countCorrections(): Promise<number> {
    const [row] = await db
      .select({ value: count() })
      .from(calibrations)
      .where(ne(calibrations.isCorrect, 1));
    return row?.value ?? 0;
  }

  async countCalibrations(): Promise<number> {
    const [row] = await db.select({ value: count() }).from(calibrations);
    return row?.value ?? 0;
  }

  async getCorrectionRules(): Promise<CorrectionRules | undefined> {
    const [row] = await db
      .select()
      .from(correctionRules)
      .where(eq(correctionRules.id, "current"));
    return row;
  }

  async upsertCorrectionRules(rules: CorrectionRules): Promise<void> {
    const existing = await this.getCorrectionRules();
    if (existing) {
      await db
        .update(correctionRules)
        .set({
          rulesText: rules.rulesText,
          correctionCount: rules.correctionCount,
          updatedAt: rules.updatedAt,
        })
        .where(eq(correctionRules.id, rules.id));
      return;
    }
    await db.insert(correctionRules).values(rules);
  }

  async listSyncedRoles(activeOnly = false): Promise<SyncedRole[]> {
    if (activeOnly) {
      return db.select().from(syncedRoles).where(eq(syncedRoles.isActive, 1));
    }
    return db.select().from(syncedRoles);
  }

  async upsertSyncedRole(
    role: SyncedRole,
  ): Promise<{ inserted: boolean; needsSummary: boolean }> {
    const [existing] = await db
      .select({
        jobId: syncedRoles.jobId,
        body: syncedRoles.body,
        summary: syncedRoles.summary,
      })
      .from(syncedRoles)
      .where(eq(syncedRoles.jobId, role.jobId));
    if (existing) {
      await db
        .update(syncedRoles)
        .set({
          department: role.department,
          title: role.title,
          location: role.location,
          url: role.url,
          region: role.region,
          seniority: role.seniority,
          requiredYoe: role.requiredYoe,
          requiredSkills: role.requiredSkills,
          preferredSkills: role.preferredSkills,
          body: role.body,
          searchText: role.searchText,
          source: role.source,
          isActive: 1,
          lastSeenAt: role.lastSeenAt,
        })
        .where(eq(syncedRoles.jobId, role.jobId));
      // Note: the update above intentionally leaves `summary` untouched.
      // Re-summarize only when the posting text changed, or to fill a gap.
      return {
        inserted: false,
        needsSummary: existing.summary == null || existing.body !== role.body,
      };
    }
    await db.insert(syncedRoles).values(role);
    return { inserted: true, needsSummary: true };
  }

  async updateSyncedRoleSummary(jobId: string, summary: string): Promise<void> {
    await db
      .update(syncedRoles)
      .set({ summary })
      .where(eq(syncedRoles.jobId, jobId));
  }

  async deactivateSyncedRolesNotIn(
    activeIds: string[],
    now: number,
  ): Promise<number> {
    const all = await db
      .select({ jobId: syncedRoles.jobId, isActive: syncedRoles.isActive })
      .from(syncedRoles);
    const activeSet = new Set(activeIds);
    let deactivated = 0;
    for (const row of all) {
      if (!activeSet.has(row.jobId) && row.isActive === 1) {
        await db
          .update(syncedRoles)
          .set({ isActive: 0, lastSeenAt: now })
          .where(eq(syncedRoles.jobId, row.jobId));
        deactivated++;
      }
    }
    return deactivated;
  }

  async recordSyncRun(run: SyncRun): Promise<SyncRun> {
    const [row] = await db.insert(syncRuns).values(run).returning();
    return row;
  }

  async latestSyncRun(): Promise<SyncRun | undefined> {
    const [row] = await db
      .select()
      .from(syncRuns)
      .orderBy(desc(syncRuns.finishedAt))
      .limit(1);
    return row;
  }
}

export const storage = new DatabaseStorage();
