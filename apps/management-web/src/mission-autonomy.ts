export type MissionTemplate = 'area-survey' | 'infrastructure-inspection' | 'search-and-assess';
export type Domain = 'air' | 'land' | 'sea';
export type Autopilot = 'PX4' | 'ArduPilot' | 'None';
export type Asset = { id: string; name: string; domain: Domain; autopilot: Autopilot; capabilities: string[]; battery: number | null; link: number | null; ageSeconds: number; available: boolean };
export type Task = { id: string; label: string; capability: string; domain: Domain; assetId: string | null; status: 'pending' | 'active' | 'complete' | 'blocked'; reason: string };
export type Observation = { id: string; subjectId: string; sensor: string; sourceId: string; ageSeconds: number; confidence: number; summary: string };
export type CorrelatedObservation = { subjectId: string; sourceIds: string[]; sensors: string[]; confidence: number; status: 'corroborated' | 'single-source' | 'stale'; summary: string };
export type MissionEvent = { sequence: number; kind: string; detail: string };
export type MissionState = { schemaVersion: 1; environment: 'synthetic'; controlEnabled: false; template: MissionTemplate; intent: string; tasks: Task[]; assets: Asset[]; observations: Observation[]; events: MissionEvent[]; phase: 'draft' | 'review' | 'running' | 'paused' | 'completed'; revision: number; approvedRevision: number | null };

export const templates: Record<MissionTemplate, { label: string; intent: string }> = {
  'area-survey': { label: 'Area survey', intent: 'Survey a defined area using synthetic visual and ground-reference observations.' },
  'infrastructure-inspection': { label: 'Infrastructure inspection', intent: 'Inspect infrastructure surfaces and approaches using synthetic inspection observations.' },
  'search-and-assess': { label: 'Search and assess', intent: 'Search an area and assess reported subjects using synthetic observations.' },
};

const roster: Asset[] = [
  { id: 'SYN-AIR-PX4', name: 'Synthetic quadrotor reference', domain: 'air', autopilot: 'PX4', capabilities: ['aerial-imagery', 'visual-inspection', 'search-sweep'], battery: 88, link: 94, ageSeconds: 4, available: true },
  { id: 'SYN-AIR-AP', name: 'Synthetic fixed-wing reference', domain: 'air', autopilot: 'ArduPilot', capabilities: ['wide-area-survey', 'search-sweep'], battery: 76, link: 87, ageSeconds: 8, available: true },
  { id: 'SYN-LAND-REF', name: 'Synthetic ground reference node', domain: 'land', autopilot: 'None', capabilities: ['ground-truth', 'structure-assessment', 'access-assessment'], battery: 72, link: 82, ageSeconds: 6, available: true },
  { id: 'SYN-SEA-REF', name: 'Synthetic surface reference node', domain: 'sea', autopilot: 'None', capabilities: ['shoreline-scan', 'waterway-inspection', 'shoreline-search'], battery: 68, link: 79, ageSeconds: 9, available: true },
];

const seededObservations: Observation[] = [
  { id: 'OBS-FRESH-A', subjectId: 'synthetic-subject-01', sensor: 'camera', sourceId: 'SYN-AIR-PX4', ageSeconds: 4, confidence: 0.72, summary: 'Fresh aerial visual report.' },
  { id: 'OBS-FRESH-B', subjectId: 'synthetic-subject-01', sensor: 'ground-reference', sourceId: 'SYN-LAND-REF', ageSeconds: 6, confidence: 0.81, summary: 'Fresh ground-reference report.' },
  { id: 'OBS-DUPLICATE', subjectId: 'synthetic-subject-01', sensor: 'camera', sourceId: 'SYN-AIR-PX4', ageSeconds: 5, confidence: 0.65, summary: 'Duplicate-source visual report.' },
  { id: 'OBS-STALE', subjectId: 'synthetic-stale-subject', sensor: 'radar', sourceId: 'SYN-SEA-REF', ageSeconds: 45, confidence: 0.99, summary: 'Stale synthetic report.' },
];

const taskPlans: Record<MissionTemplate, Array<[string, string, Domain]>> = {
  'area-survey': [['air-overview', 'wide-area-survey', 'air'], ['land-reference', 'ground-truth', 'land'], ['sea-edge', 'shoreline-scan', 'sea']],
  'infrastructure-inspection': [['air-inspection', 'visual-inspection', 'air'], ['land-structure', 'structure-assessment', 'land'], ['sea-approach', 'waterway-inspection', 'sea']],
  'search-and-assess': [['air-search', 'search-sweep', 'air'], ['land-access', 'access-assessment', 'land'], ['sea-search', 'shoreline-search', 'sea']],
};

