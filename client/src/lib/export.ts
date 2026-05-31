import {
  APPENDED_COLUMNS,
  COLUMN_TEMPLATE,
  formatTemplateCell,
  isBlankHeader,
  mapTemplateToInputs,
} from "@shared/template";
import type { MatchResult } from "@shared/matcher";

export interface ScoredRow {
  row: Record<string, string>;
  match: MatchResult;
}

/**
 * Build the final CSV header list:
 *   phData export template columns + the appended phData evaluation columns.
 */
export function buildExportHeaders(_inputHeaders: string[]): string[] {
  return [...COLUMN_TEMPLATE, ...APPENDED_COLUMNS];
}

/**
 * Build a single output row given:
 *  - the input row (raw columns from uploaded CSV),
 *  - the matcher result,
 *  - the original input headers used to map values into the export template.
 */
export function buildExportRow(
  inputRow: Record<string, string>,
  match: MatchResult,
  inputHeaders: string[],
): string[] {
  const mapping = mapTemplateToInputs(inputHeaders);
  const cells = COLUMN_TEMPLATE.map((templateHeader, idx) => {
    if (isBlankHeader(templateHeader)) return "";
    const sourceHeader = mapping[idx];
    const rawValue = sourceHeader ? (inputRow[sourceHeader] ?? "") : "";
    return formatTemplateCell(templateHeader, String(rawValue), inputRow);
  });

  // Appended phData columns
  cells.push(String(match.confidence));
  cells.push(match.rationale);
  cells.push(match.department);

  return cells;
}

export function buildMapping(inputHeaders: string[]): Array<string | null> {
  return mapTemplateToInputs(inputHeaders);
}
