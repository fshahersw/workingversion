// Court reference data for the matters workspace. Court ids follow the
// CourtListener / DocketBird convention (state code + district letters + "d",
// e.g. "njd", "cand", "paed"); "jpml" is the Judicial Panel on Multidistrict
// Litigation. State-court ids are the handful DocketBird emits for the firm's
// coordinated state proceedings. Unknown ids fall back to the raw id so the UI
// never shows a blank.

export type CourtKind = "district" | "jpml" | "state" | "appellate" | "unknown";

export type CourtInfo = {
  id: string;
  /** Full name, e.g. "United States District Court for the District of New Jersey". */
  name: string;
  /** Common display name, e.g. "District of New Jersey". */
  label: string;
  /** Bluebook-style abbreviation, e.g. "D.N.J.", "N.D. Cal.", "J.P.M.L.". */
  short: string;
  /** Two-letter state / territory code, or null for national bodies. */
  state: string | null;
  kind: CourtKind;
  /** Federal circuit, e.g. "3d Cir.", or null. */
  circuit: string | null;
};

const STATE_NAMES: Record<string, string> = {
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
  GU: "Guam",
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
  MP: "Northern Mariana Islands",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  PR: "Puerto Rico",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VI: "Virgin Islands",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
};

// Bluebook T10 abbreviations.
const STATE_ABBR: Record<string, string> = {
  AL: "Ala.",
  AK: "Alaska",
  AZ: "Ariz.",
  AR: "Ark.",
  CA: "Cal.",
  CO: "Colo.",
  CT: "Conn.",
  DE: "Del.",
  DC: "D.C.",
  FL: "Fla.",
  GA: "Ga.",
  GU: "Guam",
  HI: "Haw.",
  ID: "Idaho",
  IL: "Ill.",
  IN: "Ind.",
  IA: "Iowa",
  KS: "Kan.",
  KY: "Ky.",
  LA: "La.",
  ME: "Me.",
  MD: "Md.",
  MA: "Mass.",
  MI: "Mich.",
  MN: "Minn.",
  MS: "Miss.",
  MO: "Mo.",
  MT: "Mont.",
  NE: "Neb.",
  NV: "Nev.",
  NH: "N.H.",
  NJ: "N.J.",
  NM: "N.M.",
  NY: "N.Y.",
  NC: "N.C.",
  ND: "N.D.",
  MP: "N. Mar. I.",
  OH: "Ohio",
  OK: "Okla.",
  OR: "Or.",
  PA: "Pa.",
  PR: "P.R.",
  RI: "R.I.",
  SC: "S.C.",
  SD: "S.D.",
  TN: "Tenn.",
  TX: "Tex.",
  UT: "Utah",
  VT: "Vt.",
  VI: "V.I.",
  VA: "Va.",
  WA: "Wash.",
  WV: "W. Va.",
  WI: "Wis.",
  WY: "Wyo.",
};

const CIRCUIT_BY_STATE: Record<string, string> = {
  ME: "1st",
  MA: "1st",
  NH: "1st",
  RI: "1st",
  PR: "1st",
  CT: "2d",
  NY: "2d",
  VT: "2d",
  DE: "3d",
  NJ: "3d",
  PA: "3d",
  VI: "3d",
  MD: "4th",
  NC: "4th",
  SC: "4th",
  VA: "4th",
  WV: "4th",
  LA: "5th",
  MS: "5th",
  TX: "5th",
  KY: "6th",
  MI: "6th",
  OH: "6th",
  TN: "6th",
  IL: "7th",
  IN: "7th",
  WI: "7th",
  AR: "8th",
  IA: "8th",
  MN: "8th",
  MO: "8th",
  NE: "8th",
  ND: "8th",
  SD: "8th",
  AK: "9th",
  AZ: "9th",
  CA: "9th",
  HI: "9th",
  ID: "9th",
  MT: "9th",
  NV: "9th",
  OR: "9th",
  WA: "9th",
  GU: "9th",
  MP: "9th",
  CO: "10th",
  KS: "10th",
  NM: "10th",
  OK: "10th",
  UT: "10th",
  WY: "10th",
  AL: "11th",
  FL: "11th",
  GA: "11th",
  DC: "D.C.",
};

