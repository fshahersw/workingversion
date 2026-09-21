// ============================================================================
// US states coverage map for the States & Counties corpus page. Renders the
// 50 states + DC (geoAlbersUsa, so Alaska and Hawaii are inset) shaded by the
// archive's saved-record count per state, clickable to select a state. The
// shading is a count of saved records, never a measure of completeness; the
// archive's known gaps are listed alongside on the page.
// ============================================================================
import { useMemo, useState } from "react";
import { ComposableMap, Geographies, Geography } from "react-simple-maps";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import type { FeatureCollection } from "geojson";

import statesTopo from "us-atlas/states-10m.json";

import type { JsonValue } from "@/lib/archive/policy";

const FIPS_TO_USPS: Record<string, string> = {
  "01": "AL",
  "02": "AK",
  "04": "AZ",
  "05": "AR",
  "06": "CA",
  "08": "CO",
  "09": "CT",
  "10": "DE",
  "11": "DC",
  "12": "FL",
  "13": "GA",
  "15": "HI",
  "16": "ID",
  "17": "IL",
  "18": "IN",
  "19": "IA",
  "20": "KS",
  "21": "KY",
  "22": "LA",
  "23": "ME",
  "24": "MD",
  "25": "MA",
  "26": "MI",
  "27": "MN",
  "28": "MS",
  "29": "MO",
  "30": "MT",
  "31": "NE",
  "32": "NV",
  "33": "NH",
  "34": "NJ",
  "35": "NM",
  "36": "NY",
  "37": "NC",
  "38": "ND",
  "39": "OH",
  "40": "OK",
  "41": "OR",
  "42": "PA",
  "44": "RI",
  "45": "SC",
  "46": "SD",
  "47": "TN",
  "48": "TX",
  "49": "UT",
  "50": "VT",
  "51": "VA",
  "53": "WA",
  "54": "WV",
  "55": "WI",
  "56": "WY",
};

// Convert the states topology to GeoJSON features once (module load, client-only route).
const topo = statesTopo as unknown as Topology;
const STATES = feature(topo, topo.objects.states as GeometryCollection) as FeatureCollection;

// name -> USPS, derived from the topology so we don't hard-code 51 names.
const NAME_TO_USPS: Record<string, string> = {};
for (const f of STATES.features) {
  const code = FIPS_TO_USPS[String(f.id ?? "").padStart(2, "0")];
  const name = (f.properties as { name?: string } | null)?.name;
  if (code && name) NAME_TO_USPS[name.toLowerCase()] = code;
}

const USPS = new Set(Object.values(FIPS_TO_USPS));

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function normStateKey(key: unknown): string | null {
  if (typeof key !== "string") return null;
  const up = key.trim().toUpperCase();
  if (up.length === 2 && USPS.has(up)) return up;
  const byName = NAME_TO_USPS[key.trim().toLowerCase()];
  return byName ?? null;
}

/** Best-effort extraction of per-state counts from whatever shape /api/coverage/state returns. */
function toValueMap(coverage: JsonValue | null): Map<string, number> {
  const m = new Map<string, number>();
  const put = (key: unknown, val: unknown) => {
    const code = normStateKey(key);
    const n = toNum(val);
    if (code && n !== null) m.set(code, Math.max(n, m.get(code) ?? 0));
  };
  if (Array.isArray(coverage)) {
    for (const row of coverage) {
      if (row && typeof row === "object" && !Array.isArray(row)) {
        const o = row as Record<string, unknown>;
        const key =
          o["state"] ?? o["code"] ?? o["usps"] ?? o["abbr"] ?? o["name"] ?? o["jurisdiction"];
        const val =
          o["count"] ??
          o["records"] ??
          o["total"] ??
          o["saved"] ??
          o["n"] ??
          o["value"] ??
          o["documents"];
        put(key, val);
      }
    }
  } else if (coverage && typeof coverage === "object") {
    for (const [k, v] of Object.entries(coverage)) {
      const val =
        v && typeof v === "object" && !Array.isArray(v)
          ? ((v as Record<string, unknown>)["count"] ??
            (v as Record<string, unknown>)["total"] ??
            (v as Record<string, unknown>)["records"])
          : v;
      put(k, val);
    }
  }
  return m;
}

const RAMP = ["#e0e7ff", "#c7d2fe", "#a5b4fc", "#818cf8", "#6366f1", "#4f46e5"]; // indigo 100..600
const NO_DATA = "#f1f5f9"; // slate-100

function colorFor(value: number | undefined, max: number): string {
  if (value === undefined || max <= 0) return NO_DATA;
  const t = Math.min(value / max, 1);
  return RAMP[Math.min(RAMP.length - 1, Math.floor(t * (RAMP.length - 1)))] ?? RAMP[0]!;
}

export function UsCoverageMap({
  coverage,
  loading,
  selected,
  onSelect,
}: {
  coverage: JsonValue | null;
  loading?: boolean;
  selected?: string;
  onSelect: (code: string) => void;
}) {
  const values = useMemo(() => toValueMap(coverage), [coverage]);
  const max = useMemo(() => Math.max(0, ...values.values()), [values]);
  const [hover, setHover] = useState<{ code: string; name: string; value?: number } | null>(null);
  const hasData = values.size > 0;

  if (loading)
    return <div className="h-72 animate-pulse rounded-md border border-slate-200 bg-slate-50" />;

  return (
    <div className="rounded-md border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 pb-2">
        <p className="text-[12px] text-slate-500">
          {hasData
            ? "Shaded by saved records per state. Click a state to see its counties."
            : "Coverage counts unavailable; the map is for selection. Click a state to see its counties."}
        </p>
        <div className="min-h-[16px] text-[12px] font-medium text-slate-700">
          {hover ? (
            <>
              {hover.name}
              {hover.value !== undefined ? (
                <span className="ml-2 tabular-nums text-slate-500">
                  {hover.value.toLocaleString("en-US")} records
                </span>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      <ComposableMap projection="geoAlbersUsa" width={975} height={560} className="h-auto w-full">
        <Geographies geography={STATES}>
          {({ geographies }) =>
            geographies.map((geo) => {
              const fips = String(geo.id ?? "").padStart(2, "0");
              const code = FIPS_TO_USPS[fips];
              const name = (geo.properties as { name?: string } | null)?.name ?? code ?? fips;
              const value = code ? values.get(code) : undefined;
              const isSel = !!code && code === selected;
              const isHover = !!code && hover?.code === code;
              return (
                <Geography
                  key={geo.rsmKey}
                  geography={geo}
                  onClick={() => code && onSelect(code)}
                  onMouseEnter={() => code && setHover({ code, name, value })}
                  onMouseLeave={() => setHover(null)}
                  fill={isHover ? "#4f46e5" : colorFor(value, max)}
                  stroke={isSel ? "#4338ca" : "#ffffff"}
                  strokeWidth={isSel ? 1.75 : 0.5}
                  style={{ outline: "none", cursor: code ? "pointer" : "default" }}
                />
              );
            })
          }
        </Geographies>
      </ComposableMap>
      {hasData && (
        <div className="flex items-center gap-2 px-1 pt-1 text-[11px] text-slate-500">
          <span>fewer</span>
          {RAMP.map((c) => (
            <span key={c} className="h-3 w-6 rounded-sm" style={{ backgroundColor: c }} />
          ))}
          <span>more</span>
          <span className="ml-1">· max {max.toLocaleString("en-US")}</span>
        </div>
      )}
    </div>
  );
}
