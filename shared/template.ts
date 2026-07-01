// Standard export column template. Adapted from
// /home/user/workspace/phdata_inputs/phdjd001 - export column-template.ts.
// Anything labeled "Blank" exports as an empty cell. Everything else is
// fuzzy-matched against the input CSV's columns.

export const COLUMN_TEMPLATE: string[] = [
  "Blank",
  "Blank",
  "Blank",
  "Blank",
  "LinkedIn URL",
  "Full Name",
  "Blank",
  "Blank",
  "Blank",
  "Blank",
  "Blank",
  "Company1",
  "Title1",
  "YAC",
  "Company1 End Date",
  "Company2",
  "Company2 Title",
  "Candidate Location",
  "School1",
  "School1 Degree",
  "School1 Major",
  "School 1 End Date",
  "LinkedIn ID",
  "Blank",
  "Blank",
  "Blank",
];

export const APPENDED_COLUMNS: string[] = [
  "phData Reasoning Score",
  "phData Fit Rationale",
  "phData Department Fit",
];

export function isBlankHeader(h: string): boolean {
  return h.trim().toLowerCase() === "blank";
}

export function isScoreHeader(h: string): boolean {
  const s = h.trim().toLowerCase();
  return s === "ai score" || s === "score";
}

export function isReasonHeader(h: string): boolean {
  const s = h.trim().toLowerCase();
  return (
    s === "ai reasoning" ||
    s === "ai reason" ||
    s === "reason" ||
    s === "reasoning"
  );
}

export function isTotalYoeHeader(h: string): boolean {
  return h.trim().toLowerCase() === "total yoe";
}

export function parseCompanyDateHeader(
  h: string,
): { index: number; kind: "start" | "end" } | null {
  const m = h
    .trim()
    .toLowerCase()
    .match(/^company\s*(\d+)\s*(start|end)\s*date$/);
  if (!m) return null;
  return { index: Number(m[1]), kind: m[2] as "start" | "end" };
}

function extractLinkedInSlug(url: string): string {
  if (!url) return "";
  const m = url.match(/\/in\/([^/?#]+)/i);
  return m ? m[1] : "";
}

function parseDateLoose(raw: string): Date | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{4}$/.test(s)) {
    const y = Number(s);
    return new Date(Date.UTC(y, 0, 1));
  }
  let m = s.match(/^(\d{4})[-/](\d{1,2})$/);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
  m = s.match(/^(\d{1,2})[-/](\d{4})$/);
  if (m) return new Date(Date.UTC(Number(m[2]), Number(m[1]) - 1, 1));
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t);
  return null;
}

function formatMMDDYYYY(raw: string): string {
  if (!raw) return "";
  const d = parseDateLoose(raw);
  if (!d) return raw;
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const yyyy = String(d.getUTCFullYear());
  return `${mm}/${dd}/${yyyy}`;
}

function formatYYYY(raw: string): string {
  if (!raw) return "";
  const d = parseDateLoose(raw);
  if (!d) {
    const m = raw.match(/\b(19|20)\d{2}\b/);
    return m ? m[0] : raw;
  }
  return String(d.getUTCFullYear());
}

export function formatTemplateCell(
  templateHeader: string,
  value: string,
  rowFields: Record<string, string>,
): string {
  const h = templateHeader.trim().toLowerCase();

  if (parseCompanyDateHeader(templateHeader)) {
    return formatMMDDYYYY(value);
  }

  if (h === "school 1 end date" || h === "school1 end date") {
    return formatYYYY(value);
  }

  if (isTotalYoeHeader(templateHeader)) {
    const s = (value || "").trim();
    if (!s) return "";
    const n = Number(s);
    return Number.isFinite(n) ? Math.max(0, n).toFixed(2) : s;
  }

  if (h === "linkedin id") {
    let id = (value || "").trim();
    if (!id) {
      const urlKey = Object.keys(rowFields).find(
        (k) => /linked/i.test(k) && /url/i.test(k),
      );
      if (urlKey) id = extractLinkedInSlug(rowFields[urlKey] || "");
    }
    if (!id) return "";
    return id.startsWith("'") ? id : "'" + id;
  }

  return value;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  return normalize(s).split(/\s+/).filter(Boolean);
}

const ALIASES: Record<string, string[]> = {
  "linkedin url": [
    "linkedin url",
    "candidate linkedin url",
    "linkedin profile url",
    "profile url",
    "li url",
    "url",
  ],
  "full name": ["full name", "candidate name", "name", "candidate"],
  company1: [
    "company1",
    "company 1",
    "current company",
    "company",
    "employer",
    "current employer",
  ],
  title1: [
    "title1",
    "title 1",
    "company1 title",
    "company 1 title",
    "current title",
    "title",
    "current role",
    "role",
    "position",
  ],
  yac: ["yac", "years at company", "tenure", "years at current company"],
  "company1 start date": [
    "company1 start date",
    "company 1 start date",
    "current start date",
    "start date 1",
    "company 1 start",
  ],
  "company1 end date": [
    "company1 end date",
    "company 1 end date",
    "current end date",
    "end date",
    "company 1 end",
    "end date 1",
  ],
  company2: ["company2", "company 2", "previous company", "prior company"],
  "company2 title": [
    "company2 title",
    "company 2 title",
    "previous title",
    "prior title",
  ],
  "company2 start date": [
    "company2 start date",
    "company 2 start date",
    "start date 2",
  ],
  "company2 end date": [
    "company2 end date",
    "company 2 end date",
    "end date 2",
    "previous end date",
  ],
  "candidate location": [
    "candidate location",
    "location",
    "city",
    "geo",
    "based in",
  ],
  school1: [
    "school1",
    "school 1",
    "school1 name",
    "school 1 name",
    "university",
    "school",
    "college",
    "alma mater",
  ],
  "school1 degree": ["school1 degree", "school 1 degree", "degree 1", "degree"],
  "school1 major": [
    "school1 major",
    "school 1 major",
    "school1 field of study",
    "school 1 field of study",
    "field of study",
    "major 1",
    "major",
  ],
  "school 1 end date": [
    "school 1 end date",
    "school1 end date",
    "graduation date",
    "grad date",
    "graduation year",
    "grad year",
  ],
  "linkedin id": ["linkedin id", "li id", "linkedin handle", "profile id"],
};

export function mapTemplateToInputs(
  inputHeaders: string[],
): Array<string | null> {
  const normalizedInputs = inputHeaders.map((h) => ({
    raw: h,
    norm: normalize(h),
  }));
  const result: Array<string | null> = [];

  for (const tmpl of COLUMN_TEMPLATE) {
    if (isBlankHeader(tmpl)) {
      result.push(null);
      continue;
    }
    const tNorm = normalize(tmpl);

    let hit = normalizedInputs.find((c) => c.norm === tNorm);

    if (!hit) {
      const aliases = ALIASES[tNorm] || [tNorm];
      for (const a of aliases) {
        hit = normalizedInputs.find((c) => c.norm === a);
        if (hit) break;
      }
    }

    if (!hit) {
      const tTokens = tokens(tmpl);
      if (tTokens.length > 0) {
        let best: { raw: string; norm: string; extra: number } | null = null;
        for (const c of normalizedInputs) {
          const cTokens = new Set(tokens(c.raw));
          const allMatched = tTokens.every((tk) => cTokens.has(tk));
          if (!allMatched) continue;
          const extra = cTokens.size - tTokens.length;
          if (!best || extra < best.extra) best = { ...c, extra };
        }
        if (best) hit = { raw: best.raw, norm: best.norm };
      }
    }

    result.push(hit ? hit.raw : null);
  }

  return result;
}