const clone = <T>(value: T): T => structuredClone(value);
const finite = (value: number | null): value is number => typeof value === 'number' && Number.isFinite(value);
const nextEvent = (state: MissionState, kind: string, detail: string): MissionEvent => ({ sequence: (state.events.at(-1)?.sequence ?? 0) + 1, kind, detail });
const transition = (state: MissionState, change: (draft: MissionState) => void, event: MissionEvent): MissionState => { const draft = clone(state); change(draft); draft.revision += 1; draft.events.push(event); return draft; };
const requireState = (state: MissionState): void => { if (state.environment !== 'synthetic' || state.controlEnabled !== false || state.schemaVersion !== 1) throw new Error('Mission state must be synthetic and control-disabled'); };

export function createMission(template: MissionTemplate): MissionState {
  if (!Object.hasOwn(templates, template)) throw new Error(`Unknown mission template: ${template}`);
  return { schemaVersion: 1, environment: 'synthetic', controlEnabled: false, template, intent: templates[template].intent, tasks: [], assets: clone(roster), observations: clone(seededObservations), events: [{ sequence: 1, kind: 'created', detail: `Created synthetic ${templates[template].label} mission` }], phase: 'draft', revision: 0, approvedRevision: null };
}

function eligible(asset: Asset, task: Task): boolean {
  return asset.available && asset.domain === task.domain && asset.capabilities.includes(task.capability) && finite(asset.ageSeconds) && asset.ageSeconds >= 0 && asset.ageSeconds <= 30 && finite(asset.link) && asset.link >= 60 && asset.link <= 100 && finite(asset.battery) && asset.battery >= 30 && asset.battery <= 100;
}

function validateAssignments(state: MissionState): void {
  if (state.tasks.length === 0) throw new Error('Cannot operate on an unplanned mission');
  const assigned = new Set<string>();
  for (const task of state.tasks) {
    if (task.status === 'blocked' || !task.assetId) throw new Error('Cannot operate with blocked or unassigned tasks');
    if (assigned.has(task.assetId)) throw new Error('Cannot operate with duplicate asset assignments');
    const asset = state.assets.find(candidate => candidate.id === task.assetId);
    if (!asset || !eligible(asset, task)) throw new Error('Cannot operate with an ineligible or missing assigned asset');
    assigned.add(task.assetId);
  }
}

export function planMission(state: MissionState): MissionState {
  requireState(state); if (!['draft', 'review', 'paused'].includes(state.phase)) throw new Error(`Cannot plan while mission is ${state.phase}`);
  const baseTasks: Task[] = taskPlans[state.template].map(([id, capability, domain]) => ({ id, label: id.replaceAll('-', ' '), capability, domain, assetId: null, status: 'pending', reason: '' }));
  return transition(state, draft => { const used = new Set<string>(); draft.tasks = baseTasks.map(task => { const asset = draft.assets.find(candidate => !used.has(candidate.id) && eligible(candidate, task)); if (asset) { used.add(asset.id); return { ...task, assetId: asset.id, reason: `Assigned ${asset.id}: domain, capability, battery/link reserve, freshness, and availability passed.` }; } const domainAssets = draft.assets.filter(candidate => candidate.domain === task.domain); const reason = domainAssets.length === 0 ? 'Blocked: no synthetic asset for the required domain.' : 'Blocked: no available asset met capability, battery reserve >=30, link >=60, percentages <=100, and age <=30 requirements.'; return { ...task, status: 'blocked', reason }; }); draft.phase = 'review'; draft.approvedRevision = null; }, nextEvent(state, 'planned', `Planned ${taskPlans[state.template].length} discrete synthetic tasks; supervisor approval cleared.`));
}

export function approveMission(state: MissionState): MissionState {
  requireState(state); if (state.phase !== 'review') throw new Error(`Only a planned mission in review can be approved (currently ${state.phase})`); validateAssignments(state);
  return transition(state, draft => { draft.approvedRevision = state.revision + 1; }, nextEvent(state, 'approved', `Supervisor approved revision ${state.revision + 1}; no control authority is enabled.`));
}

export function startMission(state: MissionState): MissionState {
  requireState(state); if (state.phase !== 'review') throw new Error(`Only a reviewed mission can start (currently ${state.phase})`); if (state.approvedRevision !== state.revision) throw new Error('Mission approval does not match the current revision'); validateAssignments(state);
  return transition(state, draft => { draft.phase = 'running'; draft.tasks = draft.tasks.map(task => task.status === 'pending' ? { ...task, status: 'active', reason: `${task.reason} Started in synthetic simulation; explicit advance is required.` } : task); }, nextEvent(state, 'started', 'Started synthetic simulation; no transport, API, hardware, or weapon action is performed.'));
}

