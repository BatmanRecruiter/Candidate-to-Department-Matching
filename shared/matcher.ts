/**
 * Deterministic candidate-to-role matcher for the phData role library.
 *
 * Given a candidate row (arbitrary CSV columns) and the role library, score
 * each role against the candidate using:
 *  - region/location alignment
 *  - department keyword affinity
 *  - title/seniority alignment
 *  - technical skill keyword overlap
 *  - years of experience signal
 *
 * Returns the best department fit plus a department-level reasoning score
 * (1|2|3|N/A|?).
 */

export interface RoleLibraryJob {
  file: string;
  department: string;
  title: string;
  location: string;
  job_id: string;
  url: string;
  region: string;
  seniority: string;
  required_yoe: number | null;
  required_skills: string[];
  preferred_skills: string[];
  search_text: string;
  body: string;
  /** true = currently posted on the live feed; false = historical (no longer posted); undefined = bundled/internal with no status. */
  is_active?: boolean;
  /** 1-2 sentence responsibilities + qualifications summary, generated once and stored. */
  summary?: string;
}

export interface MatchResult {
  best_job: RoleLibraryJob | null;
  best_score: number;
  department: string; // valid: a JD department, "Needs human review", "Unsure / Not Enough Information", "Not a Match for phData"
  role: string; // deprecated: kept for stored calibration compatibility; no longer exported or displayed
  rationale: string;
  confidence: 1 | 2 | 3 | "N/A" | "?";
  // For UI:
  best_dept_score: number;
  candidate_yoe: number | null;
  candidate_region: string;
}

export const UNSURE = "Unsure / Not Enough Information";
export const NOT_A_MATCH = "Not a Match for phData";
export const HUMAN_REVIEW = "Needs human review";

/* ------- Department keyword groups (used both for inference and scoring) ------ */

interface DeptKeywords {
  name: string;
  // Single-token hits worth small points; multi-token phrases worth more.
  strong: string[]; // strong keyword/phrases for this department
  medium: string[];
  weak: string[];
}

const DEPT_KEYWORDS: DeptKeywords[] = [
  {
    name: "Data Engineering",
    strong: [
      "snowflake",
      "dbt",
      "data engineer",
      "data engineering",
      "etl",
      "elt",
      "data pipeline",
      "data warehouse",
      "lakehouse",
      "databricks",
      "spark",
      "pyspark",
      "airflow",
      "fivetran",
      "solutions architect",
    ],
    medium: [
      "sql",
      "python",
      "aws",
      "azure",
      "gcp",
      "kafka",
      "streaming",
      "data lake",
      "iceberg",
      "delta lake",
      "redshift",
      "bigquery",
      "scala",
    ],
    weak: ["cloud", "infrastructure", "warehouse", "ingestion"],
  },
  {
    name: "Analytics",
    strong: [
      "power bi",
      "tableau",
      "looker",
      "sigma",
      "thoughtspot",
      "semantic model",
      "semantic layer",
      "analytics consultant",
      "bi developer",
      "copilot",
      "glean",
      "snowflake intelligence",
      "dax",
      "power query",
    ],
    medium: [
      "analytics",
      "dashboard",
      "reporting",
      "business intelligence",
      "kpi",
      "metric",
      "self service",
      "self-service",
      "data visualization",
    ],
    weak: ["analyst", "insights", "report"],
  },
  {
    name: "Machine Learning",
    strong: [
      "machine learning",
      "ml engineer",
      "ml engineering",
      "mlops",
      "llm",
      "llms",
      "generative ai",
      "genai",
      "rag",
      "pytorch",
      "tensorflow",
      "hugging face",
      "ai product engineer",
      "forward deployed",
      "ai application",
      "ai apps",
    ],
    medium: [
      "deep learning",
      "neural",
      "mlflow",
      "model deployment",
      "model serving",
      "feature store",
      "fine tune",
      "fine-tuning",
      "embeddings",
      "vector database",
      "ai engineer",
    ],
    weak: ["ai", "model", "training"],
  },
  {
    name: "Advisory",
    strong: [
      "change management",
      "ai adoption",
      "executive advisory",
      "data governance",
      "mdm",
      "master data",
      "data strategy",
      "intelligence platform strategy",
      "advisory",
      "delivery leader",
    ],
    medium: [
      "strategy",
      "transformation",
      "stakeholder",
      "roadmap",
      "operating model",
      "governance",
      "data quality",
      "data catalog",
      "alation",
      "collibra",
    ],
    weak: ["consultant", "advisor"],
  },
  {
    name: "Business Architecture",
    strong: [
      "business architect",
      "business architecture",
      "business arch",
      "data product lifecycle",
      "lead discovery sessions",
      "stakeholder interviews",
      "use case prioritization",
      "use case selection",
      "roadmap development",
      "backlog building",
      "create backlogs",
      "value mapping",
      "roi analysis",
      "business roi",
      "information architecture",
    ],
    medium: [
      "requirements gathering",
      "business requirements",
      "technical requirements",
      "process design",
      "workflow documentation",
      "gap analysis",
      "current state",
      "future state",
      "business value",
      "enterprise vision",
      "cross-domain use cases",
      "organizational readiness",
      "org readiness",
      "data domains",
      "kpi",
      "okr",
      "conceptual data model",
    ],
    weak: ["discovery", "backlog", "roadmap", "use cases", "facilitate", "documentation", "prioritization"],
  },
  {
    name: "Managed Services",
    strong: [
      "managed services",
      "support engineer",
      "production support",
      "incident response",
      "dataops",
      "data ops",
      "sla",
      "on-call",
      "on call",
      "operations",
    ],
    medium: ["maintenance", "monitoring", "observability", "runbook"],
    weak: ["support", "ops"],
  },
  {
    name: "Platform",
    strong: [
      "internal platform",
      "platform engineering",
      "ai automation",
      "internal tooling",
      "developer platform",
      "internal automation",
    ],
    medium: ["automation", "workflow automation", "internal tools"],
    weak: ["platform"],
  },
  {
    name: "Program Management Office (PMO)",
    strong: [
      "program manager",
      "program management",
      "project manager",
      "project management",
      "product manager",
      "product management",
      "delivery manager",
      "scrum master",
      "pmo",
    ],
    medium: ["agile", "sprint", "stakeholder management", "ceremonies"],
    weak: ["delivery", "coordination"],
  },
  {
    name: "Sales",
    strong: [
      "account executive",
      "account lead",
      "client account",
      "enterprise sales",
      "business development",
      "sales executive",
      "quota",
      "pipeline generation",
      "client partner",
    ],
    medium: ["financial services", "selling", "sales", "revenue"],
    weak: ["client", "partner"],
  },
];

const DEPT_INDEX = new Map(DEPT_KEYWORDS.map((d) => [d.name, d]));

