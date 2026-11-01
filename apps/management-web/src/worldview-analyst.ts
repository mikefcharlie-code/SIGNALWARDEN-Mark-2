import type {
  Annotation,
  GeoPoint,
  ProviderResult,
  WorldObservation,
} from "./worldview-core";
import { LAYER_IDS, haversineKm, validateObservation } from "./worldview-core";

export interface AnalystContext {
  records: WorldObservation[];
  annotations: Annotation[];
  providers: Record<string, ProviderResult>;
  passes: Array<{ [key: string]: unknown }>;
  platformEvidence: Array<{
    id: string;
    entityId: string;
    subjectId: string;
    sourceId: string;
    field: string;
    value: unknown;
    observedAt: string | null;
    trust: string;
    freshness: string;
    synthetic: boolean;
  }>;
  platformVerified: boolean;
  center: GeoPoint;
  radiusKm: number;
  visibleLayers: string[];
  sceneName: string;
  now: number;
}
export interface AnalystScope {
  layers?: string[];
  from?: string;
  to?: string;
  selectedId?: string;
}
export interface AnalystCitation {
  id: string;
  recordId: string;
  source: string;
  observedAt: string;
  freshness: string;
  synthetic: boolean;
  detail: string;
}
export interface AnalystClaim {
  id: string;
  text: string;
  citationIds: string[];
}
export interface AnalystAnswer {
  question: string;
  tool: string;
  claims: AnalystClaim[];
  citations: AnalystCitation[];
  warnings: string[];
  abstained: boolean;
  engine: string;
  generatedAt: string;
}
export const ANALYST_TOOLS = [
  "summary",
  "compare",
  "history",
  "quality",
  "briefing",
  "platform",
  "pass",
] as const;
const ENGINE = "deterministic";
const MAX_EVIDENCE = 80;
const text = (s: unknown, max = 2000) =>
  String(s ?? "")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, max);
const date = (s: unknown) =>
  typeof s === "string" && Number.isFinite(Date.parse(s)) ? Date.parse(s) : NaN;
const iso = (s: unknown) =>
  Number.isFinite(date(s)) ? new Date(date(s)).toISOString() : "unknown";
const value = (v: unknown, max = 1500) => {
  try {
    return text(typeof v === "string" ? v : JSON.stringify(v), max);
  } catch {
    return "[unserializable]";
  }
};
const validLayer = (l: string) => (LAYER_IDS as readonly string[]).includes(l);
const synthetic = (r: WorldObservation) =>
  r.freshness === "synthetic" ||
  r.properties?.demo === true ||
  /synthetic|demo/i.test(`${r.label} ${r.source}`);
const UNSAFE =
  /\b(?:arm|disarm|takeoff|take off|land aircraft|fly aircraft|flight command|autonomous engagement|attack|engage|weapon|weapons|missile|missiles|firing|fire at|target|targets|targeting|stalk|stalking|recognize person|recognise person|facial recognition|person recognition|identify (?:a |the )?(?:person|people|owner)|track (?:a |the )?(?:person|people)|owners?|registration|callsign|owner lookup|registration lookup|rank contacts|rank aircraft|execute|shell|sudo|curl|wget|sql|select .+ from|delete from)\b|https?:\/\//i;