type DivisionCode = "N" | "S" | "E" | "W" | "M" | "C" | null;
const DIVISION_NAME: Record<Exclude<DivisionCode, null>, string> = {
  N: "Northern",
  S: "Southern",
  E: "Eastern",
  W: "Western",
  M: "Middle",
  C: "Central",
};

// id -> [state, division]
const DISTRICTS: Record<string, [string, DivisionCode]> = {
  almd: ["AL", "M"],
  alnd: ["AL", "N"],
  alsd: ["AL", "S"],
  akd: ["AK", null],
  azd: ["AZ", null],
  ared: ["AR", "E"],
  arwd: ["AR", "W"],
  cacd: ["CA", "C"],
  caed: ["CA", "E"],
  cand: ["CA", "N"],
  casd: ["CA", "S"],
  cod: ["CO", null],
  ctd: ["CT", null],
  ded: ["DE", null],
  dcd: ["DC", null],
  flmd: ["FL", "M"],
  flnd: ["FL", "N"],
  flsd: ["FL", "S"],
  gamd: ["GA", "M"],
  gand: ["GA", "N"],
  gasd: ["GA", "S"],
  gud: ["GU", null],
  hid: ["HI", null],
  idd: ["ID", null],
  ilcd: ["IL", "C"],
  ilnd: ["IL", "N"],
  ilsd: ["IL", "S"],
  innd: ["IN", "N"],
  insd: ["IN", "S"],
  iand: ["IA", "N"],
  iasd: ["IA", "S"],
  ksd: ["KS", null],
  kyed: ["KY", "E"],
  kywd: ["KY", "W"],
  laed: ["LA", "E"],
  lamd: ["LA", "M"],
  lawd: ["LA", "W"],
  med: ["ME", null],
  mdd: ["MD", null],
  mad: ["MA", null],
  mied: ["MI", "E"],
  miwd: ["MI", "W"],
  mnd: ["MN", null],
  msnd: ["MS", "N"],
  mssd: ["MS", "S"],
  moed: ["MO", "E"],
  mowd: ["MO", "W"],
  mtd: ["MT", null],
  ned: ["NE", null],
  nvd: ["NV", null],
  nhd: ["NH", null],
  njd: ["NJ", null],
  nmd: ["NM", null],
  nyed: ["NY", "E"],
  nynd: ["NY", "N"],
  nysd: ["NY", "S"],
  nywd: ["NY", "W"],
  nced: ["NC", "E"],
  ncmd: ["NC", "M"],
  ncwd: ["NC", "W"],
  ndd: ["ND", null],
  nmid: ["MP", null],
  ohnd: ["OH", "N"],
  ohsd: ["OH", "S"],
  oked: ["OK", "E"],
  oknd: ["OK", "N"],
  okwd: ["OK", "W"],
  ord: ["OR", null],
  paed: ["PA", "E"],
  pamd: ["PA", "M"],
  pawd: ["PA", "W"],
  prd: ["PR", null],
  rid: ["RI", null],
  scd: ["SC", null],
  sdd: ["SD", null],
  tned: ["TN", "E"],
  tnmd: ["TN", "M"],
  tnwd: ["TN", "W"],
  txed: ["TX", "E"],
  txnd: ["TX", "N"],
  txsd: ["TX", "S"],
  txwd: ["TX", "W"],
  utd: ["UT", null],
  vtd: ["VT", null],
  vid: ["VI", null],
  vaed: ["VA", "E"],
  vawd: ["VA", "W"],
  waed: ["WA", "E"],
  wawd: ["WA", "W"],
  wvnd: ["WV", "N"],
  wvsd: ["WV", "S"],
  wied: ["WI", "E"],
  wiwd: ["WI", "W"],
  wyd: ["WY", null],
};

