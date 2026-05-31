/**
 * Headless functional test: parse the sample CSV, score each row against
 * the role library, and verify output structure + matching expectations.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import Papa from "papaparse";
import { HUMAN_REVIEW, matchCandidate, type RoleLibraryJob } from "../shared/matcher";
import {
  APPENDED_COLUMNS,
  COLUMN_TEMPLATE,
} from "../shared/template";
import {
  buildExportHeaders,
  buildExportRow,
} from "../client/src/lib/export";

const ROOT = "/home/user/workspace/phdata-matcher";
const SAMPLE = path.join(ROOT, "sample/sample_candidates.csv");
const LIB = path.join(ROOT, "shared/role-library.json");

const lib = JSON.parse(fs.readFileSync(LIB, "utf-8")) as {
  jobs: RoleLibraryJob[];
};
const csv = fs.readFileSync(SAMPLE, "utf-8");
const parsed = Papa.parse<Record<string, string>>(csv, {
  header: true,
  skipEmptyLines: true,
  transformHeader: (h: string) => h.trim(),
});
const headers = (parsed.meta.fields || []) as string[];
const rows = parsed.data;

console.log("Input headers:", headers);
console.log("Row count:", rows.length);

const exportHeaders = buildExportHeaders(headers);
console.log("Export columns:", exportHeaders.length);

let errors = 0;
function assert(cond: any, msg: string) {
  if (!cond) {
    console.error("  FAIL:", msg);
    errors++;
  } else {
    console.log("  ok:", msg);
  }
}

console.log("\n--- expectations ---");
assert(
  exportHeaders.length === COLUMN_TEMPLATE.length + APPENDED_COLUMNS.length,
  `export uses template columns + department evaluation columns`,
);
assert(
  exportHeaders.slice(-APPENDED_COLUMNS.length).join(",") === APPENDED_COLUMNS.join(","),
  `last columns are appended phData evaluation columns`,
);
assert(
  !exportHeaders.some((h) => /^ai score$/i.test(h.trim()) || /^ai reasoning$/i.test(h.trim())),
  "legacy AI Score / AI Reasoning template columns are removed",
);

const expectations: Array<{
  name: string;
  deptIncludes?: string;
  conf?: 1 | 2 | 3 | "N/A" | "?";
  notMatch?: boolean;
  needsReview?: boolean;
}> = [
  { name: "Priya", deptIncludes: "Data Engineering", conf: 3 },
  { name: "Carlos", deptIncludes: "Machine Learning", conf: 2 },
  { name: "Jordan", deptIncludes: "Analytics", conf: 2 },
  { name: "Anna", deptIncludes: "Program Management", conf: 3 },
  { name: "Marco", deptIncludes: "Sales", conf: 3 },
  { name: "Lucia", deptIncludes: "Data Engineering", conf: 3 },
  { name: "Sam", needsReview: true },
  { name: "Ben", deptIncludes: "Advisory", conf: 3 },
];

const exportRows: string[][] = [];
rows.forEach((r, i) => {
  const m = matchCandidate(r, lib.jobs);
  const exportRow = buildExportRow(r, m, headers);
  exportRows.push(exportRow);
  const name = (r["Full Name"] || "").split(" ")[0];
  console.log(
    `[${i}] ${name.padEnd(8)} dept=${m.department.padEnd(34)} role=${m.role.slice(0, 60).padEnd(60)} conf=${m.confidence} score=${m.best_score}`,
  );
  const exp = expectations.find((e) => name.startsWith(e.name));
  if (exp) {
    if (exp.deptIncludes)
      assert(
        m.department.includes(exp.deptIncludes),
        `${name}: dept includes "${exp.deptIncludes}" (got "${m.department}")`,
      );
    if (exp.conf)
      assert(
        m.confidence === exp.conf,
        `${name}: confidence === ${exp.conf} (got ${m.confidence})`,
      );
    if (exp.notMatch)
      assert(
        m.department === "Not a Match for phData" ||
          m.department === "Unsure / Not Enough Information",
        `${name}: should not match (got "${m.department}")`,
      );
    if (exp.needsReview)
      assert(
        m.department === HUMAN_REVIEW && m.confidence === "?",
        `${name}: should need human review when evidence is insufficient (got "${m.department}", ${m.confidence})`,
      );
  }
});

console.log("\n--- guardrail expectations ---");
const guardrailRows: Array<{
  label: string;
  row: Record<string, string>;
  expectNotMatch?: boolean;
  expectHumanReview?: boolean;
  expectDept?: string;
  expectReasonIncludes?: string;
  expectConfidence?: 1 | 2 | 3 | "N/A" | "?";
}> = [
  {
    label: "incidental Power BI financial advisor",
    expectNotMatch: true,
    expectReasonIncludes: "Finance",
    expectConfidence: "N/A",
    row: {
      "Full Name": "Taylor Advisor",
      "LinkedIn URL": "https://www.linkedin.com/in/taylor-advisor",
      "Current Title": "Financial Advisor",
      "Current Company": "Heritage Wealth Partners",
      Location: "Austin, TX",
      "Total YOE": "12",
      Skills: "Power BI, Excel, Tableau, SQL",
      Summary:
        "Financial advisor creating Power BI dashboards for clients to show investment trends and portfolio performance.",
    },
  },
  {
    label: "school-affiliated analyst with tool buzzwords",
    expectHumanReview: true,
    row: {
      "Full Name": "Morgan Campus",
      "LinkedIn URL": "https://www.linkedin.com/in/morgan-campus",
      "Current Title": "Program Coordinator",
      "Current Company": "University of Minnesota",
      Location: "Minneapolis, MN",
      "Total YOE": "6",
      Skills: "Power BI, Reporting, SQL",
      Summary:
        "Coordinates student programs and maintains basic reports for school leadership.",
      "School 1": "University of Minnesota",
    },
  },
  {
    label: "true BI delivery profile still routes",
    expectDept: "Analytics",
    row: {
      "Full Name": "Riley BI",
      "LinkedIn URL": "https://www.linkedin.com/in/riley-bi",
      "Current Title": "Senior BI Developer",
      "Current Company": "Enterprise Data Co",
      Location: "Dallas, TX",
      "Total YOE": "8",
      Skills: "Power BI, DAX, SQL, Snowflake, Semantic Model",
      Summary:
        "Built enterprise reporting, semantic models, and Power BI dashboards for cross-functional business teams on Snowflake.",
    },
  },
  {
    label: "senior business architect routes to Business Architecture role",
    expectDept: "Business Architecture",
    row: {
      "Full Name": "Casey Architect",
      "LinkedIn URL": "https://www.linkedin.com/in/casey-architect",
      "Current Title": "Senior Business Architect",
      "Current Company": "Enterprise Data Consulting",
      Location: "Remote, US",
      "Total YOE": "11",
      Skills:
        "Business Architecture, Requirements Gathering, Use Case Prioritization, Roadmap Development, Backlog Building, ROI Analysis, Information Architecture, Data Governance",
      Summary:
        "Leads discovery sessions and stakeholder interviews for analytics and Snowflake data-platform programs. Creates backlogs, roadmaps, technical requirements, conceptual data models, and business ROI readouts that connect enterprise data investments to measurable business value.",
    },
  },
  {
    label: "technology business analyst routes to PMO",
    expectDept: "Program Management",
    row: {
      "Full Name": "Blake Analyst",
      "LinkedIn URL": "https://www.linkedin.com/in/blake-analyst",
      "Current Title": "Business Analyst",
      "Current Company": "Regional Insurance Services",
      Location: "Columbus, OH",
      "Total YOE": "8",
      Skills: "Requirements Gathering, Process Documentation, Excel, Stakeholder Management",
      Summary:
        "Documents technology workflows, coordinates agile status meetings, gathers requirements, and maintains implementation backlogs for software and data platform process improvements.",
    },
  },
  {
    label: "DevOps and SRE primary responsibility routes to Managed Services",
    expectDept: "Managed Services",
    row: {
      "Full Name": "Devon Ops",
      "LinkedIn URL": "https://www.linkedin.com/in/devon-ops",
      "Current Title": "Senior DevOps Engineer",
      "Current Company": "Cloud Platform Co",
      Location: "Remote, US",
      "Total YOE": "9",
      Skills: "AWS, Kubernetes, Terraform, CI/CD, SRE, Observability",
      Summary:
        "Owns cloud infrastructure, platform reliability, deployment automation, SRE practices, and production support for data and analytics platforms.",
    },
  },
  {
    label: "data visualization primary responsibility routes to Analytics",
    expectDept: "Analytics",
    row: {
      "Full Name": "Vera Viz",
      "LinkedIn URL": "https://www.linkedin.com/in/vera-viz",
      "Current Title": "Data Visualization Analyst",
      "Current Company": "Technology Analytics Co",
      Location: "Phoenix, AZ",
      "Total YOE": "6",
      Skills: "Tableau, Power BI, SQL, Semantic Models, KPI Dashboards",
      Summary:
        "Builds business intelligence dashboards, technology analytics reporting, semantic models, and executive data visualization products.",
    },
  },
  {
    label: "applied LLM RAG engineer routes to Machine Learning",
    expectDept: "Machine Learning",
    row: {
      "Full Name": "Ari Agents",
      "LinkedIn URL": "https://www.linkedin.com/in/ari-agents",
      "Current Title": "AI Engineer",
      "Current Company": "Applied AI Studio",
      Location: "Austin, TX",
      "Total YOE": "7",
      Skills: "LLM, RAG, Agentic AI, Python, Vector Databases, MLOps",
      Summary:
        "Builds production LLM applications, retrieval augmented generation systems, agentic AI workflows, and deployed machine learning services.",
    },
  },
  {
    label: "M&A analyst is never a fit",
    expectNotMatch: true,
    expectReasonIncludes: "M&A",
    expectConfidence: "N/A",
    row: {
      "Full Name": "Maya Deals",
      "Current Title": "M&A Analyst",
      "Current Company": "Strategic Deals Group",
      Location: "New York, NY",
      "Total YOE": "7",
      Skills: "SQL, Power BI, Financial Modeling, Due Diligence",
      Summary:
        "Supports mergers and acquisitions, transaction advisory, deal diligence, and integration planning with dashboards for executives.",
    },
  },
  {
    label: "supply chain and procurement work is never a fit",
    expectNotMatch: true,
    expectReasonIncludes: "Supply chain",
    expectConfidence: "N/A",
    row: {
      "Full Name": "Parker Supply",
      "Current Title": "Supply Chain Analytics Manager",
      "Current Company": "Global Manufacturing Co",
      Location: "Chicago, IL",
      "Total YOE": "9",
      Skills: "Tableau, SQL, Forecasting, Procurement, Inventory",
      Summary:
        "Leads procurement analytics, inventory optimization, vendor management, and logistics reporting for supply chain operations.",
    },
  },
  {
    label: "finance/accounting scope is not fit",
    expectNotMatch: true,
    expectReasonIncludes: "Finance",
    expectConfidence: "N/A",
    row: {
      "Full Name": "Finley Ledger",
      "Current Title": "Senior Accounting Manager",
      "Current Company": "SaaS Corp",
      Location: "Atlanta, GA",
      "Total YOE": "10",
      Skills: "SQL, Power BI, Reconciliation, General Ledger",
      Summary:
        "Owns month end close, financial statements, journal entries, account reconciliations, and finance dashboards.",
    },
  },
  {
    label: "sales title in banking industry only considers Sales",
    expectDept: "Sales",
    row: {
      "Full Name": "Avery Seller",
      "Current Title": "Enterprise Account Executive",
      "Current Company": "Cloud Data Vendor",
      Location: "Boston, MA",
      "Total YOE": "8",
      Skills: "Enterprise Sales, Account Executive, Quota, Pipeline Generation, Financial Services",
      Summary:
        "Sells SaaS and data platform services to banking, insurance, and capital markets accounts with quota ownership.",
    },
  },
  {
    label: "marketing professional is no fit when no marketing role is open",
    expectNotMatch: true,
    expectReasonIncludes: "No marketing roles",
    expectConfidence: "N/A",
    row: {
      "Full Name": "Marley Demand",
      "Current Title": "Demand Generation Marketing Manager",
      "Current Company": "B2B Software Co",
      Location: "Denver, CO",
      "Total YOE": "7",
      Skills: "Marketing Campaigns, SEO, SEM, Tableau, Analytics",
      Summary:
        "Runs paid media, content marketing, demand generation campaigns, and marketing attribution dashboards.",
    },
  },
  {
    label: "cybersecurity professional is no fit",
    expectNotMatch: true,
    expectReasonIncludes: "Cybersecurity Professional",
    expectConfidence: "N/A",
    row: {
      "Full Name": "Cy Security",
      "Current Title": "Senior Cybersecurity Analyst",
      "Current Company": "Enterprise Security Co",
      Location: "Seattle, WA",
      "Total YOE": "8",
      Skills: "SIEM, Threat Detection, Incident Response, Python",
      Summary:
        "Performs threat hunting, vulnerability management, security operations, and incident response.",
    },
  },
  {
    label: "Workday and competing enterprise product specialist is no fit",
    expectNotMatch: true,
    expectReasonIncludes: "Workday",
    expectConfidence: "N/A",
    row: {
      "Full Name": "Wren HCM",
      "Current Title": "Workday Integration Consultant",
      "Current Company": "HCM Systems Partner",
      Location: "Remote, US",
      "Total YOE": "6",
      Skills: "Workday, Integrations, Reports, SQL",
      Summary:
        "Implements Workday HCM integrations, reports, and business processes for enterprise customers.",
    },
  },
  {
    label: "department title maps directly to Data Engineering",
    expectDept: "Data Engineering",
    row: {
      "Full Name": "Drew Data",
      "Current Title": "Data Engineering Manager",
      "Current Company": "Enterprise Data Co",
      Location: "Dallas, TX",
      "Total YOE": "9",
      Skills: "SQL, Python, Snowflake, dbt, Tableau",
      Summary:
        "Leads a data engineering team building ELT pipelines, warehouse models, and platform integrations for analytics teams.",
    },
  },
  {
    label: "older data buzzwords discounted when recent work is unrelated",
    expectHumanReview: true,
    row: {
      "Full Name": "Old Data",
      "Current Title": "Customer Success Manager",
      "Current Company": "B2B Support Co",
      Location: "Austin, TX",
      "Total YOE": "10",
      Summary: "Owns renewals, onboarding, account health, and customer escalations for a SaaS product.",
      "Company2": "Legacy Analytics Co",
      "Company2 Title": "BI Developer",
      "Company2 Description": "Built Power BI dashboards, SQL reporting, Tableau dashboards, and semantic models from 2017 to 2019.",
    },
  },
];

for (const g of guardrailRows) {
  const m = matchCandidate(g.row, lib.jobs);
  console.log(
    `${g.label}: dept=${m.department} role=${m.role} conf=${m.confidence} rationale=${m.rationale}`,
  );
  if (g.expectNotMatch) {
    assert(m.department === "Not a Match for phData", `${g.label}: should be N/A / not applicable`);
  }
  if (g.expectHumanReview) {
    assert(
      m.department === HUMAN_REVIEW && m.confidence === "?",
      `${g.label}: should need human review rather than be marked not fit (got ${m.department}, ${m.confidence})`,
    );
  }
  if (g.expectDept) {
    assert(
      m.department.includes(g.expectDept),
      `${g.label}: department includes ${g.expectDept} (got ${m.department})`,
    );
  }
  if (g.expectReasonIncludes) {
    assert(
      m.rationale.toLowerCase().includes(g.expectReasonIncludes.toLowerCase()),
      `${g.label}: rationale includes ${g.expectReasonIncludes} (got ${m.rationale})`,
    );
  }
  if (g.expectConfidence) {
    assert(
      m.confidence === g.expectConfidence,
      `${g.label}: confidence is ${g.expectConfidence} (got ${m.confidence})`,
    );
  }
  if (g.label.includes("business architect routes")) {
    assert(m.confidence === 3, `${g.label}: confidence is 3 (got ${m.confidence})`);
  }
}

// Verify export structure on row 0
const row0 = exportRows[0];
assert(row0.length === exportHeaders.length, "row0 has correct column count");
const fullNameIdx = exportHeaders.findIndex((h) => h.toLowerCase() === "full name");
assert(row0[fullNameIdx] === rows[0]["Full Name"], "Full Name preserved");
const liUrlIdx = exportHeaders.findIndex((h) => h.toLowerCase() === "linkedin url");
assert(row0[liUrlIdx].includes("linkedin.com"), "LinkedIn URL mapped");

// Appended department evaluation columns
assert(
  ["1", "2", "3", "N/A", "?"].includes(row0[row0.length - 3]),
  "phData Reasoning Score is 1|2|3|N/A|?",
);
assert(
  row0[row0.length - 2].length > 0,
  "phData Fit Rationale is populated",
);
assert(
  row0[row0.length - 1].length > 0,
  "phData Department Fit is populated",
);

// Row order preserved
const firstNames = exportRows.map(
  (r) => r[fullNameIdx],
);
const inputNames = rows.map((r) => r["Full Name"]);
assert(
  firstNames.join("|") === inputNames.join("|"),
  "Input row order preserved in export",
);

console.log(`\nDone. ${errors === 0 ? "ALL OK" : `${errors} FAILURES`}`);
process.exit(errors === 0 ? 0 : 1);
