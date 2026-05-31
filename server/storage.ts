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
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { count, desc, eq } from "drizzle-orm";

const sqlite = new Database("data.db");
sqlite.pragma("journal_mode = WAL");
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS saved_files (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    history_key_hash TEXT NOT NULL,
    kind TEXT NOT NULL,
    file_name TEXT NOT NULL,
    row_count INTEGER NOT NULL,
    column_count INTEGER NOT NULL,
    byte_size INTEGER NOT NULL,
    csv_text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_saved_files_created_at ON saved_files(created_at);
  CREATE INDEX IF NOT EXISTS idx_saved_files_run_id ON saved_files(run_id);

  CREATE TABLE IF NOT EXISTS calibrations (
    id TEXT PRIMARY KEY,
    history_key_hash TEXT NOT NULL,
    candidate_key TEXT NOT NULL,
    candidate_name TEXT NOT NULL,
    original_department TEXT NOT NULL,
    original_role TEXT NOT NULL,
    original_confidence INTEGER NOT NULL,
    is_correct INTEGER NOT NULL,
    corrected_department TEXT NOT NULL,
    corrected_role TEXT NOT NULL,
    feedback_reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_calibrations_history_key_hash ON calibrations(history_key_hash);
  CREATE INDEX IF NOT EXISTS idx_calibrations_candidate_key ON calibrations(candidate_key);
  CREATE INDEX IF NOT EXISTS idx_calibrations_created_at ON calibrations(created_at);

  CREATE TABLE IF NOT EXISTS synced_roles (
    job_id TEXT PRIMARY KEY,
    department TEXT NOT NULL,
    title TEXT NOT NULL,
    location TEXT NOT NULL,
    url TEXT NOT NULL,
    region TEXT NOT NULL,
    seniority TEXT NOT NULL,
    required_yoe INTEGER,
    required_skills TEXT NOT NULL,
    preferred_skills TEXT NOT NULL,
    body TEXT NOT NULL,
    search_text TEXT NOT NULL,
    source TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_synced_roles_active ON synced_roles(is_active);
  CREATE INDEX IF NOT EXISTS idx_synced_roles_dept ON synced_roles(department);

  CREATE TABLE IF NOT EXISTS sync_runs (
    id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    finished_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    source TEXT NOT NULL,
    roles_found INTEGER NOT NULL DEFAULT 0,
    roles_new INTEGER NOT NULL DEFAULT 0,
    roles_updated INTEGER NOT NULL DEFAULT 0,
    roles_deactivated INTEGER NOT NULL DEFAULT 0,
    error_message TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sync_runs_finished_at ON sync_runs(finished_at);
`);
try {
  sqlite.exec("ALTER TABLE saved_files ADD COLUMN history_key_hash TEXT NOT NULL DEFAULT ''");
} catch {
  // Column already exists.
}
sqlite.exec("CREATE INDEX IF NOT EXISTS idx_saved_files_history_key_hash ON saved_files(history_key_hash)");

export const db = drizzle(sqlite);

export interface IStorage {
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  listSavedFiles(): Promise<SavedFileSummary[]>;
  getSavedFile(id: string): Promise<SavedFile | undefined>;
  countSavedFiles(): Promise<number>;
  createSavedFile(file: SavedFile): Promise<SavedFile>;
  listCalibrations(): Promise<CalibrationSummary[]>;
  countCalibrations(): Promise<number>;
  createCalibration(calibration: Calibration): Promise<Calibration>;
  listSyncedRoles(activeOnly?: boolean): Promise<SyncedRole[]>;
  upsertSyncedRole(role: SyncedRole): Promise<{ inserted: boolean }>;
  deactivateSyncedRolesNotIn(activeIds: string[], now: number): Promise<number>;
  recordSyncRun(run: SyncRun): Promise<SyncRun>;
  latestSyncRun(): Promise<SyncRun | undefined>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: number): Promise<User | undefined> {
    return db.select().from(users).where(eq(users.id, id)).get();
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return db.select().from(users).where(eq(users.username, username)).get();
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    return db.insert(users).values(insertUser).returning().get();
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
      .limit(50)
      .all();
  }

  async getSavedFile(id: string): Promise<SavedFile | undefined> {
    return db
      .select()
      .from(savedFiles)
      .where(eq(savedFiles.id, id))
      .get();
  }

  async createSavedFile(file: SavedFile): Promise<SavedFile> {
    return db.insert(savedFiles).values(file).returning().get();
  }

  async countSavedFiles(): Promise<number> {
    return (
      db
        .select({ value: count() })
        .from(savedFiles)
        .get()?.value || 0
    );
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
      .limit(500)
      .all();
  }

  async createCalibration(calibration: Calibration): Promise<Calibration> {
    return db.insert(calibrations).values(calibration).returning().get();
  }

  async countCalibrations(): Promise<number> {
    return (
      db
        .select({ value: count() })
        .from(calibrations)
        .get()?.value || 0
    );
  }

  async listSyncedRoles(activeOnly = false): Promise<SyncedRole[]> {
    const q = db.select().from(syncedRoles);
    return activeOnly ? q.where(eq(syncedRoles.isActive, 1)).all() : q.all();
  }

  async upsertSyncedRole(role: SyncedRole): Promise<{ inserted: boolean }> {
    const existing = db
      .select({ jobId: syncedRoles.jobId })
      .from(syncedRoles)
      .where(eq(syncedRoles.jobId, role.jobId))
      .get();
    if (existing) {
      db.update(syncedRoles)
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
        .where(eq(syncedRoles.jobId, role.jobId))
        .run();
      return { inserted: false };
    }
    db.insert(syncedRoles).values(role).run();
    return { inserted: true };
  }

  async deactivateSyncedRolesNotIn(
    activeIds: string[],
    now: number,
  ): Promise<number> {
    const all = db
      .select({ jobId: syncedRoles.jobId, isActive: syncedRoles.isActive })
      .from(syncedRoles)
      .all();
    const activeSet = new Set(activeIds);
    let deactivated = 0;
    for (const row of all) {
      if (!activeSet.has(row.jobId) && row.isActive === 1) {
        db.update(syncedRoles)
          .set({ isActive: 0, lastSeenAt: row.isActive === 1 ? now : now })
          .where(eq(syncedRoles.jobId, row.jobId))
          .run();
        deactivated++;
      }
    }
    return deactivated;
  }

  async recordSyncRun(run: SyncRun): Promise<SyncRun> {
    return db.insert(syncRuns).values(run).returning().get();
  }

  async latestSyncRun(): Promise<SyncRun | undefined> {
    return db
      .select()
      .from(syncRuns)
      .orderBy(desc(syncRuns.finishedAt))
      .limit(1)
      .get();
  }
}

export const storage = new DatabaseStorage();