export function pauseMission(state: MissionState): MissionState {
  requireState(state); if (state.phase !== 'running') throw new Error(`Only a running mission can pause (currently ${state.phase})`);
  return transition(state, draft => { draft.phase = 'paused'; draft.approvedRevision = null; }, nextEvent(state, 'paused', 'Paused synthetic simulation; resume requires explicit replan and approval.'));
}

export function advanceMission(state: MissionState): MissionState {
  requireState(state); if (state.phase !== 'running') throw new Error(`Only a running mission can advance (currently ${state.phase})`);
  return transition(state, draft => { const index = draft.tasks.findIndex(task => task.status === 'active'); if (index >= 0) draft.tasks[index] = { ...draft.tasks[index], status: 'complete', reason: `${draft.tasks[index].reason} Completed by explicit supervisor advance.` }; if (draft.tasks.length > 0 && draft.tasks.every(task => task.status === 'complete')) draft.phase = 'completed'; }, nextEvent(state, 'advanced', 'Completed at most one current synthetic task explicitly; no timer or autonomous continuation is used.'));
}

export function degradeAsset(state: MissionState, id: string): MissionState {
  requireState(state); if (!state.assets.some(asset => asset.id === id)) throw new Error(`Unknown asset: ${id}`);
  return transition(state, draft => { const asset = draft.assets.find(item => item.id === id)!; asset.available = false; draft.approvedRevision = null; if (draft.phase !== 'draft') draft.tasks = draft.tasks.map(task => task.assetId === id && task.status !== 'complete' ? { ...task, status: 'blocked', reason: 'Blocked: assigned asset degraded and is unavailable; replan and approval are required.' } : task); if (draft.phase === 'running') draft.phase = 'paused'; }, nextEvent(state, 'asset-degraded', `${id} marked unavailable; any approval was invalidated.`));
}

export function correlateObservations(observations: Observation[]): CorrelatedObservation[] {
  const groups = new Map<string, Observation[]>(); for (const observation of observations) { if (!groups.has(observation.subjectId)) groups.set(observation.subjectId, []); groups.get(observation.subjectId)!.push(observation); }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([subjectId, items]) => { const fresh = items.filter(item => finite(item.ageSeconds) && item.ageSeconds >= 0 && item.ageSeconds <= 30); const sourceIds = [...new Set(items.map(item => item.sourceId))].sort(); const sensors = [...new Set(items.map(item => item.sensor))].sort(); const confidence = fresh.length === 0 ? 0 : Math.max(...fresh.map(item => finite(item.confidence) ? Math.max(0, Math.min(1, item.confidence)) : 0)); const status = fresh.length === 0 ? 'stale' : new Set(fresh.map(item => item.sourceId)).size > 1 ? 'corroborated' : 'single-source'; return { subjectId, sourceIds, sensors, confidence, status, summary: status === 'stale' ? 'Stale synthetic observations; do not treat as current evidence.' : `${status === 'corroborated' ? 'Independent synthetic sources corroborate' : 'Single synthetic source reports'}: ${fresh.map(item => item.summary).join(' | ')}` }; });
}

export function buildDebrief(state: MissionState): string {
  requireState(state); const completed = state.tasks.filter(task => task.status === 'complete').length; const blocked = state.tasks.filter(task => task.status === 'blocked').length;
  return [`# Synthetic mission debrief: ${templates[state.template].label}`, '', `**Phase:** ${state.phase}  `, `**Revision:** ${state.revision}  `, `**Progress:** ${completed}/${state.tasks.length} complete; ${blocked} blocked.`, '', '## Tasks', ...(state.tasks.length ? state.tasks.map(task => `- **${task.label}** — ${task.status}; asset: ${task.assetId ?? 'none'}; ${task.reason || 'No detail.'}`) : ['- None']), '', '## Audit events', ...(state.events.length ? state.events.map(event => `- #${event.sequence} **${event.kind}** — ${event.detail}`) : ['- None']), '', '## Limitations', '- Browser-local deterministic simulation only; environment is synthetic and controlEnabled is false.', '- No transport, API, fetch, hardware, weapon, or real-world support action is performed.', '- Observations are not AI conclusions; corroboration does not amplify confidence.'].join('\n');
}

export function exportMission(state: MissionState): string { requireState(state); return JSON.stringify({ ...clone(state), exportClassification: 'SYNTHETIC_BROWSER_LOCAL', limitations: 'No transport/API/fetch/hardware/weapons; controlEnabled=false; synthetic reference nodes only.' }, null, 2); }