const BUSINESS_ARCHITECTURE_ROLE: RoleLibraryJob = {
  file: "phData internal Business Architect role overview",
  department: "Business Architecture",
  title: "Business Architect",
  location: "Global / Remote",
  job_id: "internal-business-architect",
  url: "",
  region: "Remote",
  seniority: "Architect",
  required_yoe: 7,
  required_skills: [
    "Business Architect",
    "Business Architecture",
    "Requirements Gathering",
    "Use Case Prioritization",
    "Roadmap Development",
    "Backlog Building",
    "ROI Analysis",
    "Information Architecture",
    "Data Governance",
    "Strategy",
    "Stakeholder",
    "Change Management",
  ],
  preferred_skills: ["Snowflake", "Analytics", "AI", "Data Platform"],
  search_text:
    "business architect business architecture data product lifecycle discovery sessions stakeholder interviews requirements gathering use case prioritization roadmap development backlog building process design gap analysis current state future state value mapping roi analysis business value enterprise vision data governance information architecture analytics ai machine learning data engineering",
  body:
    "Business Architects ensure technical investment provides business value. They lead discovery, gather requirements, create future project roadmaps, build backlogs, tie technical requirements to business ROI, document process, identify use cases, and bridge business stakeholders with technical teams across data engineering, analytics, AI/ML, and data governance.",
};

export function augmentRoleLibrary(library: RoleLibraryJob[]): RoleLibraryJob[] {
  const hasBusinessArchitecture = library.some(
    (job) =>
      job.department === BUSINESS_ARCHITECTURE_ROLE.department ||
      job.job_id === BUSINESS_ARCHITECTURE_ROLE.job_id,
  );
  return hasBusinessArchitecture ? library : [...library, BUSINESS_ARCHITECTURE_ROLE];
}

/* ----------------- Region inference ----------------- */

const REGIONS: { name: string; markers: string[] }[] = [
  {
    name: "India",
    markers: ["india", "bengaluru", "bangalore", "hyderabad", "pune", "mumbai", "delhi", "chennai"],
  },
  {
    name: "LATAM",
    markers: [
      "latam",
      "latin america",
      "brazil",
      "brasil",
      "uruguay",
      "argentina",
      "colombia",
      "chile",
      "mexico",
      "peru",
      "costa rica",
      "buenos aires",
      "são paulo",
      "sao paulo",
      "montevideo",
    ],
  },
  {
    name: "US",
    markers: [
      "united states",
      "u.s.",
      "usa",
      "us-remote",
      "new york",
      "san francisco",
      "chicago",
      "minneapolis",
      "boston",
      "seattle",
      "austin",
      "denver",
      "atlanta",
      "remote, us",
    ],
  },
];

function inferCandidateRegion(blob: string): string {
  const l = blob.toLowerCase();
  for (const r of REGIONS) {
    for (const m of r.markers) {
      if (l.includes(m)) return r.name;
    }
  }
  // US state codes
  const stateRe = /\b(al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy)\b/i;
  if (stateRe.test(blob)) return "US";
  return "Unknown";
}

/* ----------------- YOE extraction ----------------- */

function extractCandidateYoe(row: Record<string, string>): number | null {
  // Prefer explicit Total YOE column first
  const priorityKeys = [
    "total yoe",
    "yoe",
    "years of experience",
    "years experience",
    "experience years",
    "total years",
    "tenure years",
    "years",
  ];
  const normMap = new Map<string, string>();
  for (const [k, v] of Object.entries(row)) {
    normMap.set(k.trim().toLowerCase(), v);
  }
  for (const k of priorityKeys) {
    const v = normMap.get(k);
    if (v !== undefined && v !== "") {
      const n = Number(String(v).replace(/[^\d.]/g, ""));
      if (Number.isFinite(n) && n >= 0 && n <= 60) return n;
    }
  }
  // Otherwise look across all fields for "X years"
  for (const v of Object.values(row)) {
    if (!v) continue;
    const m = String(v).match(/(\d{1,2}(?:\.\d)?)\s*\+?\s*(?:years|yrs)/i);
    if (m) {
      const n = Number(m[1]);
      if (n >= 0 && n <= 60) return n;
    }
  }
  return null;
}

/* ----------------- Skills extraction from candidate ----------------- */

const SKILL_VOCAB = [
  "Snowflake", "dbt", "AWS", "Azure", "GCP", "Google Cloud", "Databricks",
  "Fivetran", "Airflow", "Prefect", "Dagster",
  "Python", "Java", "Scala", "Go", "SQL", "TypeScript", "JavaScript", "R",
  "Spark", "PySpark", "Kafka", "Flink", "Hadoop",
  "Power BI", "Tableau", "Looker", "Sigma", "ThoughtSpot",
  "LLM", "LLMs", "GenAI", "Generative AI", "Machine Learning", "Deep Learning",
  "PyTorch", "TensorFlow", "Hugging Face", "RAG", "MLOps", "MLflow",
  "Copilot", "Glean", "Snowflake Intelligence", "Cortex",
  "ETL", "ELT", "Data Warehouse", "Data Lake", "Lakehouse", "Iceberg", "Delta Lake",
  "Solutions Architect", "Data Governance", "MDM", "Data Quality", "Data Catalog",
  "Collibra", "Alation", "Change Management", "Executive Advisory", "Strategy",
  "Business Architect", "Business Architecture", "Requirements Gathering", "Use Case Prioritization",
  "Roadmap Development", "Backlog Building", "ROI Analysis", "Information Architecture",
  "Program Management", "Project Management", "Product Management",
  "Enterprise Sales", "Account Lead", "Financial Services",
  "Platform Engineering", "AI Automation", "Managed Services",
  "Semantic Model", "Semantic Layer", "DAX", "Power Query",
];

function extractSkillsFromText(text: string): Set<string> {
  const found = new Set<string>();
  const lower = text.toLowerCase();
  for (const skill of SKILL_VOCAB) {
    const needle = skill.toLowerCase();
    const re = new RegExp(
      `(?:^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^a-z0-9]|$)`,
    );
    if (re.test(lower)) found.add(skill);
  }
  return found;
}

/* ----------------- Title / seniority alignment ----------------- */

const SENIORITY_LEVELS = [
  "IC",
  "Engineer",
  "Consultant",
  "Senior",
  "Lead",
  "Manager",
  "Architect",
  "Principal",
  "Director",
  "Senior Director",
  "VP",
];

function inferCandidateSeniority(rowText: string): string {
  const l = rowText.toLowerCase();
  if (/\b(senior director|sr\.? director)\b/.test(l)) return "Senior Director";
  if (/\bdirector\b/.test(l)) return "Director";
  if (/\b(vp|vice president)\b/.test(l)) return "VP";
  if (/\bprincipal\b/.test(l)) return "Principal";
  if (/\bstaff\b/.test(l)) return "Staff";
  if (/\b(business architect|solutions architect|solution architect|data architect|enterprise architect)\b/.test(l)) return "Architect";
  if (/\b(account executive|account lead|client partner|sales executive|enterprise sales)\b/.test(l)) return "Lead";
  if (/\blead\b/.test(l)) return "Lead";
  if (/\bsenior\b|\bsr\.?\b/.test(l)) return "Senior";
  if (/\bmanager\b/.test(l)) return "Manager";
  if (/\bconsultant\b/.test(l)) return "Consultant";
  if (/\barchitect\b/.test(l)) return "Architect";
  if (/\bengineer\b/.test(l)) return "Engineer";
  return "IC";
}

function seniorityRank(s: string): number {
  const idx = SENIORITY_LEVELS.indexOf(s);
  return idx < 0 ? 0 : idx;
}

