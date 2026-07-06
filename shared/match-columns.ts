/**
 * Allowlist of candidate-CSV columns that ride in the LLM matching payload.
 *
 * Every column sent to /api/match or /api/match/batch is billed per candidate
 * (the batch path has no prompt caching), so unknown columns are ignored by
 * default, not billed by default. This ONLY shapes what the LLM sees — the
 * client keeps full rows locally for exports, saved history, and calibration
 * name/key extraction, none of which touch this filter.
 */

// Patterns are tested against normalized headers (trimmed, lowercased,
// whitespace collapsed). Derived from the matching signal the prompt actually
// uses: who the candidate is, what they do, where, for how long, with which
// skills, and their education. Deliberately excluded: LinkedIn URL/ID (identity
// plumbing with zero matching signal), emails, phones, notes, tags.
// Name matching is deliberately loose to tolerate template drift across
// LinkedIn export variants: Name, Full/First/Last Name, Candidate Name…
const NAME_PATTERN = /^(candidate\s*)?(full|first|last)?\s*name$/;

const MATCH_RELEVANT_PATTERNS: RegExp[] = [
  NAME_PATTERN, // candidate name
  /title/, // Current Title, Title1, Company2 Title…
  /company|employer/, // Current Company, Company1, Company2…
  /location/, // Location, Candidate Location
  /yoe|yac|years|experience/, // Total YOE, YAC…
  /skill/, // Skills
  /summary|about|headline|bio/, // profile prose
  /school|degree|major|education|university|college/, // education
  /(start|end)\s*date/, // tenure dates
  /industry/,
];

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, " ");
}

export function isMatchRelevantHeader(header: string): boolean {
  const normalized = normalizeHeader(header);
  if (!normalized) return false;
  return MATCH_RELEVANT_PATTERNS.some((re) => re.test(normalized));
}

export function isNameHeader(header: string): boolean {
  return NAME_PATTERN.test(normalizeHeader(header));
}

export function hasNameColumn(headers: string[]): boolean {
  return headers.some(isNameHeader);
}

/**
 * Returns a filtered COPY of the row containing only match-relevant columns,
 * plus how many columns were dropped. If NOTHING survives the filter (a CSV
 * with entirely unrecognized headers), the original row is returned untouched —
 * billing an odd file beats silently matching against an empty profile.
 */
export function filterRowForMatching(row: Record<string, string>): {
  row: Record<string, string>;
  dropped: number;
} {
  const filtered: Record<string, string> = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(row)) {
    if (isMatchRelevantHeader(key)) {
      filtered[key] = value;
    } else {
      dropped++;
    }
  }
  if (Object.keys(filtered).length === 0) {
    return { row, dropped: 0 };
  }
  return { row: filtered, dropped };
}
