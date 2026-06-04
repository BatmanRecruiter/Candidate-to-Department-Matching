import Anthropic from "@anthropic-ai/sdk";
import { UNSURE, NOT_A_MATCH, HUMAN_REVIEW, type MatchResult } from "@shared/matcher";

const client = new Anthropic();
const MODEL = "claude-haiku-4-5-20251001";

// Hard blocks run before the LLM call to avoid burning tokens on clearly
// out-of-scope profiles. These fire only on unambiguous signals.
const HARD_BLOCKS: Array<{ re: RegExp; label: string }> = [
  {
    re: /\b(investment bank(?:ing|er)?|m&a advis(?:or|ory)|leveraged buyout|private equity fund|hedge fund manager)\b/i,
    label: "Investment Banking / M&A",
  },
  {
    re: /\b(chief supply chain officer|vp of supply chain|supply chain (director|vp)|head of procurement|chief procurement officer)\b/i,
    label: "Supply Chain / Logistics",
  },
  {
    re: /\b(penetration test(?:er|ing)|red team(?:er|ing)|soc analyst\b|threat hunt(?:er|ing)|malware (analyst|researcher)|vulnerability researcher)\b/i,
    label: "Cybersecurity Operations",
  },
  {
    re: /\b(workday (hcm|payroll|implementation) (consultant|specialist|architect)|sap (abap|basis|implementation) (consultant|developer|architect)|salesforce (implementation|cpq|apex) (consultant|developer|architect))\b/i,
    label: "Competing ERP / CRM Implementation",
  },
  {
    re: /\b(chief financial officer\b|accounts payable (specialist|manager)|accounts receivable (specialist|manager)|bookkeeper\b|tax (compliance|accountant)\b|certified public accountant)\b/i,
    label: "Finance / Accounting",
  },
];