function inferredMinYoe(job: RoleLibraryJob): number {
  if (job.required_yoe != null) return job.required_yoe;
  const title = job.title.toLowerCase();
  if (title.includes("senior director")) return 12;
  if (title.includes("director")) return 10;
  if (title.includes("principal")) return 8;
  if (title.includes("business architect")) return 7;
  if (title.includes("solution") && title.includes("architect")) return 7;
  if (title.includes("lead")) return 6;
  if (title.includes("senior")) return 5;
  if (title.includes("manager")) return 6;
  if (title.includes("consultant")) return 4;
  if (title.includes("engineer")) return 3;
  return 4;
}

function isDirectorLevel(job: RoleLibraryJob): boolean {
  return /\bdirector\b/i.test(job.title);
}

function roleFamily(job: RoleLibraryJob): string {
  const t = job.title.toLowerCase();
  if (t.includes("power bi")) return "power_bi";
  if (t.includes("copilot")) return "copilot";
  if (t.includes("glean")) return "glean";
  if (t.includes("snowflake intelligence")) return "snowflake_intelligence";
  if (t.includes("data governance") || t.includes("mdm")) return "governance";
  if (t.includes("change management") || t.includes("ai adoption")) return "adoption";
  if (t.includes("business architect") || job.department === "Business Architecture") return "business_architecture";
  if (t.includes("solutions architect") || t.includes("solution architect")) return "solutions_architect";
  if (t.includes("program manager")) return "program_manager";
  if (t.includes("product manager")) return "product_manager";
  if (t.includes("account lead") || t.includes("account")) return "sales";
  if (t.includes("automation")) return "platform_automation";
  if (job.department === "Data Engineering") return "data_engineering";
  if (job.department === "Machine Learning") return "machine_learning";
  if (job.department === "Managed Services") return "managed_services";
  return job.department.toLowerCase();
}

type RequirementGroup = { label: string; terms: string[] };

const GROUPS: Record<string, string[]> = {
  sql: ["sql"],
  python: ["python", "pyspark"],
  data_platform: ["snowflake", "databricks", "bigquery", "redshift", "data warehouse", "lakehouse"],
  pipeline: ["etl", "elt", "pipeline", "data pipeline", "airflow", "dbt", "fivetran", "spark", "pyspark"],
  cloud: ["aws", "azure", "gcp", "google cloud"],
  architecture: ["solutions architect", "solution architect", "architecture", "architect"],
  consulting: ["consulting", "consultant", "stakeholder", "client", "advisory"],
  power_bi: ["power bi", "dax", "power query", "semantic model", "semantic layer"],
  bi: ["business intelligence", "bi", "dashboard", "reporting", "analytics", "data visualization"],
  copilot: ["copilot", "microsoft 365", "m365"],
  glean: ["glean", "enterprise search"],
  snowflake_intelligence: ["snowflake intelligence", "cortex"],
  genai: ["llm", "llms", "genai", "generative ai", "rag", "ai adoption", "ai application"],
  ml: ["machine learning", "ml engineer", "ml engineering", "mlops", "pytorch", "tensorflow", "hugging face", "model deployment"],
  governance: ["data governance", "mdm", "master data", "data quality", "data catalog", "collibra", "alation"],
  change: ["change management", "ai adoption", "adoption", "transformation"],
  strategy: ["strategy", "executive advisory", "roadmap", "operating model", "stakeholder"],
  business_architecture_discovery: [
    "business architect",
    "business architecture",
    "lead discovery",
    "discovery sessions",
    "requirements gathering",
    "stakeholder interviews",
    "business requirements",
  ],
  business_architecture_roadmap: [
    "roadmap development",
    "roadmap",
    "backlog building",
    "create backlogs",
    "backlog",
    "use case prioritization",
    "use case selection",
    "use cases",
  ],
  business_architecture_value: [
    "roi",
    "roi analysis",
    "business roi",
    "business value",
    "value mapping",
    "process design",
    "gap analysis",
    "current state",
    "future state",
    "technical requirements",
  ],
  managed: [
    "managed services",
    "production support",
    "incident",
    "sla",
    "support",
    "dataops",
    "operations",
    "devops",
    "dev ops",
    "sre",
    "site reliability",
    "cloud infrastructure",
    "infrastructure",
    "kubernetes",
    "terraform",
    "observability",
    "platform reliability",
  ],
  platform: ["platform engineering", "internal platform", "internal tooling", "internal automation"],
  automation: ["automation", "ai automation", "workflow automation"],
  program: ["program management", "program manager", "project management", "project manager", "pmo", "delivery manager"],
  product: ["product management", "product manager", "roadmap", "product strategy"],
  sales: ["enterprise sales", "account executive", "account lead", "client account", "business development", "quota", "pipeline generation"],
  financial_services: ["financial services", "banking", "capital markets", "insurance", "finserv"],
};

function requiredGroupsForJob(job: RoleLibraryJob): RequirementGroup[] {
  const fam = roleFamily(job);
  const dept = job.department;
  if (fam === "power_bi") return [
    { label: "Power BI / DAX", terms: GROUPS.power_bi },
    { label: "BI / analytics delivery", terms: GROUPS.bi },
    { label: "SQL or data platform", terms: [...GROUPS.sql, ...GROUPS.data_platform] },
  ];
  if (fam === "copilot") return [
    { label: "Copilot", terms: GROUPS.copilot },
    { label: "GenAI / AI adoption", terms: GROUPS.genai },
    { label: "consulting or change adoption", terms: [...GROUPS.consulting, ...GROUPS.change] },
  ];
  if (fam === "glean") return [
    { label: "Glean", terms: GROUPS.glean },
    { label: "GenAI / enterprise AI", terms: GROUPS.genai },
    { label: "analytics or consulting", terms: [...GROUPS.bi, ...GROUPS.consulting] },
  ];
  if (fam === "snowflake_intelligence") return [
    { label: "Snowflake Intelligence / Cortex", terms: GROUPS.snowflake_intelligence },
    { label: "Snowflake or data platform", terms: GROUPS.data_platform },
    { label: "GenAI", terms: GROUPS.genai },
  ];
  if (fam === "governance") return [
    { label: "data governance / MDM", terms: GROUPS.governance },
    { label: "data quality/catalog tooling", terms: ["data quality", "data catalog", "collibra", "alation"] },
    { label: "consulting/stakeholder delivery", terms: GROUPS.consulting },
  ];
  if (fam === "adoption") return [
    { label: "change management / AI adoption", terms: GROUPS.change },
    { label: "strategy / executive advisory", terms: GROUPS.strategy },
    { label: "consulting/stakeholder delivery", terms: GROUPS.consulting },
  ];
  if (fam === "business_architecture") return [
    { label: "business discovery / requirements", terms: GROUPS.business_architecture_discovery },
    { label: "roadmap / backlog / use-case prioritization", terms: GROUPS.business_architecture_roadmap },
    { label: "data/AI domain context", terms: [
      "data product lifecycle",
      "data platform",
      "data strategy",
      "analytics",
      "artificial intelligence",
      "machine learning",
      "data governance",
      "data engineering",
      "information architecture",
      "snowflake",
      "business intelligence",
    ] },
    { label: "business value / ROI / process design", terms: GROUPS.business_architecture_value },
  ];
  if (fam === "solutions_architect") return [
    { label: "solutions architecture", terms: GROUPS.architecture },
    { label: "modern data platform", terms: GROUPS.data_platform },
    { label: "SQL/Python/data engineering", terms: [...GROUPS.sql, ...GROUPS.python, ...GROUPS.pipeline] },
  ];
  if (fam === "machine_learning" || dept === "Machine Learning") return [
    { label: "machine learning / LLM", terms: [...GROUPS.ml, ...GROUPS.genai] },
    { label: "Python", terms: GROUPS.python },
    { label: "MLOps or production AI", terms: ["mlops", "mlflow", "model deployment", "model serving", "ai application", "rag"] },
  ];
  if (fam === "data_engineering" || dept === "Data Engineering") return [
    { label: "SQL/Python", terms: [...GROUPS.sql, ...GROUPS.python] },
    { label: "data platform", terms: GROUPS.data_platform },
    { label: "data pipelines / ELT", terms: GROUPS.pipeline },
  ];
  if (fam === "managed_services" || dept === "Managed Services") return [
    { label: "managed services / production support", terms: GROUPS.managed },
    { label: "data platform", terms: GROUPS.data_platform },
    { label: "architecture or engineering", terms: [...GROUPS.architecture, ...GROUPS.pipeline, ...GROUPS.sql] },
  ];
  if (fam === "platform_automation" || dept === "Platform") return [
    { label: "platform/internal tooling", terms: GROUPS.platform },
    { label: "AI/workflow automation", terms: GROUPS.automation },
    { label: "engineering", terms: [...GROUPS.python, "typescript", "javascript", "api", "integration"] },
  ];
  if (fam === "program_manager") return [
    { label: "program/project management", terms: GROUPS.program },
    { label: "data/AI delivery", terms: ["data and ai", "data & ai", "ai delivery", "data program", "analytics program"] },
    { label: "stakeholder delivery", terms: ["stakeholder", "agile", "delivery"] },
  ];
  if (fam === "product_manager") return [
    { label: "product management", terms: GROUPS.product },
    { label: "data/AI product", terms: ["data product", "ai product", "data and ai", "data & ai"] },
    { label: "stakeholder/roadmap", terms: ["stakeholder", "roadmap", "strategy"] },
  ];
  if (fam === "sales") return [
    { label: "enterprise sales/account ownership", terms: GROUPS.sales },
    { label: "financial services", terms: GROUPS.financial_services },
  ];
  return [{ label: dept, terms: (DEPT_INDEX.get(dept)?.strong || []).concat(DEPT_INDEX.get(dept)?.medium || []) }];
}