const aliases: Record<string, string> = {
  aircraft: "aircraft",
  airplane: "aircraft",
  airplanes: "aircraft",
  flights: "aircraft",
  vessel: "vessels",
  vessels: "vessels",
  ship: "vessels",
  ships: "vessels",
  satellite: "satellites",
  satellites: "satellites",
  earthquake: "earthquakes",
  earthquakes: "earthquakes",
  quake: "earthquakes",
  quakes: "earthquakes",
  fire: "fires",
  fires: "fires",
  weather: "weather",
  forecast: "weather",
  traffic: "traffic",
  camera: "cameras",
  cameras: "cameras",
  alpr: "alpr",
};
function mentionedLayers(q: string): string[] {
  return [
    ...new Set(
      (q.toLowerCase().match(/\b[a-z]+\b/g) ?? []).flatMap((w) =>
        aliases[w] ? [aliases[w]] : [],
      ),
    ),
  ];
}
function toolFor(q: string): (typeof ANALYST_TOOLS)[number] | null {
  if (/\b(compare|versus|vs|difference|between)\b/i.test(q)) return "compare";
  if (
    /\b(history|historical|timeline|over time|trend|changed|change)\b/i.test(q)
  )
    return "history";
  if (/\b(platform|telemetry|px4|ardupilot)\b/i.test(q)) return "platform";
  if (
    /\b(quality|confidence|trust|freshness|fresh|stale|sources?|conflicts?|gaps?|coverage|offline|failing)\b/i.test(
      q,
    )
  )
    return "quality";
  if (/\b(briefing|brief|situation|report)\b/i.test(q)) return "briefing";
  if (/\b(passes?|orbital|orbit)\b/i.test(q)) return "pass";
  if (/\b(summary|summarize|overview|how many|count)\b/i.test(q))
    return "summary";
  if (
    /\b(what|show|list|temperature|magnitude|depth|wind)\b/i.test(q) &&
    mentionedLayers(q).length
  )
    return "summary";
  return null;
}
function effectiveFreshness(r: WorldObservation, c: AnalystContext): string {
  if (synthetic(r)) return "synthetic";
  if (!Number.isFinite(date(r.observedAt))) return "unknown";
  if (date(r.observedAt) > c.now + 60_000) return "future";
  if (r.stale || r.freshness === "stale") return "stale";
  if (r.freshness !== "fresh") return r.freshness ?? "unknown";
  const age = c.now - date(r.observedAt);
  if (age > (r.layer === "aircraft" ? 120_000 : 86_400_000)) return "stale";
  if (
    r.layer === "weather" &&
    Number.isFinite(date(r.properties?.validTo)) &&
    date(r.properties?.validTo) < c.now
  )
    return "stale";
  const provider = Object.values(c.providers).find((p) =>
    p.observations.some(
      (o) =>
        o.id === r.id && o.source === r.source && o.observedAt === r.observedAt,
    ),
  );
  if (!provider) return "unverified — no matching connector snapshot";
  if (provider.error || provider.freshness !== "fresh")
    return "stale — provider failed/offline";
  const checked = date(provider.retrievedAt);
  if (
    !Number.isFinite(checked) ||
    checked > c.now + 60_000 ||
    c.now - checked > (r.layer === "aircraft" ? 120_000 : 3_600_000)
  )
    return "stale — connector check expired";
  return "fresh";
}
function recordCitation(
  r: WorldObservation,
  c: AnalystContext,
  index: number,
): AnalystCitation {
  return {
    id: `obs-${index + 1}`,
    recordId: r.id,
    source: r.source || "unknown source",
    observedAt: iso(r.observedAt),
    freshness: effectiveFreshness(r, c),
    synthetic: synthetic(r),
    detail: value(
      {
        label: r.label,
        layer: r.layer,
        point: r.point,
        properties: r.properties ?? {},
      },
      6000,
    ),
  };
}
function latest(records: WorldObservation[]) {
  const out = new Map<string, WorldObservation>();
  for (const r of records) {
    const key = `${r.id}|${r.source}`;
    if (!out.has(key) || date(r.observedAt) >= date(out.get(key)!.observedAt))
      out.set(key, r);
  }
  return [...out.values()];
}
export function answerQuestion(
  question: string,
  c: AnalystContext,
  scope: AnalystScope = {},
): AnalystAnswer {
  const q = text(question),
    tool = toolFor(q);
  const a: AnalystAnswer = {
    question: q,
    tool: tool ?? "unsupported",
    claims: [],
    citations: [],
    warnings: [
      "Advisory snapshot only. Missing observations do not establish absence; source declarations are not independent verification.",
    ],
    abstained: false,
    engine: ENGINE,
    generatedAt: new Date(c.now).toISOString(),
  };
  const abstain = (reason: string) => {
    a.abstained = true;
    a.warnings.push(reason);
    return a;
  };
  if (UNSAFE.test(q))
    return abstain(
      "Operational, targeting, identity, surveillance enrichment and arbitrary execution requests are unsupported. No action was taken.",
    );
  if (!q || !tool)
    return abstain(
      "Unsupported question. Ask for a loaded-layer summary, comparison, observation history, source quality, platform evidence, briefing or calculated passes.",
    );
  const namedLayer =
    /\blayer\s+([a-z][a-z0-9_-]*)\b|\b([a-z][a-z0-9_-]*)\s+layer\b/i.exec(q);
  if (namedLayer) {
    const name = (namedLayer[1] ?? namedLayer[2]).toLowerCase();
    if (
      !["visible", "loaded", "selected", "all", "each"].includes(name) &&
      !validLayer(aliases[name] ?? name)
    )
      return abstain(
        `Unknown layer: ${name}. No substitute layer was queried.`,
      );
  }
  const wanted = scope.layers ?? c.visibleLayers;
  if (wanted.some((l) => !validLayer(l)))
    return abstain(
      `Unknown layer: ${wanted.filter((l) => !validLayer(l)).join(", ")}.`,
    );
  const from = scope.from ? date(scope.from) : -Infinity,
    to = scope.to ? date(scope.to) : Infinity;
  if (
    (scope.from && !Number.isFinite(from)) ||
    (scope.to && !Number.isFinite(to)) ||
    from > to
  )
    return abstain("Invalid time scope. Supply an ordered from/to interval.");
  let requested = mentionedLayers(q);
  if (tool === "summary" && /\b(forecast|temperature|wind)\b/i.test(q))
    requested = ["weather"];
  const inTime = (at: unknown) =>
    Number.isFinite(date(at)) && date(at) >= from && date(at) <= to;
  let records = c.records
    .filter(validateObservation)
    .filter(
      (r) =>
        wanted.includes(r.layer) &&
        (!requested.length || requested.includes(r.layer)) &&
        (!scope.selectedId || r.id === scope.selectedId) &&
        inTime(r.observedAt) &&
        haversineKm(c.center, r.point) <= Math.max(0, c.radiusKm),
    );
  if (records.length > MAX_EVIDENCE)
    a.warnings.push(
      `Analysis is limited to the most recent ${MAX_EVIDENCE} matching loaded samples; counts describe this bounded evidence set, not global coverage.`,
    );
  records = records
    .sort((x, y) => date(y.observedAt) - date(x.observedAt))
    .slice(0, MAX_EVIDENCE);
  const citations = new Map<WorldObservation, AnalystCitation>(
    records.map((r, i) => [r, recordCitation(r, c, i)]),
  );
  const claim = (s: string, evidence: AnalystCitation[]) => {
    if (!evidence.length || a.claims.length >= 80) return;
    const ids = [...new Set(evidence.map((e) => e.id))];
    for (const e of evidence)
      if (!a.citations.some((row) => row.id === e.id)) a.citations.push(e);
    a.claims.push({
      id: `claim-${a.claims.length + 1}`,
      text: text(s),
      citationIds: ids,
    });
  };
  const rc = (r: WorldObservation) => citations.get(r)!;
  const scopeLabel =
    c.radiusKm === Infinity
      ? "global loaded scope"
      : `${c.radiusKm} km around the scene center`;
  a.warnings.push(
    `Scope: ${c.sceneName}; ${scopeLabel}; ${scope.from ?? "earliest loaded"} to ${scope.to ?? "latest loaded"}.`,
  );
  if (records.some(synthetic))
    a.warnings.push(
      "SYNTHETIC demo/replay evidence is present; it is not physical-world evidence or a live feed.",
    );
  if (records.some((r) => effectiveFreshness(r, c) !== "fresh"))
    a.warnings.push(
      "Non-fresh, unknown, synthetic, derived or unverified evidence is present. Original timestamps and per-record freshness are retained.",
    );
  for (const p of Object.values(c.providers)) {
    if (p.error || p.freshness !== "fresh")
      a.warnings.push(
        `Provider ${p.providerId}: ${p.error ? "failed/offline" : p.freshness}; checked ${iso(p.retrievedAt)}. No live-data conclusion is supported by this status.`,
      );
  }
  // Conflicts compare the same reported entity/time, never infer identities across sources.
  const groups = new Map<string, WorldObservation[]>();
  for (const r of records) {
    const key = `${r.properties?.entityId ?? r.id}|${r.observedAt}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const [key, rows] of groups) {
    if (rows.length < 2) continue;
    const fields = [
      ...new Set(rows.flatMap((r) => Object.keys(r.properties ?? {}))),
    ].filter((k) => k !== "entityId");
    for (const field of fields) {
      const supplied = rows.filter((r) => r.properties?.[field] !== undefined);
      if (new Set(supplied.map((r) => value(r.properties?.[field]))).size > 1) {
        a.warnings.push(
          `Conflicting ${field} reports for ${key}; no source was chosen as truth.`,
        );
        claim(
          `Conflict in ${field}: ${supplied.map((r) => `${r.source} reports ${value(r.properties?.[field], 300)}`).join("; ")}.`,
          supplied.map(rc),
        );
      }
    }
  }
  const current = latest(records);
  const describe = (r: WorldObservation) =>
    `${r.layer} · ${r.label} · ${r.observedAt} · ${effectiveFreshness(r, c)}${r.properties && Object.keys(r.properties).length ? ` · reported fields ${value(r.properties)}` : ""}`;
  if (tool === "summary" || tool === "briefing") {
    if (!current.length)
      return abstain(
        "No loaded observations match the region/time/layer/selection scope. No values were inferred.",
      );
    const valuesRequested =
      /\b(temperature|temp|forecast|magnitude|depth|wind|details?)\b/i.test(q);
    if (valuesRequested) {
      let count = 0;
      const fieldKeys = /\b(temperature|temp)\b/i.test(q)
        ? ["temperature"]
        : /\bforecast\b/i.test(q)
          ? ["forecast", "shortForecast"]
          : /\bwind\b/i.test(q)
            ? ["windSpeed", "windDirection", "wind"]
            : /\bmagnitude\b/i.test(q)
              ? ["magnitude"]
              : /\bdepth\b/i.test(q)
                ? ["depth", "depthKm"]
                : [];
      for (const r of current)
        if (
          r.properties &&
          (fieldKeys.length
            ? fieldKeys.some(
                (k) =>
                  r.properties?.[k] !== undefined && r.properties?.[k] !== null,
              )
            : Object.keys(r.properties).some(
                (k) => !["demo", "readOnly"].includes(k),
              ))
        ) {
          claim(describe(r), [rc(r)]);
          count++;
        }
      if (!count)
        return abstain(
          "No requested measurement or forecast fields exist in the loaded records. Synthetic markers are not measurements.",
        );
    } else {
      for (const layer of [...new Set(current.map((r) => r.layer))]) {
        const rows = current.filter((r) => r.layer === layer);
        claim(
          `${layer}: ${rows.length} latest reported records in ${scopeLabel}; freshness classes: ${[...new Set(rows.map((r) => effectiveFreshness(r, c)))].join(", ")}.`,
          rows.map(rc),
        );
      }
    }
    if (tool === "briefing") {
      for (const r of current.slice(0, 8)) claim(describe(r), [rc(r)]);
      if (c.annotations.length)
        a.warnings.push(
          `Operator notes — unverified context, NOT evidence: ${c.annotations
            .slice(0, 5)
            .map((n) => `“${text(n.text, 500)}”`)
            .join("; ")}`,
        );
      a.warnings.push(
        "This is an advisory briefing draft. Notes and model outputs are separate from verified input evidence.",
      );
    }
  } else if (tool === "compare") {
    const layerNames = requested.length
      ? requested
      : [...new Set(current.map((r) => r.layer))];
    const comparePasses = /\bpasses?\b/i.test(q);
    const comparisonPasses = comparePasses
      ? c.passes.filter((p) => inTime(p.rise)).slice(0, 20)
      : [];
    if (layerNames.length + (comparePasses ? 1 : 0) < 2)
      return abstain(
        "Compare requires at least two named available layers or calculated passes in the scoped evidence.",
      );
    if (comparePasses) {
      if (!comparisonPasses.length)
        a.warnings.push(
          "No calculated satellite passes match the time scope; no pass timing was invented.",
        );
      for (const [i, p] of comparisonPasses.entries())
        claim(
          `Pass comparison: rise ${iso(p.rise)}, peak ${iso(p.peak)}, set ${iso(p.set)}. Derived from TLE geometry, not observed sightings; visibility not assessed.`,
          [
            {
              id: `compare-pass-${i + 1}`,
              recordId: `pass-${i + 1}`,
              source: "User TLE · local SGP4 geometry",
              observedAt: iso(p.calculatedAt ?? p.rise),
              freshness: "fallback — derived geometric estimate",
              synthetic: false,
              detail: value(
                {
                  ...p,
                  caveat:
                    "Derived orbital geometry; visibility not assessed; TLE epoch not retained",
                },
                6000,
              ),
            },
          ],
        );
    }
    for (const layer of layerNames) {
      const rows = current.filter((r) => r.layer === layer);
      if (!rows.length)
        a.warnings.push(
          `No ${layer} evidence in the requested scope; no comparison value was invented.`,
        );
      else {
        claim(
          `${layer}: ${rows.length} latest scoped records; reported times ${iso(rows[rows.length - 1].observedAt)} to ${iso(rows[0].observedAt)}; classes ${[...new Set(rows.map((r) => effectiveFreshness(r, c)))].join(", ")}.`,
          rows.map(rc),
        );
        for (const r of rows.slice(0, 2)) claim(describe(r), [rc(r)]);
      }
    }
    if (
      layerNames.filter((l) => current.some((r) => r.layer === l)).length +
        (comparisonPasses.length ? 1 : 0) <
      2
    )
      a.abstained = true;
    a.warnings.push(
      "Comparison is descriptive only: different source types/issuance times are not interchangeable and temporal/spatial coincidence does not establish causation.",
    );
  } else if (tool === "history") {
    const rows = [...records].sort(
      (x, y) => date(x.observedAt) - date(y.observedAt),
    );
    if (!rows.length)
      return abstain(
        "No loaded observation history matches the scope. History is not fetched or reconstructed.",
      );
    claim(
      `History contains ${rows.length} loaded samples, from ${iso(rows[0].observedAt)} to ${iso(rows[rows.length - 1].observedAt)}.`,
      rows.map(rc),
    );
    for (const r of rows.slice(0, 20)) claim(describe(r), [rc(r)]);
    a.warnings.push(
      "Only loaded session samples are compared; missing intervals do not establish a path, continuity, identity or behavior.",
    );
  } else if (tool === "quality") {
    if (records.length)
      claim(
        `Data quality: ${records.length} scoped samples; ${records.filter((r) => effectiveFreshness(r, c) !== "fresh").length} are not confirmed fresh connector records.`,
        records.map(rc),
      );
    for (const p of Object.values(c.providers).slice(0, 12)) {
      const pc: AnalystCitation = {
        id: `provider-${a.citations.length}`,
        recordId: p.providerId,
        source: p.providerId,
        observedAt: iso(p.retrievedAt),
        freshness: p.error ? "failed" : p.freshness,
        synthetic: false,
        detail: value({
          status: p.freshness,
          error: p.error ?? null,
          returnedRecords: p.observations.length,
          retrievedAt: p.retrievedAt,
        }),
      };
      claim(
        `Connector ${p.providerId}: ${p.error ? "failed/offline" : p.freshness}; ${p.observations.length} returned records at ${iso(p.retrievedAt)}. Retrieval status alone does not prove current conditions.`,
        [pc],
      );
    }
    const missing = wanted.filter((l) => !current.some((r) => r.layer === l));
    a.warnings.push(
      `Coverage gaps: ${missing.length ? missing.join(", ") : "no empty enabled layers in this bounded sample"}; no comprehensive coverage claim. Most layers are synthetic/imported unless an actual matching connector snapshot exists.`,
    );
    if (!a.claims.length)
      return abstain(
        "No loaded records or connector status supports a source-quality assessment.",
      );
  } else if (tool === "platform") {
    const es = c.platformEvidence
      .filter(
        (e) =>
          (!scope.selectedId ||
            [e.id, e.entityId, e.subjectId].includes(scope.selectedId)) &&
          ((!scope.from && !scope.to) || inTime(e.observedAt)),
      )
      .slice(0, 70);
    if (!es.length)
      return abstain(
        "No platform evidence is loaded for this selection/time scope. Explicitly load platform context first; no aircraft connection is implied.",
      );
    a.warnings.push(
      c.platformVerified
        ? "Platform API snapshot loaded successfully; source evidence is NOT independently verified. The reference platform source is mock/offline, not a real aircraft connection."
        : "Platform source is offline/unverified. Retained fields are historical, not current status.",
    );
    if (es.some((e) => e.synthetic))
      a.warnings.push(
        "SYNTHETIC platform evidence — not physical-world evidence.",
      );
    const ec = es.map(
      (e, i): AnalystCitation => ({
        id: `platform-${i + 1}`,
        recordId: e.id,
        source: e.sourceId || "unknown source",
        observedAt: iso(e.observedAt),
        freshness:
          c.platformVerified && e.freshness !== "current"
            ? e.freshness
            : "unverified/historical",
        synthetic: e.synthetic,
        detail: value(
          {
            entityId: e.entityId,
            subjectId: e.subjectId,
            field: e.field,
            value: e.value,
            declaredTrust: e.trust,
            declaredFreshness: e.freshness,
            observedAt: e.observedAt,
          },
          6000,
        ),
      }),
    );
    claim(
      `Platform snapshot contains ${es.length} scoped reported fields. Successful API loading is not source verification.`,
      ec,
    );
    es.forEach((e, i) =>
      claim(
        `${e.entityId} · ${e.field}=${value(e.value)} · declared trust ${e.trust} · ${ec[i].freshness}${e.synthetic ? " · SYNTHETIC" : ""}.`,
        [ec[i]],
      ),
    );
    const fields = new Map<string, number[]>();
    es.forEach((e, i) => {
      const k = `${e.subjectId}|${e.field}|${e.observedAt}`;
      fields.set(k, [...(fields.get(k) ?? []), i]);
    });
    for (const [field, indexes] of fields)
      if (
        indexes.length > 1 &&
        new Set(indexes.map((i) => value(es[i].value))).size > 1
      ) {
        a.warnings.push(
          `Contradictory platform field reports: ${field}. No source was resolved as truth.`,
        );
        claim(
          `Conflicting platform ${field}: ${indexes.map((i) => `${es[i].sourceId || "unknown source"}=${value(es[i].value, 200)}`).join("; ")}.`,
          indexes.map((i) => ec[i]),
        );
      }
    a.warnings.push(
      "Missing source IDs, null values or unknown observation times are explicit provenance gaps, not zero/healthy/current values.",
    );
  } else if (tool === "pass") {
    const ps = c.passes.filter((p) => inTime(p.rise)).slice(0, 20);
    if (!ps.length)
      return abstain(
        "No precomputed orbital passes are loaded in this time scope. Supply a validated TLE and calculate passes at the current observer location.",
      );
    a.warnings.push(
      "Passes are derived orbital geometry, NOT sightings or visibility predictions. TLE epoch/age is not retained by this context; propagation uncertainty is not quantified.",
    );
    ps.forEach((p, i) =>
      claim(
        `Geometric pass ${i + 1}: rise ${iso(p.rise)}, peak ${iso(p.peak)}, set ${iso(p.set)}; maximum elevation ${typeof p.maxElevationDeg === "number" ? p.maxElevationDeg.toFixed(1) : "unknown"}°. Visibility not assessed.`,
        [
          {
            id: `pass-${i + 1}`,
            recordId: `pass-${i + 1}`,
            source: "User TLE · local SGP4 geometry",
            observedAt: iso(p.calculatedAt ?? p.rise),
            freshness: "fallback — derived geometric estimate",
            synthetic: false,
            detail: value(
              {
                ...p,
                warning:
                  "Derived orbital geometry, not observed sightings; visibility not assessed; TLE epoch not retained",
              },
              6000,
            ),
          },
        ],
      ),
    );
  }
  return a;
}
export function analystPresets(c: AnalystContext): string[] {
  const available = [
    ...new Set(
      c.records
        .filter((r) => c.visibleLayers.includes(r.layer))
        .map((r) => r.layer),
    ),
  ];
  return [
    "Summarize the visible layers",
    "Explain source quality and coverage gaps",
    ...(available.length >= 2
      ? [`Compare ${available[0]} and ${available[1]}`]
      : []),
    ...(available.includes("weather") ? ["Show weather forecast details"] : []),
    ...(available.includes("earthquakes")
      ? ["Show earthquake magnitude details"]
      : []),
    "Show history for the selected observation",
    "Create a scene briefing",
    ...(c.platformEvidence.length ? ["Summarize platform evidence"] : []),
    ...(c.passes.length ? ["What orbital passes are precomputed?"] : []),
  ];
}
export function parseAnalystVoice(
  input: string,
):
  | { kind: "query"; question: string }
  | { kind: "layer"; layer: string; visible: boolean }
  | { kind: "navigate"; place: string }
  | { kind: "annotation"; text: string }
  | { kind: "reject"; reason: string } {
  const t = text(input, 2000);
  if (!t) return { kind: "reject", reason: "Empty voice command." };
  if (
    UNSAFE.test(t) ||
    /\b(?:launch|land|fly|control|track|identify|recognize|recognise|person|people|owner|plate|plates|registration|rank|fire weapons?)\b/i.test(
      t,
    )
  )
    return {
      kind: "reject",
      reason:
        "Operational, targeting, identity and arbitrary execution instructions are not supported.",
    };
  let m = /^(show|hide)\s+(?:layer\s+)?([a-z_-]+)(?:\s+layer)?$/i.exec(t);
  if (m) {
    const l = aliases[m[2].toLowerCase()] ?? m[2].toLowerCase();
    return validLayer(l)
      ? { kind: "layer", layer: l, visible: m[1].toLowerCase() === "show" }
      : { kind: "reject", reason: `Unknown layer: ${l}.` };
  }
  m = /^(?:navigate(?: to)?|go to|center on)\s+([a-z0-9 ,.°+-]{1,100})$/i.exec(
    t,
  );
  if (m) return { kind: "navigate", place: text(m[1], 100) };
  m = /^(?:annotate|note|draft annotation)\s+(.{1,460})$/i.exec(t);
  if (m) return { kind: "annotation", text: text(m[1], 460) };
  if (
    /^(?:what|which|where|when|how|show|summarize|compare|brief|give|list|is|are|explain|create)\b/i.test(
      t,
    ) &&
    toolFor(t)
  )
    return { kind: "query", question: t };
  return {
    kind: "reject",
    reason:
      "Voice accepts only bounded read-only questions, show/hide known layers, local camera navigation and annotation drafts.",
  };
}