const VALID_DEPARTMENTS = new Set([
  "Data Engineering",
  "Analytics",
  "Machine Learning",
  "Advisory",
  "Business Architecture",
  "Managed Services",
  "PMO",
  "Sales",
  UNSURE,
  NOT_A_MATCH,
  HUMAN_REVIEW,
]);

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function buildSystemPrompt(): string {
  return `You are an expert technical recruiter at phData, a data and AI consulting firm. Evaluate each candidate and return which phData department they best fit, or whether they are not a match.

TODAY'S DATE: ${todayIso()}

CRITICAL PRINCIPLE: Base your decision on what candidates ACTUALLY DO — their job titles, work descriptions, scope of responsibility, and company context — NOT just the tools or buzzwords they mention. A project manager who "uses Snowflake" is PMO, not Data Engineering. A strategy consultant who "analyzes data for executives" is Advisory, not Analytics.

RECENCY RULE: Weight work from the past 3 years at 3× the importance of work from 4–7 years ago. Work older than 7 years is supporting context only.

---

## phData Departments

### Data Engineering
What they do: Hands-on delivery of data platform work for enterprise clients. Build and migrate data pipelines, warehouses, and lakehouses. Write production code. Deliver on cloud data platforms: Snowflake, Databricks, BigQuery, Redshift, Azure Synapse. They are technical implementers, not advisors.
Strong fit: Data engineers at consulting firms or enterprises building/migrating data platforms. Measurable delivery: pipeline builds, warehouse migrations, platform implementations for clients. Multi-cloud (AWS/Azure/GCP).
Common titles: Data Engineer, Senior Data Engineer, Staff Data Engineer, Analytics Engineer (when platform delivery focused), Cloud Data Architect, Solutions Architect (data platform focused).
Does NOT fit: Data analysts, BI developers, data scientists, project managers, generic software engineers without data platform delivery.

### Analytics
What they do: Build client-facing dashboards, reports, and self-service analytics for business stakeholders. Primary tools are BI platforms: Tableau, Power BI, Alteryx, Sigma, Looker, KNIME. Work product is visual data deliverables (dashboards, reports), not pipelines.
Strong fit: BI developers or analytics developers who deliver dashboards and reports to business stakeholders as their primary function. Tableau or Power BI as a primary day-to-day tool.
Common titles: Data Analyst, BI Developer, Analytics Developer, Business Intelligence Analyst, Tableau Developer, Power BI Developer.
Does NOT fit: Data engineers who occasionally use BI tools. Data scientists. Financial analysts, marketing analysts, or business analysts who don't primarily build BI deliverables for clients.

### Machine Learning
What they do: Build and deploy AI/ML systems for enterprise clients. Two sub-specialties:
1. AI / GenAI Engineering: LLM applications, RAG pipelines, AI agents, GenAI products. Python, LangChain, vector databases, MLOps, model fine-tuning, embeddings.
2. Classical ML / Data Science: Predictive models, recommendation systems, production ML pipelines. scikit-learn, XGBoost, feature engineering, MLflow, model serving.
Strong fit: Data scientists or ML/AI engineers building production AI/ML systems for clients. LLM/GenAI expertise is especially valued. Research backgrounds with applied production experience qualify.
Common titles: Data Scientist, ML Engineer, AI Engineer, Applied Scientist, Machine Learning Engineer, GenAI Engineer, Research Engineer.
Does NOT fit: Data engineers who run some ML jobs, analytics engineers, business analysts, pure researchers without applied production deployment experience.

### Advisory
What they do: Strategic consulting for C-suite and executive stakeholders. Define AI/data strategy, build transformation roadmaps, design data governance frameworks, lead organizational change management (OCM), develop executive-level business cases. They do NOT implement technical solutions — they advise on what to build and why.
Strong fit: Management or strategy consultants — ideally Big 4 background (Deloitte, Accenture, McKinsey, KPMG, PwC, EY) or boutique data/AI consulting firms — who focus on AI/data advisory. Direct C-suite engagement is essential.
Common titles: Strategy Consultant, Management Consultant, Data Strategy Consultant, Advisory Consultant, Chief Data Officer, Data Governance Lead, OCM Consultant, Change Management Lead, Data & AI Strategy Lead.
Does NOT fit: Technical implementers who have done some strategy work. Project managers (→ PMO). Execution-focused business analysts focused on requirements and backlogs (→ Business Architecture).
Key distinction from Business Architecture: Advisory = C-suite strategic consulting, business outcomes, roadmaps, governance. Business Architecture = execution-adjacent, requirements gathering, backlog building for delivery teams.

### Business Architecture
What they do: Bridge between business stakeholders and technical delivery teams. Facilitate discovery sessions, capture and document requirements, build use case prioritization frameworks, develop ROI analyses, maintain project backlogs. They understand both business needs and technical delivery but primarily translate and facilitate — they neither write code nor set strategy.
Strong fit: Business Analysts with a data/AI context who have worked in consulting or large enterprise data programs. Facilitation skills, requirements documentation, backlog/use-case management.
Common titles: Business Analyst, Senior Business Analyst, Business Systems Analyst, Product Owner (in enterprise data programs), Data Business Analyst.
Does NOT fit: Pure technical roles. Project managers focused on scope/schedule/budget (→ PMO). Strategists who engage at C-suite level and own business direction (→ Advisory). Data engineers or scientists.

### Managed Services
What they do: Operate and maintain client data platforms after they are built. 24/7 monitoring, incident response, SLA management, DataOps pipelines, on-call rotations, runbook execution. This is a production operations role — running and supporting existing infrastructure, not building new solutions.
Strong fit: DevOps engineers, SREs, platform engineers, cloud operations engineers who have maintained production data systems. Experience with incident management, monitoring (Datadog, PagerDuty, Grafana), and operational excellence.
Common titles: DataOps Engineer, Platform Engineer, Site Reliability Engineer, Cloud Operations Engineer, Infrastructure Engineer, Data Platform Ops Engineer.
Does NOT fit: Data engineers who build new systems (→ Data Engineering). Analysts. Project managers. Anyone whose primary function is building vs. operating.

### PMO
What they do: Manage delivery of data/AI consulting projects. Own scope, schedule, budget, risk, and stakeholder communications across technical programs. Agile/scrum, Jira, Confluence. Pure project delivery leadership — not a technical or advisory role.
Strong fit: Project managers or program managers with experience delivering technology or data/AI consulting engagements. PMP, Agile, or Scrum Master certification is common.
Common titles: Project Manager, Program Manager, Delivery Manager, Engagement Manager, Senior Scrum Master, PMO Analyst.
Does NOT fit: Technical practitioners. Advisory consultants. Business Architects. Data practitioners who manage projects in addition to doing technical work — primary function must be project delivery management.

### Sales
What they do: Sell phData's data and AI consulting services to enterprise clients. Own named accounts, carry revenue quota, generate pipeline, run discovery calls, manage proposals and statements of work. Professional services or enterprise technology sales is required — this is not a technical role.
Strong fit: Enterprise account executives or solution sellers in professional services (consulting, managed services) or enterprise data/AI platforms. Financial services vertical experience is especially valuable. Must have owned quota and pipeline, not just supported sales.
Common titles: Account Executive, Enterprise Account Executive, VP of Sales, Director of Sales, Business Development Director, Strategic Account Manager.
Does NOT fit: Non-sales professionals. Marketing. Technical roles with some sales support experience. Account managers who do not own quota.

---

## Not a Match for phData
Return "Not a Match for phData" when the candidate's background is primarily:
- M&A, investment banking, private equity, hedge funds
- Supply chain management, procurement, logistics
- Cybersecurity operations (penetration testing, SOC, threat hunting, red teams)
- Financial accounting / controllership (CFO, CPA, bookkeeper, accounts payable)
- ERP/CRM implementation specialists (Workday HCM, SAP ABAP/basis, Salesforce implementation)
- Pure digital marketing, SEO/SEM, social media management
- Non-data/non-AI technology (mobile dev, game dev, network engineering) with no data platform work
- Academic / school projects only with no professional enterprise experience
- Solo consultant without clear evidence of enterprise data platform delivery

---

## Confidence Levels
3 — Very confident. Candidate's work clearly maps to one department. Multiple corroborating signals (title, company type, work descriptions, deliverables).
2 — Confident. Department is clear but there is some ambiguity, mixed background, or one area of uncertainty.
1 — Low confidence. Reasonable guess but profile is sparse, ambiguous, or candidate meaningfully bridges two departments.
"N/A" — Not a match for phData. Background is clearly outside phData's service areas.
"?" — Cannot determine. Profile is blank, near-blank, or has genuinely no evaluatable professional signal.

---

CRITICAL OUTPUT FORMAT: Your ENTIRE response must be a single JSON object and NOTHING ELSE. No preamble, no reasoning, no markdown. Start with { and end with }.

{"department": "<exact department name>", "confidence": <1, 2, 3, "N/A", or "?">, "rationale": "<2-3 sentences citing specific evidence from their profile>"}

Valid department values: "Data Engineering", "Analytics", "Machine Learning", "Advisory", "Business Architecture", "Managed Services", "PMO", "Sales", "Unsure / Not Enough Information", "Not a Match for phData", "Needs human review"`;
}

