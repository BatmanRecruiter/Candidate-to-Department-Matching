/**
 * Sync the synced_roles SQLite table from phData's public Greenhouse board.
 *
 * phData publishes jobs via Greenhouse and links to them with
 * https://www.phdata.io/jobs?gh_jid=<id>. The Greenhouse public board API
 * exposes the same listing at:
 *   https://boards-api.greenhouse.io/v1/boards/phdata/jobs?content=true
 *
 * Old/historical roles remain in the bundled JSON role library and continue
 * to inform department fit. This sync only writes to synced_roles, which the
 * route layer combines with the bundled library, deduped by job_id.
 */
import { randomUUID } from "node:crypto";
import type { RoleLibraryJob } from "@shared/matcher";
import type { SyncedRole } from "@shared/schema";
import { storage } from "./storage";

const GREENHOUSE_BOARD_URL =
  "https://boards-api.greenhouse.io/v1/boards/phdata/jobs?content=true";

const FETCH_TIMEOUT_MS = 20_000;

interface GreenhouseJob {
  id: number;
  internal_job_id?: number;
  title: string;
  absolute_url?: string;
  location?: { name?: string };
  departments?: Array<{ name?: string }>;
  content?: string; // HTML-encoded job description
  updated_at?: string;
  metadata?: unknown;
}

interface GreenhouseResponse {
  jobs: GreenhouseJob[];
  meta?: { total?: number };
}

export interface RoleSyncResult {
  status: "success" | "error" | "partial";
  source: "manual" | "automated";
  startedAt: number;
  finishedAt: number;
  rolesFound: number;
  rolesNew: number;
  rolesUpdated: number;
  rolesDeactivated: number;
  errorMessage?: string;
  newRoles: Array<{ jobId: string; title: string; department: string }>;
  updatedRoles: Array<{ jobId: string; title: string; department: string }>;
}

/** Decode HTML entities and strip tags to produce plain text. */
function htmlToText(html: string): string {
  if (!html) return "";
  // Strip script/style first
  let s = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  // Block elements -> newline
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|ul|ol|br)[^>]*>/gi, "\n");
  s = s.replace(/<br\s*\/?\s*>/gi, "\n");
  // Drop remaining tags
  s = s.replace(/<[^>]+>/g, " ");
  // Decode common entities
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&rsquo;/gi, "'")
    .replace(/&lsquo;/gi, "'")
    .replace(/&ldquo;/gi, '"')
    .replace(/&rdquo;/gi, '"')
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/\s+/g, " ").trim();
}

function inferRegion(location: string): string {
  const l = location.toLowerCase();
  if (
    l.includes("india") ||
    l.includes("bengaluru") ||
    l.includes("bangalore") ||
    l.includes("hyderabad") ||
    l.includes("pune") ||
    l.includes("mumbai") ||
    l.includes("delhi") ||
    l.includes("chennai")
  )
    return "India";
  if (
    l.includes("brazil") ||
    l.includes("brasil") ||
    l.includes("uruguay") ||
    l.includes("argentina") ||
    l.includes("colombia") ||
    l.includes("latam") ||
    l.includes("latin america")
  )
    return "LATAM";
  if (
    l.includes("united states") ||
    l.includes("u.s.") ||
    l.includes(", us") ||
    l.includes("us-remote") ||
    /\b(us|usa)\b/.test(l)
  )
    return "US";
  if (l.includes("remote")) return "Remote";
  return "Unknown";
}

const SENIORITY_PATTERNS: [RegExp, string][] = [
  [/\b(senior director|sr\.? director)\b/i, "Senior Director"],
  [/\bdirector\b/i, "Director"],
  [/\b(vp|vice president)\b/i, "VP"],
  [/\bprincipal\b/i, "Principal"],
  [/\bstaff\b/i, "Staff"],
  [/\blead\b/i, "Lead"],
  [/\bsenior\b|\bsr\.?\b/i, "Senior"],
  [/\bmanager\b/i, "Manager"],
  [/\bconsultant\b/i, "Consultant"],
  [/\barchitect\b/i, "Architect"],
  [/\bengineer\b/i, "Engineer"],
];

