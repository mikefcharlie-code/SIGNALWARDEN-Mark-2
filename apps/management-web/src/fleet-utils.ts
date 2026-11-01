export type FleetAircraft = {
  id: string;
  name: string;
  type: string;
  environment: 'SIMULATED' | 'LAB';
  status: 'Available' | 'Maintenance' | 'Suspended';
  health: number;
  battery: number;
  link: number;
  freshness: string;
  sampleAgeSeconds: number;
  source: string;
  location: string;
};

export type FleetFilters = {
  query: string;
  status: 'all' | FleetAircraft['status'];
  environment: 'all' | FleetAircraft['environment'];
  attentionOnly: boolean;
  sort: 'name' | 'battery' | 'freshness';
};

export function freshnessFor(age: number): 'Fresh' | 'Delayed' | 'Stale' | 'Unknown' {
  if (!Number.isFinite(age) || age < 0) return 'Unknown';
  if (age <= 30) return 'Fresh';
  if (age <= 300) return 'Delayed';
  return 'Stale';
}

export function needsAttention(item: FleetAircraft): boolean {
  return item.status !== 'Available'
    || freshnessFor(item.sampleAgeSeconds) !== 'Fresh'
    || item.battery < 30
    || item.link < 80;
}

function matchesQuery(item: FleetAircraft, query: string): boolean {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const searchable = [
    item.id, item.name, item.type, item.source, item.location,
    item.environment, item.status,
  ].join(' ').toLocaleLowerCase();
  return words.every((word) => searchable.includes(word));
}

function compareName(a: FleetAircraft, b: FleetAircraft): number {
  const byName = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  if (byName !== 0) return byName;
  const byId = a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: 'base' });
  if (byId !== 0) return byId;
  return a.location.localeCompare(b.location, undefined, { numeric: true, sensitivity: 'base' });
}

export function filterAircraft(items: FleetAircraft[], filters: FleetFilters): FleetAircraft[] {
  const filtered = items.filter((item) => (
    matchesQuery(item, filters.query)
    && (filters.status === 'all' || item.status === filters.status)
    && (filters.environment === 'all' || item.environment === filters.environment)
    && (!filters.attentionOnly || needsAttention(item))
  ));

  return filtered.slice().sort((a, b) => {
    if (filters.sort === 'name') return compareName(a, b);
    if (filters.sort === 'battery') {
      return a.battery - b.battery || compareName(a, b);
    }

    const aUnknown = freshnessFor(a.sampleAgeSeconds) === 'Unknown';
    const bUnknown = freshnessFor(b.sampleAgeSeconds) === 'Unknown';
    if (aUnknown !== bUnknown) return aUnknown ? -1 : 1;
    if (!aUnknown && a.sampleAgeSeconds !== b.sampleAgeSeconds) {
      return b.sampleAgeSeconds - a.sampleAgeSeconds;
    }
    return compareName(a, b);
  });
}

export function fleetSummary(items: FleetAircraft[]): {
  total: number;
  fresh: number;
  attention: number;
  simulated: number;
  lab: number;
} {
  return {
    total: items.length,
    fresh: items.filter((item) => freshnessFor(item.sampleAgeSeconds) === 'Fresh').length,
    attention: items.filter(needsAttention).length,
    simulated: items.filter((item) => item.environment === 'SIMULATED').length,
    lab: items.filter((item) => item.environment === 'LAB').length,
  };
}

const CSV_COLUMNS: Array<keyof FleetAircraft | 'health_percent' | 'battery_percent' | 'link_percent' | 'sample_age_seconds' | 'data_classification'> = [
  'id', 'name', 'type', 'environment', 'status', 'health_percent', 'battery_percent',
  'link_percent', 'sample_age_seconds', 'freshness', 'source', 'location', 'data_classification',
];

function csvValue(value: unknown): string {
  const text = String(value ?? '');
  // Prefix values that begin with whitespace/control characters followed by a formula marker.
  const safe = /^[\s\x00-\x1F]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function aircraftCsv(items: FleetAircraft[]): string {
  const header = CSV_COLUMNS.map((column) => csvValue(column)).join(',');
  const rows = items.map((item) => [
    item.id, item.name, item.type, item.environment, item.status, item.health,
    item.battery, item.link, item.sampleAgeSeconds, freshnessFor(item.sampleAgeSeconds),
    item.source, item.location, 'SYNTHETIC DEMO',
  ].map(csvValue).join(','));
  return [header, ...rows].join('\r\n') + '\r\n';
}