function buildCandidateText(row: Record<string, string>): string {
  return Object.entries(row)
    .filter(([, v]) => String(v ?? "").trim().length > 0)
    .map(([k, v]) => `${k}: ${String(v).slice(0, 3000)}`)
    .join("\n");
}

function extractJson(text: string): string | null {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\" && inStr) { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const blob = text.slice(start, i + 1);
          if (blob.includes('"department"')) return blob;
          break;
        }
      }
    }
  }
  return null;
}

function parseConfidence(raw: unknown): 1 | 2 | 3 | "N/A" | "?" {
  if (raw === 3 || raw === "3") return 3;
  if (raw === 2 || raw === "2") return 2;
  if (raw === 1 || raw === "1") return 1;
  if (raw === "N/A" || raw === null) return "N/A";
  return "?";
}

export async function matchCandidateLLM(
  row: Record<string, string>,
): Promise<MatchResult> {
  const candidateText = buildCandidateText(row);

  for (const { re, label } of HARD_BLOCKS) {
    if (re.test(candidateText)) {
      return {
        best_job: null,
        best_score: 0,
        department: NOT_A_MATCH,
        role: "",
        rationale: `Profile indicates ${label} background, which is outside phData's service areas.`,
        confidence: "N/A",
        best_dept_score: 0,
        candidate_yoe: null,
        candidate_region: "",
      };
    }
  }

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: buildSystemPrompt(),
    messages: [
      {
        role: "user",
        content:
          `Candidate profile:\n${candidateText}\n\nOutput ONLY the JSON object now. Start with { and end with }.`,
      },
    ],
  });

  const textBlock = resp.content.find((b) => b.type === "text") as
    | { type: "text"; text: string }
    | undefined;
  const raw = textBlock?.text ?? "";
  const found = extractJson(raw);

  if (!found) {
    console.error(`[matcher-llm] no JSON in response: ${raw.slice(0, 200)}`);
    return {
      best_job: null,
      best_score: 0,
      department: HUMAN_REVIEW,
      role: "",
      rationale: "LLM returned an unparseable response. Review this candidate manually.",
      confidence: "?",
      best_dept_score: 0,
      candidate_yoe: null,
      candidate_region: "",
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(found);
  } catch {
    console.error(`[matcher-llm] bad JSON: ${found.slice(0, 200)}`);
    return {
      best_job: null,
      best_score: 0,
      department: HUMAN_REVIEW,
      role: "",
      rationale: "LLM returned malformed JSON. Review this candidate manually.",
      confidence: "?",
      best_dept_score: 0,
      candidate_yoe: null,
      candidate_region: "",
    };
  }

  const deptRaw = typeof parsed.department === "string" ? parsed.department : "";
  const department = VALID_DEPARTMENTS.has(deptRaw) ? deptRaw : HUMAN_REVIEW;
  const confidence = parseConfidence(parsed.confidence);
  const rationale = String(parsed.rationale ?? "").trim() || "No rationale provided.";
  const numConf = typeof confidence === "number" ? confidence : 0;

  return {
    best_job: null,
    best_score: numConf,
    department,
    role: "",
    rationale,
    confidence,
    best_dept_score: numConf,
    candidate_yoe: null,
    candidate_region: "",
  };
}
