import type { FleetAircraft } from './fleet-utils';

export type DemoScenario = 'recorded' | 'link-loss' | 'recovery';
export type MetricId = 'battery' | 'link' | 'altitude';
export type Outcome = 'accepted' | 'late' | 'duplicate' | 'rejected';

export type TelemetryPoint = { offsetSeconds: number; value: number | null };
export type TelemetryEvent = {
  id: string;
  offsetSeconds: number;
  outcome: Outcome;
  sequence: number | null;
  source: string;
  detail: string;
};
export type TelemetrySnapshot = {
  aircraftId: string;
  source: string;
  snapshotTimestamp: string;
  scenario: DemoScenario;
  sampleAgeSeconds: number;
  sequence: number | null;
  altitude: number | null;
  groundSpeed: number | null;
  heading: number | null;
  battery: number | null;
  link: number | null;
  history: Record<MetricId, TelemetryPoint[]>;
  events: TelemetryEvent[];
};

/** A fixed UTC timestamp used only to anchor synthetic fixture history, never wall time. */
export const SYNTHETIC_FIXTURE_SNAPSHOT_ISO = '2025-01-01T12:00:00.000Z';

export const metricConfig: Record<MetricId, { label: string; unit: string; domain: [number, number] }> = {
  battery: { label: 'Battery', unit: '%', domain: [0, 100] },
  link: { label: 'Link', unit: '%', domain: [0, 100] },
  altitude: { label: 'Altitude', unit: 'm', domain: [0, 200] },
};

const OFFSETS = Array.from({ length: 31 }, (_, index) => -900 + index * 30);

function makeSeries(metric: MetricId, finalValue: number | null): TelemetryPoint[] {
  return OFFSETS.map((offsetSeconds, index) => {
    if (finalValue === null) return { offsetSeconds, value: null };
    if (index === 15) return { offsetSeconds, value: null };
    const progress = index / (OFFSETS.length - 1);
    const value = metric === 'altitude'
      ? finalValue - (1 - progress) * 8
      : finalValue + (1 - progress) * (metric === 'battery' ? 3 : 2);
    return { offsetSeconds, value: metric === 'altitude' ? Number(value.toFixed(1)) : Math.max(0, Math.min(100, Number(value.toFixed(1)))) };
  });
}

function emptyHistory(): Record<MetricId, TelemetryPoint[]> {
  return { battery: [], link: [], altitude: [] };
}

function fixtureHistory(aircraft: FleetAircraft, id: string): Record<MetricId, TelemetryPoint[]> {
  if (id === 'sim-ucas-001') {
    return {
      battery: makeSeries('battery', aircraft.battery),
      link: makeSeries('link', aircraft.link),
      altitude: makeSeries('altitude', 124.6),
    };
  }
  if (id === 'sim-ucas-002') {
    return {
      battery: makeSeries('battery', aircraft.battery),
      link: makeSeries('link', aircraft.link),
      altitude: [],
    };
  }
  return emptyHistory();
}

function event(id: string, offsetSeconds: number, outcome: Outcome, sequence: number | null, source: string, detail: string): TelemetryEvent {
  return { id, offsetSeconds, outcome, sequence, source, detail };
}

function baselineEvents(aircraft: FleetAircraft, sequence: number, newestOffset = 0): TelemetryEvent[] {
  const prefix = `${aircraft.id}-baseline`;
  return [
    event(`${prefix}-accepted-latest`, newestOffset, 'accepted', sequence, aircraft.source, `Synthetic parser accepted current sample for ${aircraft.id}; in-order sequence ${sequence}.`),
    event(`${prefix}-accepted-prior`, -30, 'accepted', sequence - 1, aircraft.source, `Synthetic parser accepted prior sample for ${aircraft.id}; in-order sequence ${sequence - 1}.`),
    event(`${prefix}-late`, -65, 'late', sequence - 3, aircraft.source, `Synthetic parser marked ${aircraft.id} late; out-of-order sequence ${sequence - 3} arrived after ${sequence - 1}.`),
    event(`${prefix}-duplicate`, -90, 'duplicate', sequence - 4, aircraft.source, `Synthetic parser marked ${aircraft.id} duplicate; out-of-order sequence ${sequence - 4} repeats an observed sample.`),
    event(`${prefix}-rejected`, -120, 'rejected', sequence - 5, aircraft.source, `Synthetic parser rejected ${aircraft.id}; out-of-order sequence ${sequence - 5} failed disposition.`),
  ];
}