function groupMatched(group: RequirementGroup, blob: string, skills: Set<string>): boolean {
  const l = blob.toLowerCase();
  return group.terms.some((term) => {
    const needle = term.toLowerCase();
    if (skills.has(term) || skills.has(term.replace(/\b\w/g, (c) => c.toUpperCase()))) return true;
    return l.includes(needle);
  });
}

function seniorityOk(job: RoleLibraryJob, candidateSeniority: string): boolean {
  const c = seniorityRank(candidateSeniority);
  const j = seniorityRank(job.seniority);
  const salesEquivalent =
    job.department === "Sales" &&
    candidateSeniority === "IC" &&
    /\b(account executive|account lead|client partner|sales executive|enterprise sales)\b/i.test(job.title + " ");
  if (isDirectorLevel(job)) return c >= seniorityRank("Director");
  if (salesEquivalent) return true;
  if (c > j + 2) return false;
  if (job.seniority === "Principal") return c >= seniorityRank("Lead");
  if (job.seniority === "Lead" || job.seniority === "Manager") return c >= seniorityRank("Senior");
  if (job.seniority === "Senior") return c >= seniorityRank("Senior");
  return c >= Math.max(0, j - 1);
}

/* ----------------- Candidate text blob ----------------- */

const HIGH_SIGNAL_RE =
  /(title|role|position|company|employer|location|city|country|school|degree|major|education|summary|headline|skills|experience|about|profile|industry|certification)/i;

export function buildCandidateBlob(row: Record<string, string>): {
  blob: string;
  highBlob: string;
  recentBlob: string;
  olderBlob: string;
  highRecentBlob: string;
  weightedBlob: string;
  weightedHighBlob: string;
  titleish: string;
} {
  const all: string[] = [];
  const high: string[] = [];
  const recent: string[] = [];
  const older: string[] = [];
  const highRecent: string[] = [];
  let titleish = "";
  for (const [k, v] of Object.entries(row)) {
    if (!v) continue;
    const key = k.trim().toLowerCase();
    const val = String(v);
    all.push(val);
    const isOlder =
      /\b(company|title|role|position|experience|job)\s*(?:[2-9]|\d{2,})\b/i.test(key) ||
      /\b(?:previous|prior|past|former|older)\b/i.test(key);
    const isRecent =
      !isOlder &&
      (/\b(?:current|recent|latest|present|headline|summary|about|skills|company\s*1|title\s*1|role\s*1|position\s*1)\b/i.test(key) ||
        HIGH_SIGNAL_RE.test(k));
    if (isOlder) older.push(val);
    else if (isRecent) recent.push(val);
    else recent.push(val);
    if (HIGH_SIGNAL_RE.test(k)) {
      high.push(val + " " + val); // weight x2
      if (!isOlder) highRecent.push(val + " " + val);
    }
    if (/title|role|position|headline/i.test(k) && !titleish && !isOlder) titleish = val;
  }
  if (!titleish) {
    for (const [k, v] of Object.entries(row)) {
      if (/title|role|position|headline/i.test(k) && v) {
        titleish = String(v);
        break;
      }
    }
  }
  const recentText = recent.join(" ");
  const olderText = older.join(" ");
  const highRecentText = highRecent.join(" ") + " " + recentText;
  return {
    blob: all.join(" "),
    highBlob: high.join(" ") + " " + all.join(" "),
    recentBlob: recentText,
    olderBlob: olderText,
    highRecentBlob: highRecentText,
    weightedBlob: `${recentText} ${recentText} ${recentText} ${recentText} ${recentText} ${recentText} ${recentText} ${recentText} ${recentText} ${olderText}`,
    weightedHighBlob: `${highRecentText} ${highRecentText} ${highRecentText} ${highRecentText} ${highRecentText} ${highRecentText} ${highRecentText} ${highRecentText} ${highRecentText} ${olderText}`,
    titleish,
  };
}

/* ----------------- Holistic career-context guardrails ----------------- */

interface CareerContext {
  relevant: boolean;
  allowedDepartments: Set<string>;
  preferredDepartment: string | null;
  positiveSignals: string[];
  negativeSignals: string[];
  incidentalToolRisk: boolean;
  likelySchoolOrSelfEmployment: boolean;
}

interface HardGuardrailDecision {
  reason: string;
  rationale: string;
}

function rowField(row: Record<string, string>, re: RegExp): string {
  return (
    Object.entries(row).find(([k, v]) => re.test(k) && String(v || "").trim())?.[1] || ""
  );
}

function normalizedContainsAny(text: string, terms: string[]): boolean {
  const l = text.toLowerCase();
  return terms.some((t) => l.includes(t));
}

function countMatches(text: string, terms: string[]): number {
  const l = text.toLowerCase();
  return terms.reduce((n, t) => n + (l.includes(t) ? 1 : 0), 0);
}

