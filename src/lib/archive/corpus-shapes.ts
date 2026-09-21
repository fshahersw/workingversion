import type { JsonValue } from "./policy";

export type JsonObject = { [key: string]: JsonValue };

export type StateSelection = {
  code: string;
  name: string;
};

export type StateCoverageValue = StateSelection & {
  total: number;
};

export const STATE_NAME_BY_CODE: Readonly<Record<string, string>> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "District of Columbia",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
};

const STATE_CODE_BY_NAME = new Map(
  Object.entries(STATE_NAME_BY_CODE).map(([code, name]) => [name.toLowerCase(), code]),
);

export function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

export function objectArray(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.map(asObject).filter((row): row is JsonObject => row !== null)
    : [];
}

export function textValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
}

export function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

export function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function firstText(row: JsonObject, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = textValue(row[key]);
    if (value) return value;
  }
  return null;
}

export function firstNumber(row: JsonObject, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = numberValue(row[key]);
    if (value !== null) return value;
  }
  return null;
}

export function rowsAt(value: unknown, ...keys: string[]): JsonObject[] {
  const root = asObject(value);
  if (!root) return objectArray(value);
  for (const key of keys) {
    const rows = objectArray(root[key]);
    if (rows.length > 0 || Array.isArray(root[key])) return rows;
  }
  return [];
}

export function normalizeStateCode(value: unknown): string | null {
  const key = textValue(value);
  if (!key) return null;
  const upper = key.toUpperCase();
  if (STATE_NAME_BY_CODE[upper]) return upper;
  return STATE_CODE_BY_NAME.get(key.toLowerCase()) ?? null;
}

export function stateSelection(value: unknown): StateSelection | null {
  const code = normalizeStateCode(value);
  const name = code ? STATE_NAME_BY_CODE[code] : null;
  return code && name ? { code, name } : null;
}

/**
 * `/api/explore` is the all-jurisdiction count feed. `/api/coverage/state`
 * returns one state and cannot shade a national map.
 */
export function stateCoverageValues(value: unknown): StateCoverageValue[] {
  const root = asObject(value);
  const rows = root ? objectArray(root["jurisdictions"]) : objectArray(value);
  const byCode = new Map<string, StateCoverageValue>();

  for (const row of rows) {
    const selection = stateSelection(row["state"] ?? row["abbr"] ?? row["label"] ?? row["name"]);
    const total = firstNumber(row, "total", "count", "records");
    if (!selection || total === null) continue;
    const previous = byCode.get(selection.code);
    if (!previous || total > previous.total) byCode.set(selection.code, { ...selection, total });
  }

  return [...byCode.values()];
}

export function countBasis(value: unknown): string | null {
  return firstText(asObject(value) ?? {}, "count_basis", "qualification");
}

// Upstream data-vendor / tooling names are neutralized in any archive-provided
// text shown in the UI, so the corpus reads as the firm's own Legal Archive.
// Official government sources (eCFR, GovInfo, Federal Register, JPML, US Code)
// are deliberately left intact -- those are the authoritative law, not vendors.
const SOURCE_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/open[\s_-]?us[\s_-]?law(?:[\s_-]*v?\d[\d.]*)?/gi, "public law"],
  [/courtlistener[\s_/-]*recap/gi, "docket data"],
  [/courtlistener/gi, "docket data"],
  [/\bRECAP\b/g, "docket data"],
  [/docketbird/gi, "docket data"],
  [/trellis(?:\.law)?/gi, "county profiles"],
  [/firecrawl/gi, "web capture"],
  [/sw[\s_-]?bulk[\w/-]*/gi, "firm dataset"],
  [/private firm dataset/gi, "firm dataset"],
];

/** Remove upstream vendor/tooling names from a display string; returns null if empty after scrubbing. */
export function scrubSources(value: unknown): string | null {
  const text = textValue(value);
  if (!text) return null;
  let out = text;
  for (const [pattern, replacement] of SOURCE_REPLACEMENTS) out = out.replace(pattern, replacement);
  const cleaned = out.replace(/\s{2,}/g, " ").trim();
  return cleaned ? cleaned : null;
}