function inferSeniority(title: string): string {
  for (const [re, label] of SENIORITY_PATTERNS) {
    if (re.test(title)) return label;
  }
  return "IC";
}

function inferYears(text: string): number | null {
  const patterns = [
    /\b(\d{1,2})\+?\s*(?:to|-|–)\s*(\d{1,2})\s*\+?\s*years/gi,
    /\b(?:at least|minimum of|min\.?)\s*(\d{1,2})\s*\+?\s*years/gi,
    /\b(\d{1,2})\s*\+?\s*years\s+of/gi,
    /\b(\d{1,2})\s*\+?\s*yrs/gi,
  ];
  const candidates: number[] = [];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const a = Number(m[1]);
      const b = m[2] ? Number(m[2]) : a;
      const v = Math.min(a, b);
      if (v >= 1 && v <= 25) candidates.push(v);
    }
  }
  if (!candidates.length) return null;
  candidates.sort((x, y) => x - y);
  return candidates[Math.floor(candidates.length / 2)];
}

const SKILL_VOCAB = [
  "Snowflake", "AWS", "Azure", "GCP", "Google Cloud", "Databricks",
  "Fivetran", "dbt", "Airflow", "Prefect", "Dagster",
  "Python", "Java", "Scala", "Go", "SQL", "TypeScript", "JavaScript", "R",
  "Spark", "PySpark", "Kafka", "Flink", "Hadoop",
  "Power BI", "Tableau", "Looker", "Sigma", "ThoughtSpot", "Qlik",
  "LLM", "LLMs", "GenAI", "Generative AI", "Machine Learning", "Deep Learning",
  "PyTorch", "TensorFlow", "Hugging Face", "RAG", "MLOps", "MLflow",
  "Copilot", "Glean", "Snowflake Intelligence", "Cortex",
  "ETL", "ELT", "Data Warehouse", "Data Lake", "Lakehouse", "Iceberg", "Delta Lake",
  "Streaming", "Real-time", "Pipeline",
  "Solutions Architect", "Architecture", "Data Governance", "MDM", "Master Data",
  "Data Quality", "Data Catalog", "Collibra", "Alation",
  "Change Management", "Adoption", "Executive Advisory", "Strategy",
  "Stakeholder", "Roadmap", "Program Management", "Project Management",
  "Product Management",
  "Account Lead", "Enterprise Sales", "Financial Services", "Pipeline Generation",
  "Internal Platform", "Platform Engineering", "AI Automation", "Automation",
  "Managed Services", "Support", "Incident", "SLA", "DataOps",
  "Healthcare", "Retail", "Manufacturing", "Public Sector",
  "Semantic Model", "Semantic Layer", "DAX", "Power Query", "M Language",
];

function extractSkills(text: string): string[] {
  const found = new Set<string>();
  const lower = text.toLowerCase();
  for (const skill of SKILL_VOCAB) {
    const needle = skill.toLowerCase();
    const re = new RegExp(
      `(?:^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^a-z0-9]|$)`,
      "i",
    );
    if (re.test(lower)) found.add(skill);
  }
  return Array.from(found);
}

function splitReqPref(body: string): { required: string[]; preferred: string[] } {
  const idx = body.search(/\b(preferred|nice to have|bonus|plus)\b[^a-z]*$/im);
  const requiredText = idx > 0 ? body.slice(0, idx) : body;
  const preferredText = idx > 0 ? body.slice(idx) : "";
  return {
    required: extractSkills(requiredText),
    preferred: extractSkills(preferredText),
  };
}