function directDepartmentFromTitle(title: string): string | null {
  if (/\b(data architect|data engineer|data engineering|etl developer|elt developer|analytics engineer|data platform engineer|data warehouse engineer|solutions architect|solution architect)\b/.test(title)) return "Data Engineering";
  if (/\b(analytics consultant|analytics analyst|data visualization|visualization analyst|bi developer|bi analyst|business intelligence|power bi developer|tableau developer|looker developer|analytics engineer)\b/.test(title)) return "Analytics";
  if (/\b(machine learning engineer|ml engineer|ai engineer|ai consultant|data scientist|applied scientist|mlops engineer|llm engineer|rag engineer|agentic ai|ai application engineer)\b/.test(title)) return "Machine Learning";
  if (/\b(advisory consultant|advisor|data strategy consultant|change management consultant)\b/.test(title)) return "Advisory";
  if (/\b(business architect|business architecture)\b/.test(title)) return "Business Architecture";
  if (/\b(managed services|production support|support engineer|dataops|data ops|devops|dev ops|site reliability|sre|cloud engineer|cloud infrastructure|infrastructure engineer|platform engineer|platform engineering|developer platform)\b/.test(title)) return "Managed Services";
  if (/\b(automation engineer|internal tools engineer)\b/.test(title)) return "Platform";
  if (/\b(program manager|project manager|delivery manager|scrum master|product manager|pmo|business analyst|business analysis|technical project manager|technical program manager)\b/.test(title)) return "Program Management Office (PMO)";
  if (/\b(account executive|account lead|client partner|enterprise sales|sales executive|business development|biz dev|bdr|sdr)\b/.test(title)) return "Sales";
  return null;
}

function evaluateHardGuardrail(
  row: Record<string, string>,
  blob: string,
  titleish: string,
  roleLibrary: RoleLibraryJob[],
): HardGuardrailDecision | null {
  const title = (titleish || rowField(row, /title|role|headline|position/i)).toLowerCase();
  const l = blob.toLowerCase();
  const directDept = directDepartmentFromTitle(title);
  const isSalesTitle = directDept === "Sales";
  const hasMarketingRoleOpen = roleLibrary.some((job) => /marketing/i.test(job.department) || /marketing/i.test(job.title));

  const maTitleOrScope =
    /\b(m&a|mergers?\s*(?:and|&)\s*acquisitions?|acquisitions?|corporate development|transaction advisory|deal advisory|investment banking|due diligence)\b/.test(title) ||
    /\b(m&a|mergers?\s*(?:and|&)\s*acquisitions?|corporate development|transaction advisory|deal advisory|investment banking|due diligence)\b/.test(l);
  if (maTitleOrScope) {
    return {
      reason: "M&A",
      rationale: "M&A-focused work is not a fit for phData in any department.",
    };
  }

  const supplyChainTitleOrScope =
    /\b(supply chain|procurement|strategic sourcing|sourcing manager|buyer|purchasing|logistics|inventory|demand planning|s&op|warehouse operations|materials management|vendor management)\b/.test(title) ||
    /\b(supply chain|procurement|strategic sourcing|purchasing|logistics|inventory management|demand planning|s&op|materials management)\b/.test(l);
  if (supplyChainTitleOrScope) {
    return {
      reason: "Supply Chain / Procurement",
      rationale: "Supply chain, procurement, sourcing, logistics, and related operations work is not a fit for phData.",
    };
  }

  const cybersecurityTitle =
    /\b(cybersecurity|cyber security|information security|infosec|security engineer|security analyst|security architect|soc analyst|iam|identity and access|penetration tester|threat analyst|vulnerability analyst)\b/.test(title);
  const cybersecurityScopeHits = countMatches(l, [
    "cybersecurity",
    "cyber security",
    "information security",
    "infosec",
    "soc",
    "siem",
    "threat detection",
    "threat hunting",
    "vulnerability management",
    "penetration testing",
    "incident response",
    "identity and access",
    "iam",
    "security operations",
    "risk and compliance",
  ]);
  if (cybersecurityTitle || cybersecurityScopeHits >= 3) {
    return {
      reason: "Cybersecurity Professional",
      rationale: "Cybersecurity Professional",
    };
  }

  const competingProductTitleOrScope =
    /\b(workday|salesforce|sap|oracle erp|oracle hcm|oracle cloud|servicenow|netsuite|dynamics 365|d365|peoplesoft|coupa|mulesoft)\b/.test(title) ||
    /\b(workday|salesforce|sap|oracle erp|oracle hcm|oracle cloud|servicenow|netsuite|dynamics 365|d365|peoplesoft|coupa|mulesoft)\b/.test(l);
  if (competingProductTitleOrScope) {
    return {
      reason: "Competing enterprise-product focus",
      rationale: "Workday, Salesforce, SAP, Oracle, ServiceNow, or similar enterprise-product-focused work is not a fit for phData.",
    };
  }

  const marketingTitleOrScope =
    /\b(marketing|growth marketer|demand generation|demand gen|seo|sem|paid search|paid media|content marketing|product marketing|campaign manager|brand manager|social media manager)\b/.test(title) ||
    countMatches(l, ["marketing campaign", "demand generation", "demand gen", "seo", "sem", "paid media", "content marketing", "product marketing", "brand marketing"]) >= 2;
  if (marketingTitleOrScope && !hasMarketingRoleOpen) {
    return {
      reason: "No marketing roles at this time",
      rationale: "No marketing roles at this time.",
    };
  }

  const financeTitleOrScope =
    !isSalesTitle &&
    (/\b(finance manager|finance director|financial analyst|finance analyst|fp&a|accountant|accounting|controller|auditor|audit manager|tax analyst|tax manager|treasury|payroll|accounts payable|accounts receivable|bookkeeper|banker|banking analyst|payments|payment operations|asset management|asset manager|portfolio manager|investment analyst|financial advisor|wealth advisor|credit analyst|loan officer|underwriter)\b/.test(title) ||
      /\b(month end close|financial statements|journal entries|general ledger|accounts payable|accounts receivable|reconciliation|fp&a|forecasting and budgeting|treasury|payment operations|banking operations|asset management|portfolio management|wealth management|financial planning)\b/.test(l));
  if (financeTitleOrScope) {
    return {
      reason: "Finance / Accounting scope",
      rationale: "Finance, accounting, payments, banking, asset-management, or related job-scope work is not a fit for phData.",
    };
  }

  return null;
}

