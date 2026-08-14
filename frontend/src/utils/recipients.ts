import Papa from "papaparse";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface RecipientParseResult {
  valid: string[];
  invalidCount: number;
  duplicateCount: number;
}

// The single place recipient candidates (typed text or a parsed CSV) get
// turned into what the backend contract expects: a deduplicated array of
// lowercased addresses. Invalid-looking addresses and duplicates are
// dropped rather than rejecting the whole batch — counts are returned so
// the UI can tell the user what was removed.
export function parseRecipients(candidates: string[]): RecipientParseResult {
  const seen = new Set<string>();
  const valid: string[] = [];
  let invalidCount = 0;
  let duplicateCount = 0;

  for (const raw of candidates) {
    const email = raw.trim().toLowerCase();
    if (!email) {
      continue;
    }
    if (!EMAIL_REGEX.test(email)) {
      invalidCount++;
      continue;
    }
    if (seen.has(email)) {
      duplicateCount++;
      continue;
    }
    seen.add(email);
    valid.push(email);
  }

  return { valid, invalidCount, duplicateCount };
}

export function splitRecipientText(raw: string): string[] {
  return raw.split(/[\s,]+/);
}

// Supports both a CSV with a header row containing an "email" column, and a
// plain one-address-per-line list (.txt, or a headerless .csv) — whichever
// doesn't match a header, every cell is treated as a candidate address.
export function extractEmailsFromCsv(csvText: string): string[] {
  const result = Papa.parse<string[]>(csvText.trim(), { skipEmptyLines: true });
  const rows = result.data;
  if (rows.length === 0) {
    return [];
  }

  const header = rows[0]!.map((cell) => cell.trim().toLowerCase());
  const emailColumnIndex = header.indexOf("email");

  if (emailColumnIndex !== -1) {
    return rows.slice(1).map((row) => row[emailColumnIndex] ?? "");
  }

  return rows.flat();
}