/** Map a Greenhouse job to our SyncedRole row. */
function normalizeJob(j: GreenhouseJob, now: number): SyncedRole | null {
  if (!j.id || !j.title) return null;
  const department = (j.departments?.[0]?.name || "").trim();
  if (!department) return null;
  const title = j.title.trim();
  const location = (j.location?.name || "").trim();
  const region = inferRegion(location);
  const seniority = inferSeniority(title);
  const body = htmlToText(j.content || "");
  const requiredYoe = inferYears(body);
  const { required, preferred } = splitReqPref(body);
  const url =
    j.absolute_url ||
    `https://www.phdata.io/jobs?gh_jid=${j.id}`;
  const searchText = [department, title, location, body]
    .join(" ")
    .toLowerCase()
    .replace(/\s+/g, " ");
  return {
    jobId: String(j.id),
    department,
    title,
    location,
    url,
    region,
    seniority,
    requiredYoe,
    requiredSkills: JSON.stringify(required),
    preferredSkills: JSON.stringify(preferred),
    body,
    searchText,
    source: "greenhouse",
    isActive: 1,
    firstSeenAt: now,
    lastSeenAt: now,
  };
}

/** Convert a stored SyncedRole row to the in-memory RoleLibraryJob shape. */
export function syncedRoleToLibraryJob(row: SyncedRole): RoleLibraryJob {
  let required: string[] = [];
  let preferred: string[] = [];
  try {
    required = JSON.parse(row.requiredSkills);
  } catch {}
  try {
    preferred = JSON.parse(row.preferredSkills);
  } catch {}
  return {
    file: `synced/${row.jobId}.json`,
    department: row.department,
    title: row.title,
    location: row.location,
    job_id: row.jobId,
    url: row.url,
    region: row.region,
    seniority: row.seniority,
    required_yoe: row.requiredYoe,
    required_skills: required,
    preferred_skills: preferred,
    search_text: row.searchText,
    body: row.body,
  };
}

async function fetchGreenhouseJobs(): Promise<GreenhouseJob[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(GREENHOUSE_BOARD_URL, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Greenhouse board returned HTTP ${res.status}`);
    }
    const json = (await res.json()) as GreenhouseResponse;
    if (!json || !Array.isArray(json.jobs)) {
      throw new Error("Greenhouse response missing jobs array");
    }
    return json.jobs;
  } finally {
    clearTimeout(timer);
  }
}

export async function runRoleSync(
  source: "manual" | "automated",
): Promise<RoleSyncResult> {
  const startedAt = Date.now();
  const newRoles: RoleSyncResult["newRoles"] = [];
  const updatedRoles: RoleSyncResult["updatedRoles"] = [];
  let rolesFound = 0;
  let rolesNew = 0;
  let rolesUpdated = 0;
  let rolesDeactivated = 0;
  let status: "success" | "error" | "partial" = "success";
  let errorMessage: string | undefined;

  try {
    const ghJobs = await fetchGreenhouseJobs();
    rolesFound = ghJobs.length;
    const seenIds: string[] = [];
    for (const j of ghJobs) {
      const normalized = normalizeJob(j, startedAt);
      if (!normalized) {
        status = "partial";
        continue;
      }
      seenIds.push(normalized.jobId);
      const { inserted } = await storage.upsertSyncedRole(normalized);
      if (inserted) {
        rolesNew++;
        newRoles.push({
          jobId: normalized.jobId,
          title: normalized.title,
          department: normalized.department,
        });
      } else {
        rolesUpdated++;
        updatedRoles.push({
          jobId: normalized.jobId,
          title: normalized.title,
          department: normalized.department,
        });
      }
    }
    rolesDeactivated = await storage.deactivateSyncedRolesNotIn(
      seenIds,
      startedAt,
    );
  } catch (err) {
    status = "error";
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  const finishedAt = Date.now();
  await storage.recordSyncRun({
    id: randomUUID(),
    startedAt,
    finishedAt,
    status,
    source,
    rolesFound,
    rolesNew,
    rolesUpdated,
    rolesDeactivated,
    errorMessage: errorMessage ?? null,
  });

  return {
    status,
    source,
    startedAt,
    finishedAt,
    rolesFound,
    rolesNew,
    rolesUpdated,
    rolesDeactivated,
    errorMessage,
    newRoles,
    updatedRoles,
  };
}