function evaluateCareerContext(
  row: Record<string, string>,
  blob: string,
  titleish: string,
): CareerContext {
  const title = (titleish || rowField(row, /title|role|headline|position/i)).toLowerCase();
  const company = rowField(row, /company|employer|organization/i).toLowerCase();
  const school = rowField(row, /school|university|college|education/i).toLowerCase();
  const l = blob.toLowerCase();
  const allowedDepartments = new Set<string>();
  const preferredDepartment = directDepartmentFromTitle(title);
  const positiveSignals: string[] = [];
  const negativeSignals: string[] = [];

  const dataTitles = [
    "data engineer",
    "analytics engineer",
    "data analyst",
    "business intelligence",
    "bi developer",
    "bi analyst",
    "analytics consultant",
    "data consultant",
    "data architect",
    "solutions architect",
    "solution architect",
    "data scientist",
    "machine learning engineer",
    "ml engineer",
    "ai engineer",
    "cloud data",
    "snowflake consultant",
  ];
  const dataWork = [
    "built data pipeline",
    "building data pipeline",
    "designed data pipeline",
    "etl pipeline",
    "elt pipeline",
    "implemented snowflake",
    "snowflake implementation",
    "data warehouse",
    "semantic model",
    "dbt",
    "airflow",
    "production ml",
    "mlops",
    "rag",
    "enterprise reporting",
    "enterprise dashboard",
    "modern data stack",
    "analytics at enterprise clients",
    "data platform",
    "data architecture",
    "data migration",
    "cloud migration",
    "lakehouse",
    "data lake",
    "data warehouse",
    "data modeling",
  ];
  const advisoryTitles = ["advisory", "strategy consultant", "management consultant", "change management"];
  const advisoryWork = ["ai adoption", "change management", "executive advisory", "data strategy", "technology strategy", "data transformation", "digital transformation", "operating model", "data governance"];
  const businessArchitectureTitles = [
    "business architect",
    "business architecture",
    "business analysis",
    "business analyst",
    "product owner",
    "strategy consultant",
  ];
  const businessArchitectureWork = [
    "lead discovery",
    "discovery sessions",
    "requirements gathering",
    "stakeholder interviews",
    "identify and prioritize use cases",
    "use case prioritization",
    "use case selection",
    "roadmap development",
    "create backlogs",
    "backlog building",
    "value mapping",
    "roi analysis",
    "business roi",
    "technical requirements",
    "process design",
    "workflow documentation",
    "gap analysis",
    "current state",
    "future state",
    "business value",
    "enterprise vision",
    "information architecture",
    "data domains",
    "conceptual data model",
    "organizational readiness",
    "org readiness",
  ];
  const businessArchitectureContext = [
    "data product lifecycle",
    "data platform",
    "data strategy",
    "analytics",
    "business intelligence",
    "ai/ml",
    "artificial intelligence",
    "machine learning",
    "data governance",
    "data engineering",
    "snowflake",
    "tableau",
    "power bi",
    "technical implementation",
    "technology consulting",
  ];
  const pmoTitles = ["program manager", "project manager", "delivery manager", "scrum master", "product manager", "business analyst", "business analysis", "technical program manager", "technical project manager"];
  const pmoContext = ["data", "analytics", "ai", "cloud", "software", "platform", "technology", "digital transformation", "requirements", "stakeholder", "roadmap", "backlog", "agile"];
  const salesTitles = ["account executive", "account lead", "client account", "client partner", "enterprise sales", "sales executive", "business development"];
  const salesContext = ["data platform", "cloud", "saas", "software", "snowflake", "databricks", "analytics", "financial services firms", "enterprise"];
  const managedTitles = ["support engineer", "managed services", "dataops", "production support", "site reliability", "sre", "devops", "dev ops", "cloud engineer", "infrastructure engineer", "platform engineer", "platform engineering", "developer platform"];
  const platformTitles = ["automation engineer", "internal tools"];
  const nonRelevantTitles = [
    "financial advisor",
    "wealth advisor",
    "investment advisor",
    "portfolio manager",
    "teacher",
    "professor",
    "student",
    "realtor",
    "real estate",
    "insurance agent",
    "nurse",
    "physician",
    "attorney",
    "lawyer",
    "accountant",
    "bookkeeper",
    "marketing manager",
    "graphic designer",
    "ux designer",
    "recruiter",
    "talent acquisition",
    "human resources",
  ];

  const dataTitleHits = countMatches(title, dataTitles);
  const dataWorkHits = countMatches(l, dataWork);
  const analyticsPrimary =
    normalizedContainsAny(title, ["analytics", "business intelligence", "bi developer", "bi analyst", "data visualization", "power bi", "tableau", "looker"]) ||
    countMatches(l, ["data visualization", "dashboard", "business intelligence", "analytics", "power bi", "tableau", "looker", "sigma", "semantic model"]) >= 2;
  const appliedAiPrimary =
    normalizedContainsAny(title, ["machine learning", "ml engineer", "ai engineer", "data scientist", "llm engineer", "rag engineer", "agentic ai", "mlops"]) ||
    countMatches(l, ["llm", "large language model", "rag", "agentic ai", "generative ai", "genai", "machine learning", "mlops", "model deployment", "ai application"]) >= 2;
  if (preferredDepartment) {
    positiveSignals.push(`current/recent title directly aligns with ${preferredDepartment}`);
    allowedDepartments.add(preferredDepartment);
  }

  if (!preferredDepartment && (dataTitleHits > 0 || dataWorkHits >= 2)) {
    positiveSignals.push("recent title/work shows data, analytics, AI, cloud, or data-platform delivery");
    allowedDepartments.add("Data Engineering");
    allowedDepartments.add("Analytics");
    allowedDepartments.add("Machine Learning");
    allowedDepartments.add("Managed Services");
    allowedDepartments.add("Platform");
  }

  if (!preferredDepartment && analyticsPrimary) {
    positiveSignals.push("primary responsibilities appear to be analytics, business intelligence, or data visualization");
    allowedDepartments.add("Analytics");
  }

  if (!preferredDepartment && appliedAiPrimary && !normalizedContainsAny(l, ["research scientist", "academic research", "postdoctoral", "publication", "theoretical research"])) {
    positiveSignals.push("primary responsibilities appear to be applied machine learning, AI engineering, LLM, RAG, or agentic AI work");
    allowedDepartments.add("Machine Learning");
  }

  if (!preferredDepartment && (normalizedContainsAny(title, advisoryTitles) || countMatches(l, advisoryWork) >= 2)) {
    positiveSignals.push("profile shows advisory/change/data-strategy work");
    allowedDepartments.add("Advisory");
  }

  const baTitleHit = normalizedContainsAny(title, businessArchitectureTitles);
  const baWorkHits = countMatches(l, businessArchitectureWork);
  const baContextHit = normalizedContainsAny(l, businessArchitectureContext);
  const architectTitleHit = normalizedContainsAny(title, ["business architect", "business architecture"]);
  if (!preferredDepartment && ((architectTitleHit && baContextHit) || (baTitleHit && baWorkHits >= 3 && baContextHit) || (baWorkHits >= 5 && baContextHit))) {
    positiveSignals.push("profile shows senior business architecture work tied to data, AI, analytics, or technical delivery");
    allowedDepartments.add("Business Architecture");
  }

  if (!preferredDepartment && normalizedContainsAny(title, pmoTitles) && normalizedContainsAny(l, pmoContext)) {
    positiveSignals.push("program, project, product, or business-analysis responsibilities are tied to technology/data delivery");
    allowedDepartments.add("Program Management Office (PMO)");
  }

  if (!preferredDepartment && normalizedContainsAny(title, salesTitles) && normalizedContainsAny(l, salesContext)) {
    positiveSignals.push("sales role is tied to enterprise technology/data/cloud context");
    allowedDepartments.add("Sales");
  }

  if (!preferredDepartment && normalizedContainsAny(title, managedTitles) && normalizedContainsAny(l, ["data", "cloud", "platform", "pipeline", "snowflake", "analytics", "infrastructure", "kubernetes", "terraform", "aws", "azure", "gcp", "sre", "devops"])) {
    positiveSignals.push("DevOps, cloud, SRE, infrastructure, platform, or managed-services work appears relevant to phData delivery");
    allowedDepartments.add("Managed Services");
    allowedDepartments.add("Data Engineering");
  }

  if (!preferredDepartment && normalizedContainsAny(title, platformTitles) && normalizedContainsAny(l, ["data", "ai", "automation", "developer", "internal tools", "cloud"])) {
    positiveSignals.push("platform/automation role appears tied to technical internal tooling");
    allowedDepartments.add("Platform");
  }

  const nonRelevantTitle = normalizedContainsAny(title, nonRelevantTitles);
  if (nonRelevantTitle) {
    negativeSignals.push("current/recent title is outside phData's data, AI, cloud, consulting, product, or enterprise-sales lanes");
  }

  const skillMentions = countMatches(l, [
    "power bi",
    "tableau",
    "dashboard",
    "sql",
    "python",
    "snowflake",
    "analytics",
  ]);
  const doingDataWork = dataTitleHits > 0 || dataWorkHits >= 2 || normalizedContainsAny(l, [
    "designed",
    "built",
    "implemented",
    "architected",
    "deployed",
    "engineered",
    "delivered",
  ]) && normalizedContainsAny(l, ["data platform", "data pipeline", "warehouse", "snowflake", "analytics", "machine learning", "llm"]);
  const incidentalToolRisk =
    skillMentions > 0 &&
    nonRelevantTitle &&
    !doingDataWork &&
    normalizedContainsAny(l, ["clients", "client", "investment", "financial planning", "portfolio", "school", "students", "course"]);
  if (incidentalToolRisk) {
    negativeSignals.push("technical terms look incidental to another profession rather than evidence of data-platform delivery");
  }

  const likelySchoolOrSelfEmployment =
    !!company &&
    ((!!school && (company.includes(school) || school.includes(company))) ||
      normalizedContainsAny(company, ["university", "college", "school"]) ||
      normalizedContainsAny(title + " " + company, ["founder", "owner", "self-employed", "self employed"]));
  if (likelySchoolOrSelfEmployment && allowedDepartments.size === 0) {
    negativeSignals.push("company context looks school-affiliated or self-owned without enough enterprise delivery evidence");
  }

  if ((incidentalToolRisk || nonRelevantTitle || likelySchoolOrSelfEmployment) && positiveSignals.length === 0) {
    allowedDepartments.clear();
  }

  return {
    relevant: allowedDepartments.size > 0 && !incidentalToolRisk,
    allowedDepartments,
    preferredDepartment,
    positiveSignals,
    negativeSignals,
    incidentalToolRisk,
    likelySchoolOrSelfEmployment,
  };
}

