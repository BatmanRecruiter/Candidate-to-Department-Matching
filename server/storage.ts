import { calibrations, savedFiles, syncedRoles, syncRuns, users } from '@shared/schema';
import type {
  Calibration,
  CalibrationSummary,
  SavedFile,
  SavedFileSummary,
  SyncedRole,
  SyncRun,
  User,
  InsertUser,
} from '@shared/schema';
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { count, desc, eq, ne } from "drizzle-orm";

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
  listCalibrations(): Promise<CalibrationSummary[]>;
  listCorrections(): Promise<CalibrationSummary[]>;
  countCalibrations(): Promise<number>;
  countCorrections(): Promise<number>;
  createCalibration(calibration: Calibration): Promise<Calibration>;
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
