import Papa from "papaparse";

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

export function parseCsvText(text: string): ParsedCsv {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  const headers = (parsed.meta.fields || []).map((h) => String(h));
  // Coerce all cells to strings, preserve row order.
  const rows = (parsed.data || [])
    .filter((r) => r && Object.keys(r).length > 0)
    .map((r) => {
      const out: Record<string, string> = {};
      for (const h of headers) out[h] = r[h] == null ? "" : String(r[h]);
      return out;
    });
  return { headers, rows };
}

export function rowsToCsv(headers: string[], rows: string[][]): string {
  const safeRows = rows.map((row) => row.map(sanitizeCsvCell));
  return Papa.unparse({ fields: headers, data: safeRows });
}

function sanitizeCsvCell(value: unknown): string {
  const s = value == null ? "" : String(value);
  return /^[=+\-@]/.test(s) ? `\t${s}` : s;
}

export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