function careerAllowsDepartment(career: CareerContext, department: string): boolean {
  return career.allowedDepartments.has(department);
}

/* ----------------- Department-level scoring ----------------- */

function scoreDept(candidateBlob: string, dept: DeptKeywords): {
  score: number;
  hits: string[];
} {
  const l = candidateBlob.toLowerCase();
  const hits: string[] = [];
  let score = 0;
  for (const kw of dept.strong) {
    if (l.includes(kw)) {
      score += 5;
      hits.push(kw);
    }
  }
  for (const kw of dept.medium) {
    if (l.includes(kw)) {
      score += 2;
      hits.push(kw);
    }
  }
  for (const kw of dept.weak) {
    if (l.includes(kw)) {
      score += 1;
      hits.push(kw);
    }
  }
  return { score, hits };
}

function scoreDeptWeighted(
  recentBlob: string,
  olderBlob: string,
  dept: DeptKeywords,
): {
  score: number;
  recentScore: number;
  olderScore: number;
  hits: string[];
} {
  const recent = scoreDept(recentBlob, dept);
  const older = scoreDept(olderBlob, dept);
  return {
    score: recent.score * 0.9 + older.score * 0.1,
    recentScore: recent.score,
    olderScore: older.score,
    hits: Array.from(new Set(recent.hits.concat(older.hits))),
  };
}

/* ----------------- Role-level scoring ----------------- */

interface ScoreBreakdown {
  job: RoleLibraryJob;
  total: number;
  skill_score: number;
  region_score: number;
  seniority_score: number;
  yoe_score: number;
  title_score: number;
  skill_overlap: string[];
  required_groups: RequirementGroup[];
  matched_requirements: string[];
  missing_requirements: string[];
  requirement_coverage: number;
  location_ok: boolean;
  seniority_ok: boolean;
  yoe_ok: boolean;
  min_yoe: number;
  role_eligible: boolean;
}

function scoreRole(
  job: RoleLibraryJob,
  candidate: {
    skills: Set<string>;
    region: string;
    seniority: string;
    yoe: number | null;
    titleish: string;
    blob: string;
  },
): ScoreBreakdown {
  // Skills overlap
  const jobSkills = new Set<string>([
    ...job.required_skills,
    ...job.preferred_skills,
  ]);
  const overlap: string[] = [];
  for (const s of Array.from(jobSkills)) {
    if (candidate.skills.has(s)) overlap.push(s);
  }
  const required_set = new Set(job.required_skills);
  let skill_score = 0;
  for (const s of overlap) {
    skill_score += required_set.has(s) ? 4 : 2;
  }

  const required_groups = requiredGroupsForJob(job);
  const matched_requirements = required_groups
    .filter((g) => groupMatched(g, candidate.blob, candidate.skills))
    .map((g) => g.label);
  const missing_requirements = required_groups
    .filter((g) => !groupMatched(g, candidate.blob, candidate.skills))
    .map((g) => g.label);
  const requirement_coverage =
    required_groups.length === 0
      ? 0
      : matched_requirements.length / required_groups.length;

  // Region: a specific role requires a known candidate location matching the
  // role's hiring region. Unknown location can still support department routing,
  // but not a committed role match.
  const location_ok =
    job.region === "Remote" ||
    (candidate.region !== "Unknown" && candidate.region === job.region);
  let region_score = 0;
  if (location_ok) region_score = 4;
  else if (candidate.region === "Unknown") region_score = -1;
  else region_score = -5;

  // Seniority
  const cRank = seniorityRank(candidate.seniority);
  const jRank = seniorityRank(job.seniority);
  const seniority_ok = seniorityOk(job, candidate.seniority);
  let seniority_score = 0;
  if (seniority_ok && cRank === jRank) seniority_score = 4;
  else if (seniority_ok) seniority_score = 2;
  else seniority_score = -4;

  // YOE
  const min_yoe = inferredMinYoe(job);
  const yoe_ok = candidate.yoe != null && candidate.yoe >= min_yoe;
  let yoe_score = 0;
  if (candidate.yoe != null) {
    if (yoe_ok) yoe_score = 3;
    else if (candidate.yoe >= min_yoe - 1) yoe_score = 0;
    else yoe_score = -3;
  } else {
    yoe_score = -2;
  }

  // Title text overlap: see if any major token of the job title appears in
  // candidate titleish field.
  let title_score = 0;
  const jobTokens = job.title
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 3 && !["data", "and", "the", "with"].includes(t));
  const titleLower = (candidate.titleish + " " + candidate.blob).toLowerCase();
  for (const t of jobTokens) {
    if (titleLower.includes(t)) title_score += 1;
  }

  const requirement_score = Math.round(requirement_coverage * 20);
  const total =
    requirement_score + skill_score + region_score + seniority_score + yoe_score + title_score;
  const requiredEnough =
    required_groups.length <= 2
      ? missing_requirements.length === 0
      : requirement_coverage >= 0.75;
  const role_eligible =
    location_ok &&
    seniority_ok &&
    yoe_ok &&
    requiredEnough &&
    matched_requirements.length > 0;

  return {
    job,
    total,
    skill_score,
    region_score,
    seniority_score,
    yoe_score,
    title_score,
    skill_overlap: overlap,
    required_groups,
    matched_requirements,
    missing_requirements,
    requirement_coverage,
    location_ok,
    seniority_ok,
    yoe_ok,
    min_yoe,
    role_eligible,
  };
}

