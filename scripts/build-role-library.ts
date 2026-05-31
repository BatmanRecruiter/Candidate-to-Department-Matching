/**
 * Build role library from phData JD .txt files.
 * Reads /home/user/workspace/phdata_inputs/*.txt, parses structured header
 * fields, infers seniority/region/skills, and writes the result as a JSON
 * blob that the server bundles at startup.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const INPUT_DIR = "/home/user/workspace/phdata_inputs";
const OUTPUT = "/home/user/workspace/phdata-matcher/shared/role-library.json";

interface Job {
  file: string;
  department: string;
  title: string;
  location: string;
  job_id: string;
  url: string;
  published?: string;
  updated?: string;
  region: string;
  seniority: string;
  required_yoe: number | null;
  preferred_skills: string[];
  required_skills: string[];
  body: string;
  search_text: string;
}

const HEADER_FIELDS = [
  "Department",
  "Job Title",
  "Location",
  "Job ID",
  "Published",
  "Updated",
  "URL",
];

function parseHeader(text: string): {
  fields: Record<string, string>;
  rest: string;
} {
  const lines = text.split(/\r?\n/);
  const fields: Record<string, string> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^([A-Za-z ]+):\s*(.*)$/);
    if (!m) break;
    const key = m[1].trim();
    if (!HEADER_FIELDS.includes(key)) break;
    fields[key] = m[2].trim();
    i++;
    if (Object.keys(fields).length >= HEADER_FIELDS.length) break;
  }
  return { fields, rest: lines.slice(i).join("\n") };
}

function inferRegion(location: string): string {
  const l = location.toLowerCase();
  if (l.includes("india")) return "India";
  if (
    l.includes("brazil") ||
    l.includes("uruguay") ||
    l.includes("argentina") ||
    l.includes("latam") ||
    l.includes("latin america")
  )
    return "LATAM";
  if (l.includes("us") || l.includes("united states") || l.includes("u.s.")) return "US";
  if (l.includes("remote")) return "Remote";
  return "Unknown";
}

const SENIORITY_PATTERNS: [RegExp, string][] = [
  [/\b(senior director|sr\.? director)\b/i, "Senior Director"],
  [/\bdirector\b/i, "Director"],
  [/\b(vp|vice president)\b/i, "VP"],
  [/\bprincipal\b/i, "Principal"],
  [/\b(staff)\b/i, "Staff"],
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
  // Look for "X+ years", "X-Y years", "at least X years"
  const patterns = [
    /\b(\d{1,2})\+?\s*(?:to|-|–)\s*(\d{1,2})\s*\+?\s*years/gi,
    /\b(?:at least|minimum of|min\.?)\s*(\d{1,2})\s*\+?\s*years/gi,
    /\b(\d{1,2})\s*\+?\s*years\s+of/gi,
    /\b(\d{1,2})\s*\+?\s*yrs/gi,
  ];
  const candidates: number[] = [];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const a = Number(m[1]);
      const b = m[2] ? Number(m[2]) : a;
      const v = Math.min(a, b);
      if (v >= 1 && v <= 25) candidates.push(v);
    }
  }
  if (!candidates.length) return null;
  // pick the median to avoid extremes
  candidates.sort((x, y) => x - y);
  return candidates[Math.floor(candidates.length / 2)];
}

// Curated skill vocab. Anything found in the JD body becomes a candidate skill.
const SKILL_VOCAB = [
  // Cloud data platforms
  "Snowflake", "AWS", "Azure", "GCP", "Google Cloud", "Databricks",
  "Fivetran", "dbt", "Airflow", "Prefect", "Dagster",
  // Languages
  "Python", "Java", "Scala", "Go", "SQL", "TypeScript", "JavaScript", "R",
  // Big data
  "Spark", "PySpark", "Kafka", "Flink", "Hadoop",
  // BI
  "Power BI", "Tableau", "Looker", "Sigma", "ThoughtSpot", "Qlik",
  // AI/ML
  "LLM", "LLMs", "GenAI", "Generative AI", "Machine Learning", "Deep Learning",
  "PyTorch", "TensorFlow", "Hugging Face", "RAG", "MLOps", "MLflow",
  "Copilot", "Glean", "Snowflake Intelligence", "Cortex",
  // Data engineering
  "ETL", "ELT", "Data Warehouse", "Data Lake", "Lakehouse", "Iceberg", "Delta Lake",
  "Streaming", "Real-time", "Pipeline",
  // Architecture / governance
  "Solutions Architect", "Architecture", "Data Governance", "MDM", "Master Data",
  "Data Quality", "Data Catalog", "Collibra", "Alation",
  // Consulting / advisory
  "Change Management", "Adoption", "Executive Advisory", "Strategy",
  "Stakeholder", "Roadmap", "Program Management", "Project Management",
  "Product Management",
  // Sales
  "Account Lead", "Enterprise Sales", "Financial Services", "Pipeline Generation",
  // Platform / internal
  "Internal Platform", "Platform Engineering", "AI Automation", "Automation",
  // Managed services
  "Managed Services", "Support", "Incident", "SLA", "DataOps",
  // Domains
  "Healthcare", "Retail", "Manufacturing", "Public Sector",
  // Semantic / analytics
  "Semantic Model", "Semantic Layer", "DAX", "Power Query", "M Language",
];

function extractSkills(text: string): string[] {
  const found = new Set<string>();
  const lower = text.toLowerCase();
  for (const skill of SKILL_VOCAB) {
    const needle = skill.toLowerCase();
    // word boundary check
    const re = new RegExp(`(?:^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^a-z0-9]|$)`, "i");
    if (re.test(lower)) found.add(skill);
  }
  return Array.from(found);
}

function splitReqPref(body: string): { required: string[]; preferred: string[] } {
  // Crude: split on headings like "Preferred", "Nice to have"
  const idx = body.search(/\b(preferred|nice to have|bonus|plus)\b[^a-z]*$/im);
  const requiredText = idx > 0 ? body.slice(0, idx) : body;
  const preferredText = idx > 0 ? body.slice(idx) : "";
  return {
    required: extractSkills(requiredText),
    preferred: extractSkills(preferredText),
  };
}

function processFile(file: string): Job | null {
  const full = path.join(INPUT_DIR, file);
  const text = fs.readFileSync(full, "utf-8");
  const { fields, rest } = parseHeader(text);
  if (!fields.Department || !fields["Job Title"]) return null;

  const department = fields.Department;
  const title = fields["Job Title"];
  const location = fields.Location || "";
  const region = inferRegion(location);
  const seniority = inferSeniority(title);
  const body = rest.trim();
  const years = inferYears(body);
  const { required, preferred } = splitReqPref(body);

  const search_text = [
    department,
    title,
    location,
    body,
  ].join(" ").toLowerCase().replace(/\s+/g, " ");

  return {
    file,
    department,
    title,
    location,
    job_id: fields["Job ID"] || "",
    url: fields.URL || "",
    published: fields.Published,
    updated: fields.Updated,
    region,
    seniority,
    required_yoe: years,
    required_skills: required,
    preferred_skills: preferred,
    body,
    search_text,
  };
}

function main() {
  const files = fs
    .readdirSync(INPUT_DIR)
    .filter((f) => f.endsWith(".txt") && f.startsWith("phdjd001"));
  const jobs: Job[] = [];
  for (const f of files) {
    const j = processFile(f);
    if (j) jobs.push(j);
    else console.warn("Skipping (no header):", f);
  }
  // Deduplicate near-duplicates by (department + title + location)
  const seen = new Set<string>();
  const unique: Job[] = [];
  for (const j of jobs) {
    const key = `${j.department}|${j.title}|${j.location}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(j);
  }

  // Stats
  const byDept: Record<string, number> = {};
  const byRegion: Record<string, number> = {};
  for (const j of unique) {
    byDept[j.department] = (byDept[j.department] || 0) + 1;
    byRegion[j.region] = (byRegion[j.region] || 0) + 1;
  }
  console.log("Total jobs:", unique.length, "/", jobs.length);
  console.log("By department:", byDept);
  console.log("By region:", byRegion);

  fs.writeFileSync(
    OUTPUT,
    JSON.stringify(
      { generated_at: new Date().toISOString(), jobs: unique },
      null,
      2,
    ),
  );
  console.log("Wrote", OUTPUT);
}

main();