export function buildTelemetrySnapshot(aircraft: FleetAircraft, scenario: DemoScenario): TelemetrySnapshot {
  const knownSim = aircraft.id === 'sim-ucas-001' || aircraft.id === 'sim-ucas-002';
  const isProfile = knownSim;
  const profileFlight = aircraft.id === 'sim-ucas-001';
  const history = fixtureHistory(aircraft, aircraft.id);
  const baselineSequence = aircraft.id === 'sim-ucas-001' ? 1842 : 921;
  const snapshot: TelemetrySnapshot = {
    aircraftId: aircraft.id,
    source: aircraft.source,
    snapshotTimestamp: SYNTHETIC_FIXTURE_SNAPSHOT_ISO,
    scenario: knownSim ? scenario : 'recorded',
    sampleAgeSeconds: aircraft.sampleAgeSeconds,
    sequence: isProfile ? baselineSequence : null,
    altitude: profileFlight ? 124.6 : null,
    groundSpeed: profileFlight ? 18.2 : null,
    heading: profileFlight ? 42 : null,
    battery: Number.isFinite(aircraft.battery) ? aircraft.battery : null,
    link: Number.isFinite(aircraft.link) ? aircraft.link : null,
    history,
    events: knownSim ? baselineEvents(aircraft, baselineSequence, scenario === 'recorded' ? 0 : -1) : [],
  };

  if (scenario === 'link-loss' && isProfile) {
    snapshot.sampleAgeSeconds = Math.max(600, aircraft.sampleAgeSeconds);
    snapshot.link = null;
    snapshot.events.push(event(`${aircraft.id}-link-gap`, 0, 'rejected', null, aircraft.source, 'Synthetic link-loss observation: no new sample received; local what-if only'));
  } else if (scenario === 'recovery' && isProfile) {
    snapshot.sampleAgeSeconds = 5;
    snapshot.link = 96;
    snapshot.sequence = snapshot.sequence === null ? null : snapshot.sequence + 1;
    snapshot.history.link[snapshot.history.link.length - 1] = { offsetSeconds: 0, value: 96 };
    snapshot.events.push(event(`${aircraft.id}-recovery`, 0, 'accepted', snapshot.sequence, aircraft.source, 'Synthetic parser accepted recovery sample; link restored after local what-if.'));
  }

  return snapshot;
}

export function visibleMeasurement(value: number | null, age: number): number | null {
  if (value === null || !Number.isFinite(value) || !Number.isFinite(age) || age < 0 || age > 300) return null;
  return value;
}

export function historyWindow(points: TelemetryPoint[], seconds: number): TelemetryPoint[] {
  if (!Number.isFinite(seconds) || seconds <= 0) return [];
  return points.map((point, index) => ({ point, index }))
    .filter(({ point }) => Number.isFinite(point.offsetSeconds) && point.offsetSeconds >= -seconds && point.offsetSeconds <= 0)
    .sort((a, b) => a.point.offsetSeconds - b.point.offsetSeconds || a.index - b.index)
    .map(({ point }) => ({ offsetSeconds: point.offsetSeconds, value: point.value }));
}

export function filterTelemetryEvents(events: TelemetryEvent[], outcome: 'all' | Outcome, query: string): TelemetryEvent[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return events.filter((item) => {
    if (outcome !== 'all' && item.outcome !== outcome) return false;
    const searchable = [item.id, item.outcome, item.source, item.detail, item.sequence === null ? '' : String(item.sequence)]
      .join(' ').toLocaleLowerCase();
    return words.every((word) => searchable.includes(word));
  }).slice().sort((a, b) => b.offsetSeconds - a.offsetSeconds || a.id.localeCompare(b.id));
}