// State-court ids DocketBird emits for the firm's coordinated proceedings.
const STATE_COURTS: Record<string, { label: string; name: string; short: string; state: string }> =
  {
    lasu: {
      label: "Los Angeles County Superior Court",
      name: "Superior Court of California, County of Los Angeles",
      short: "L.A. Super. Ct.",
      state: "CA",
    },
    "uc-ca-superct": {
      label: "California Superior Court",
      name: "Superior Court of California",
      short: "Cal. Super. Ct.",
      state: "CA",
    },
    nynew: {
      label: "New York County Supreme Court",
      name: "Supreme Court of the State of New York, New York County",
      short: "N.Y. Sup. Ct.",
      state: "NY",
    },
  };

const INITIALS_ONLY = /^(?:[A-Z]\.)+$/;

function bluebookDistrict(state: string, division: DivisionCode): string {
  const abbr = STATE_ABBR[state] ?? state;
  const prefix = division ? `${division}.D.` : "D.";
  // "D.N.J." and "S.D.N.Y." close up; "D. Mass." and "N.D. Cal." take a space.
  return INITIALS_ONLY.test(abbr) ? `${prefix}${abbr}` : `${prefix} ${abbr}`;
}

const cache = new Map<string, CourtInfo>();

export function courtInfo(rawId: string | null | undefined): CourtInfo {
  const id = (rawId ?? "").trim().toLowerCase();
  const hit = cache.get(id);
  if (hit) return hit;

  let info: CourtInfo;
  if (!id) {
    info = {
      id: "",
      name: "Unknown court",
      label: "Unknown court",
      short: "—",
      state: null,
      kind: "unknown",
      circuit: null,
    };
  } else if (id === "jpml") {
    info = {
      id,
      name: "United States Judicial Panel on Multidistrict Litigation",
      label: "Judicial Panel on Multidistrict Litigation",
      short: "J.P.M.L.",
      state: null,
      kind: "jpml",
      circuit: null,
    };
  } else if (DISTRICTS[id]) {
    const [state, division] = DISTRICTS[id];
    const stateName = STATE_NAMES[state] ?? state;
    const label = division
      ? `${DIVISION_NAME[division]} District of ${stateName}`
      : `District of ${stateName}`;
    const circuit = CIRCUIT_BY_STATE[state];
    info = {
      id,
      name: `United States District Court for the ${label}`,
      label,
      short: bluebookDistrict(state, division),
      state,
      kind: "district",
      circuit: circuit ? (circuit === "D.C." ? "D.C. Cir." : `${circuit} Cir.`) : null,
    };
  } else if (STATE_COURTS[id]) {
    const s = STATE_COURTS[id];
    info = {
      id,
      name: s.name,
      label: s.label,
      short: s.short,
      state: s.state,
      kind: "state",
      circuit: null,
    };
  } else {
    const upper = id.toUpperCase();
    info = {
      id,
      name: upper,
      label: upper,
      short: upper,
      state: null,
      kind: "unknown",
      circuit: null,
    };
  }
  cache.set(id, info);
  return info;
}

export function courtStateName(state: string | null): string | null {
  return state ? (STATE_NAMES[state] ?? state) : null;
}

// Stable keys of the firm's court reference library (reference.courts):
// "FD:<id>" federal district, "FS:jpml" the Panel, "ST:<st>_state" statewide
// state-court collections, "LC:<...>" selected local trial courts. DocketBird
// state ids map onto the statewide collection (plus the local court where one
// was collected) so a state docket still finds its rules and forms.
const STATE_REFERENCE_KEYS: Record<string, string[]> = {
  lasu: ["LC:ca_los_angeles", "ST:ca_state"],
  "uc-ca-superct": ["ST:ca_state"],
  nynew: ["LC:ny_new_york", "ST:ny_state"],
};

/** Reference-library keys for a docket's court, most specific first. */
export function courtReferenceKeys(rawId: string | null | undefined): string[] {
  const id = (rawId ?? "").trim().toLowerCase();
  if (!id) return [];
  if (id === "jpml") return ["FS:jpml"];
  if (DISTRICTS[id]) return [`FD:${id}`];
  if (STATE_REFERENCE_KEYS[id]) return STATE_REFERENCE_KEYS[id];
  return [];
}