/* ----------------- Public API ----------------- */

export function matchCandidate(
  row: Record<string, string>,
  library: RoleLibraryJob[],
): MatchResult {
  const roleLibrary = augmentRoleLibrary(library);
  const { blob, highBlob, highRecentBlob, olderBlob, weightedHighBlob, titleish } = buildCandidateBlob(row);
  const skills = extractSkillsFromText(highRecentBlob);
  const region = inferCandidateRegion(blob);
  const seniority = inferCandidateSeniority(highRecentBlob || highBlob);
  const yoe = extractCandidateYoe(row);
  const career = evaluateCareerContext(row, highRecentBlob || weightedHighBlob, titleish);
  const hardGuardrail = evaluateHardGuardrail(row, highBlob, titleish, roleLibrary);

  // Department scoring across taxonomy
  const deptScores: { name: string; score: number; recentScore: number; olderScore: number; hits: string[] }[] = [];
  for (const d of DEPT_KEYWORDS) {
    const r = scoreDeptWeighted(highRecentBlob || weightedHighBlob, olderBlob, d);
    deptScores.push({ name: d.name, ...r });
  }
  deptScores.sort((a, b) => b.score - a.score);
  const topDept = deptScores[0];
  const secondDept = deptScores[1];

  // Empty-row guard
  const tokenCount = blob.trim().split(/\s+/).filter(Boolean).length;
  if (tokenCount < 6) {
    return {
      best_job: null,
      best_score: 0,
      department: HUMAN_REVIEW,
      role: HUMAN_REVIEW,
      rationale: HUMAN_REVIEW,
      confidence: "?",
      best_dept_score: 0,
      candidate_yoe: yoe,
      candidate_region: region,
    };
  }

  if (hardGuardrail) {
    return {
      best_job: null,
      best_score: 0,
      department: NOT_A_MATCH,
      role: NOT_A_MATCH,
      rationale: hardGuardrail.rationale,
      confidence: "N/A",
      best_dept_score: 0,
      candidate_yoe: yoe,
      candidate_region: region,
    };
  }

  // Score all jobs
  const scored = roleLibrary.map((j) =>
    scoreRole(j, { skills, region, seniority, yoe, titleish, blob: highRecentBlob || weightedHighBlob }),
  );
  scored.sort((a, b) => b.total - a.total);
  const best = scored[0];

  // Decide department label. Specific role alignment is intentionally not
  // exported anymore; role-level requirements are used only as evidence that
  // the recent work belongs in a department.
  let department: string;
  const bestRecentRoleEvidence = scored.find(
    (s) =>
      s.role_eligible &&
      careerAllowsDepartment(career, s.job.department) &&
      (!career.preferredDepartment || s.job.department === career.preferredDepartment),
  );
  const hasDomainSignal =
    career.relevant &&
    careerAllowsDepartment(career, topDept.name) &&
    (!career.preferredDepartment || topDept.name === career.preferredDepartment) &&
    (topDept.recentScore >= 5 ||
      (best.matched_requirements.length >= 2 && best.requirement_coverage >= 0.5));
  if (bestRecentRoleEvidence) {
    department = bestRecentRoleEvidence.job.department;
  } else if (career.preferredDepartment && career.allowedDepartments.has(career.preferredDepartment)) {
    department = career.preferredDepartment;
  } else if (hasDomainSignal) {
    department = topDept.name;
  } else if (career.relevant && topDept.recentScore >= 2) {
    department = topDept.name;
  } else if (
    career.incidentalToolRisk ||
    career.negativeSignals.some((signal) => signal.includes("current/recent title is outside"))
  ) {
    department = NOT_A_MATCH;
  } else {
    department = HUMAN_REVIEW;
  }

  const bestInDepartment =
    department !== NOT_A_MATCH && department !== UNSURE && department !== HUMAN_REVIEW
      ? scored.find((s) => s.job.department === department) || null
      : null;
  const role = department === HUMAN_REVIEW ? HUMAN_REVIEW : department === NOT_A_MATCH ? NOT_A_MATCH : "";

  // Confidence:
  //  3 = recent work strongly aligns to this department and at least one role family.
  //  2 = good phData fit; department is the most obvious choice.
  //  1 = likely phData fit but department is a low-confidence educated guess.
  //  N/A = clearly not applicable for phData.
  //  ? = insufficient profile data to decide either way.
  let confidence: 1 | 2 | 3 | "N/A" | "?";
  if (department === NOT_A_MATCH) {
    confidence = "N/A";
  } else if (department === HUMAN_REVIEW) {
    confidence = "?";
  } else if (
    bestRecentRoleEvidence &&
    department === bestRecentRoleEvidence.job.department &&
    topDept.recentScore >= 6
  ) {
    confidence = 3;
  } else if (department !== NOT_A_MATCH && department !== UNSURE && department !== HUMAN_REVIEW && topDept.recentScore >= 4) {
    confidence = 2;
  } else {
    confidence = 1;
  }

  // Build rationale
  const parts: string[] = [];
  if (department === HUMAN_REVIEW) {
    parts.push(HUMAN_REVIEW);
  } else if (department === NOT_A_MATCH) {
    if (career.negativeSignals.length > 0) {
      parts.push(
        `Not applicable for phData because ${career.negativeSignals.slice(0, 2).join("; ")}.`,
      );
    } else {
      parts.push(
        "No clear evidence that the candidate's recent work is in phData's data, AI, cloud, consulting, product, or enterprise-sales lanes.",
      );
    }
  } else if (department === UNSURE) {
    parts.push("Profile signals are too thin or ambiguous for confident routing.");
  } else {
    parts.push(`Profile aligns with ${department}`);
    if (career.positiveSignals.length > 0) {
      parts.push(career.positiveSignals[0]);
    }
    const rationaleJob = bestRecentRoleEvidence || bestInDepartment || best;
    if (rationaleJob.matched_requirements.length > 0) {
      parts.push(
        `recent-work evidence seen: ${rationaleJob.matched_requirements.slice(0, 3).join(", ")}`,
      );
    }
    if (confidence === 3 && bestRecentRoleEvidence) {
      parts.push(
        `Score 3 because recent responsibilities, title/level, location, YOE, and role-family requirements line up with the ${department} department.`,
      );
    } else if (confidence === 2) {
      parts.push("Score 2 because the candidate appears to fit phData generally and this is the most obvious department from recent work history.");
    } else {
      parts.push("Score 1 because the profile looks phData-relevant, but the department choice is an educated guess and needs recruiter review.");
    }
  }

  return {
    best_job: (bestRecentRoleEvidence || bestInDepartment || best).job,
    best_score: (bestRecentRoleEvidence || bestInDepartment || best).total,
    department,
    role,
    rationale: parts.join(". ").replace(/\.+/g, ".").trim(),
    confidence,
    best_dept_score: topDept.score,
    candidate_yoe: yoe,
    candidate_region: region,
  };
}

export function validDepartments(): string[] {
  return DEPT_KEYWORDS.map((d) => d.name);
}
