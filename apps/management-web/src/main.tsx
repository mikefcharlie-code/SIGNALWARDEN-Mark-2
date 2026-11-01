import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { FleetExplorer } from './FleetExplorer'
import { TelemetryInspector } from './TelemetryInspector'
import { Observations } from './Observations'
import { Reports } from './Reports'
import { LocalAIWorkbench } from './LocalAIWorkbench'
import { WorkspaceWelcome } from './WorkspaceWelcome'
import { MissionAutonomy } from './MissionAutonomy'
const WorldView = lazy(() => import('./WorldView'))
import type { FleetAircraft } from './fleet-utils'

type Page = 'worldview' | 'reports' | 'ai' | 'fleet' | 'monitor' | 'observations' | 'cameras' | 'missions' | 'training' | 'maintenance' | 'access' | 'roles' | 'audit'
type RoleId = 'telemetry-viewer' | 'drone-operator' | 'access-administrator' | 'system-administrator'
type PersonaId = 'operator' | 'viewer' | 'access-admin'
type Status = 'active' | 'suspended' | 'expired'

type Permission = { id: string; description: string }
type CatalogRole = { id: RoleId; display_name: string; immutable: boolean; permissions: string[] }
type RbacCatalog = { permissions: Permission[]; roles: CatalogRole[] }

type User = {
  id: string
  initials: string
  name: string
  email: string
  status: Status
  roles: RoleId[]
  scope: string
  scopeType: string
  expiry: string
  lastSeen: string
  mfa: string
  assignment: string
}

type Aircraft = FleetAircraft

const personas: Record<PersonaId, { name: string; role: string; initials: string; allowed: Page[] }> = {
  operator: { name: 'Maya Chen', role: 'Drone Operator', initials: 'MC', allowed: ['fleet', 'monitor', 'observations', 'worldview', 'reports', 'ai', 'cameras', 'missions', 'training', 'maintenance'] },
  viewer: { name: 'Jonas Reed', role: 'Telemetry Viewer', initials: 'JR', allowed: ['fleet', 'monitor', 'observations', 'worldview', 'reports', 'ai', 'cameras', 'missions', 'training'] },
  'access-admin': { name: 'Avery Rivera', role: 'Access Administrator', initials: 'AR', allowed: ['fleet', 'monitor', 'observations', 'worldview', 'reports', 'ai', 'cameras', 'missions', 'training', 'maintenance', 'access', 'roles', 'audit'] },
}

const aircraft: Aircraft[] = [
  { id: 'sim-ucas-001', name: 'UCAS / 001', type: 'Quad-X research platform', environment: 'SIMULATED', status: 'Available', health: 98, battery: 82, link: 99, freshness: '12 sec ago', sampleAgeSeconds: 12, source: 'local-simulator', location: 'Test range / North pad' },
  { id: 'sim-ucas-002', name: 'UCAS / 002', type: 'Heavy-lift demonstrator', environment: 'SIMULATED', status: 'Maintenance', health: 74, battery: 41, link: 93, freshness: '4 min ago', sampleAgeSeconds: 240, source: 'local-simulator', location: 'Hangar / Bench 02' },
  { id: 'lab-ucas-007', name: 'UCAS / 007', type: 'Fixed-wing lab article', environment: 'LAB', status: 'Suspended', health: 61, battery: 0, link: 0, freshness: '2 hr ago', sampleAgeSeconds: 7200, source: 'bench-adapter', location: 'Lab / isolated' },
]


type CameraChannel = {
  id: string
  label: string
  position: string
  lens: string
  resolution: string
  fps: number
  freshness: string
  signal: number
  tone: 'day' | 'thermal' | 'night' | 'down'
  state: 'Live' | 'Degraded' | 'Stale'
  note: string
}

const cameras: CameraChannel[] = [
  { id: 'cam-front', label: 'Forward / EO', position: 'Nose gimbal', lens: 'Wide field · 84°', resolution: '3840 × 2160', fps: 30, freshness: '1 sec ago', signal: 99, tone: 'day', state: 'Live', note: 'Primary navigation view' },
  { id: 'cam-down', label: 'Downward / EO', position: 'Belly mount', lens: 'Nadir · 92°', resolution: '1920 × 1080', fps: 30, freshness: '2 sec ago', signal: 98, tone: 'down', state: 'Live', note: 'Landing-zone context' },
  { id: 'cam-thermal', label: 'Forward / IR', position: 'Nose gimbal', lens: 'Long-wave infrared', resolution: '640 × 512', fps: 15, freshness: '2 sec ago', signal: 96, tone: 'thermal', state: 'Live', note: 'Thermal overlay / synthetic' },
  { id: 'cam-left', label: 'Port / EO', position: 'Left boom', lens: 'Side context · 78°', resolution: '1920 × 1080', fps: 24, freshness: '3 sec ago', signal: 92, tone: 'day', state: 'Live', note: 'Left-side perimeter' },
  { id: 'cam-right', label: 'Starboard / EO', position: 'Right boom', lens: 'Side context · 78°', resolution: '1920 × 1080', fps: 24, freshness: '8 sec ago', signal: 77, tone: 'day', state: 'Degraded', note: 'Packet loss 3.1%' },
  { id: 'cam-rear', label: 'Rear / EO', position: 'Tail mount', lens: 'Rear context · 72°', resolution: '1920 × 1080', fps: 24, freshness: '2 min ago', signal: 41, tone: 'night', state: 'Stale', note: 'Awaiting next keyframe' },
]

const users: User[] = [
  { id: 'usr-001', initials: 'AR', name: 'Avery Rivera', email: 'avery.rivera@example.test', status: 'active', roles: ['access-administrator'], scope: 'Organization · Lab operations', scopeType: 'Organization', expiry: 'No expiry', lastSeen: '12 min ago', mfa: 'Enrolled', assignment: 'admin-01' },
  { id: 'usr-002', initials: 'JC', name: 'Jules Chen', email: 'jules.chen@example.test', status: 'active', roles: ['telemetry-viewer'], scope: 'Aircraft · sim-ucas-001', scopeType: 'Aircraft', expiry: 'No expiry', lastSeen: '38 min ago', mfa: 'Enrolled', assignment: 'assign-07' },
  { id: 'usr-003', initials: 'NO', name: 'Niko Okafor', email: 'niko.okafor@example.test', status: 'active', roles: ['drone-operator'], scope: 'Fleet · North test range', scopeType: 'Fleet', expiry: '24 Oct 2026', lastSeen: '1 hr ago', mfa: 'Enrolled', assignment: 'assign-09' },
  { id: 'usr-004', initials: 'MP', name: 'Mina Patel', email: 'mina.patel@example.test', status: 'suspended', roles: ['access-administrator'], scope: 'Site · Test operations', scopeType: 'Site', expiry: 'No expiry', lastSeen: '3 days ago', mfa: 'Required', assignment: 'assign-02' },
]


function titleFor(page: Page) {
  return ({ worldview: 'World View', fleet: 'Fleet overview', monitor: 'Telemetry inspector', observations: 'Observation workspace', reports: 'Reports & documents', ai: 'Local AI & media', cameras: 'Camera wall', missions: 'Mission Autonomy', training: 'Training C2', maintenance: 'Maintenance', access: 'Access management', roles: 'Role catalog', audit: 'Access audit' })[page]
}

function pageFromLocation(): Page {
  const path = window.location.pathname.replace(/^\//, '') as Page
  if (['fleet', 'monitor', 'observations', 'worldview', 'reports', 'ai', 'cameras', 'missions', 'training', 'maintenance', 'access', 'roles', 'audit'].includes(path)) return path
  const hash = window.location.hash.replace('#/', '') as Page
  return ['fleet', 'monitor', 'observations', 'worldview', 'reports', 'ai', 'cameras', 'missions', 'training', 'maintenance', 'access', 'roles', 'audit'].includes(hash) ? hash : 'fleet'
}

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, string> = {
    grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
    pulse: 'M3 12h3l2-7 4 14 2-7h7',
    wrench: 'M14.7 6.3a4 4 0 0 0-5.1 5.1L4 17v3h3l5.6-5.6a4 4 0 0 0 5.1-5.1l-3 3-2-2 3-3Z',
    users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
    shield: 'M12 3 4 6v5c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V6l-8-3ZM9 12l2 2 4-4',
    file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6M8 13h8M8 17h6',
    search: 'm21 21-4.3-4.3M10.8 18a7.2 7.2 0 1 1 0-14.4 7.2 7.2 0 0 1 0 14.4Z',
    bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',
    chevron: 'm7 10 5 5 5-5',
    arrow: 'M5 12h14m-6-6 6 6-6 6',
    close: 'm6 6 12 12M18 6 6 18',
    plus: 'M12 5v14M5 12h14',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    external: 'M14 5h5v5M19 5l-8 8M18 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
    lock: 'M6 10V7a6 6 0 0 1 12 0v3M5 10h14v11H5zM12 15v2',
    camera: 'M4 7h3l2-2h6l2 2h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2ZM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
    video: 'm16 13 5 3V8l-5 3M3 6h13v12H3z',
  }
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] ?? paths.grid} /></svg>
}

function StatusPill({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'green' | 'orange' | 'red' | 'blue' }) {
  return <span className={`status-pill ${tone}`}><span className="status-dot" />{children}</span>
}

function MetricCard({ label, value, detail, tone = 'ink', icon }: { label: string; value: string; detail: string; tone?: string; icon: string }) {
  return <div className={`metric-card ${tone}`}><div className="metric-head"><span>{label}</span><span className="metric-icon"><Icon name={icon} size={16} /></span></div><strong>{value}</strong><small>{detail}</small></div>
}

function SectionHeading({ eyebrow, title, detail, action }: { eyebrow: string; title: string; detail?: string; action?: React.ReactNode }) {
  return <div className="section-heading"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1>{detail && <p>{detail}</p>}</div>{action}</div>
}

function SimBanner() {
  return <div className="sim-banner"><span className="sim-mark">S</span><div><strong>SIMULATION ENVIRONMENT</strong><span>All telemetry, video, and access records shown here are synthetic. No aircraft control path is connected.</span></div><span className="banner-code">ENV / SIM-01</span></div>
}


function FleetPage({ onNavigate, selectedAircraft, setSelectedAircraft }: { onNavigate: (page: Page) => void; selectedAircraft: Aircraft; setSelectedAircraft: (a: Aircraft) => void }) {
  return <FleetExplorer items={aircraft} selectedAircraft={selectedAircraft} setSelectedAircraft={setSelectedAircraft} openMonitor={() => onNavigate('monitor')} openCameras={() => onNavigate('cameras')} />
}

function MonitorPage({ selectedAircraft, setSelectedAircraft, onNavigate }: { selectedAircraft: Aircraft; setSelectedAircraft: (item: Aircraft) => void; onNavigate: (page: Page) => void }) {
  return <TelemetryInspector key={selectedAircraft.id} aircraft={selectedAircraft} items={aircraft} setAircraft={setSelectedAircraft} goToFleet={() => onNavigate('fleet')} />
}

function CameraWallPage({ selectedAircraft, onNavigate }: { selectedAircraft: Aircraft; onNavigate: (page: Page) => void }) {
  const [selectedCamera, setSelectedCamera] = useState(cameras[0])
  const [frame, setFrame] = useState(12840)
  useEffect(() => { const timer = window.setInterval(() => setFrame((value) => value + 30), 1000); return () => window.clearInterval(timer) }, [])
  const liveCount = cameras.filter((camera) => camera.state === 'Live').length
  const stateTone = (state: CameraChannel['state']) => state === 'Live' ? 'green' : state === 'Degraded' ? 'orange' : 'red'
  const feedLabel = (camera: CameraChannel) => camera.tone === 'thermal' ? 'IR / °C' : camera.tone === 'down' ? 'NADIR / AGL' : 'EO / RGB'
  return <>
    <SimBanner />
    <SectionHeading eyebrow="Operations / video" title="Camera wall" detail="All available aircraft cameras in one read-only surface. Feed freshness and link health stay visible beside the picture." action={<div className="connection-state"><span className="status-dot green" /> Video gateway connected <span className="mono">/ SIM-VIDEO-01</span></div>} />
    <div className="camera-toolbar"><div className="monitor-select"><span className="eyebrow">Watching aircraft</span><strong>{selectedAircraft.name} <span className="tag">{selectedAircraft.environment}</span></strong></div><StatusPill tone="green">{liveCount} / {cameras.length} feeds live</StatusPill><StatusPill tone="blue">Read-only mosaic</StatusPill><button className="button ghost"><Icon name="external" size={14} /> Refresh manifest</button></div>
    <div className="camera-layout"><div className="camera-wall">{cameras.map((camera) => <button key={camera.id} className={`camera-card ${selectedCamera.id === camera.id ? 'selected' : ''}`} onClick={() => setSelectedCamera(camera)}><div className={`camera-visual ${camera.tone}`}><span className="camera-scanline" /><span className="camera-crosshair" /><span className="camera-caption">{feedLabel(camera)}</span><span className="camera-coordinates">SIM 14:40:12Z · {camera.id.slice(-3).toUpperCase()}</span><span className="camera-frame-number">FR {frame + cameras.indexOf(camera) * 7}</span><span className="camera-center-label">{camera.state === 'Stale' ? 'LAST KEYFRAME' : 'SYNTHETIC FEED'}</span></div><div className="camera-card-footer"><div><strong>{camera.label}</strong><small>{camera.position} · {camera.resolution} · {camera.fps} FPS</small></div><StatusPill tone={stateTone(camera.state)}>{camera.state}</StatusPill></div></button>)}</div><div className="panel camera-inspector"><div className="panel-title"><div><span className="eyebrow">Selected feed</span><h2>{selectedCamera.label}</h2></div><StatusPill tone={stateTone(selectedCamera.state)}>{selectedCamera.state}</StatusPill></div><div className={`camera-visual inspector-visual ${selectedCamera.tone}`}><span className="camera-scanline" /><span className="camera-crosshair" /><span className="camera-caption">{feedLabel(selectedCamera)}</span><span className="camera-coordinates">{selectedAircraft.id} · {selectedCamera.position}</span><span className="camera-center-label">{selectedCamera.state === 'Stale' ? 'STALE — LAST KEYFRAME' : 'LIVE SYNTHETIC FEED'}</span></div><div className="camera-detail-list"><div><span>Freshness</span><strong>{selectedCamera.freshness}</strong></div><div><span>Stream health</span><strong>{selectedCamera.signal}% <small>link</small></strong></div><div><span>Optics</span><strong>{selectedCamera.lens}</strong></div><div><span>Channel</span><strong className="mono">{selectedCamera.id} / {selectedCamera.resolution}</strong></div></div><div className="panel-footer"><span><span className={`status-dot ${stateTone(selectedCamera.state)}`} /> {selectedCamera.note}</span><span className="mono">FRAME {frame}</span></div></div></div>
    <div className="workspace-jumps"><button className="button ghost" onClick={() => onNavigate('ai')}>Image / video AI setup & workflows</button><span>Offline file workflows only · synthetic feeds are not media inputs</span></div><div className="video-boundary"><span className="note-icon"><Icon name="shield" /></span><div><strong>Video is an observation path, not a command path</strong><p>These feeds are synthetic and read-only. The browser receives a gateway-rendered stream manifest; it never connects to an aircraft camera, radio, gimbal, flight controller, or device credential.</p></div><span className="tag">SIM-VIDEO-01</span></div>
  </>
}

type TracegateStatus = 'READY' | 'READY_WITH_RESTRICTIONS' | 'REVIEW_REQUIRED' | 'BLOCKED_UNKNOWN'
type TracegateScenario = { id: string; label: string; status: TracegateStatus; closure: number; requirements: number; tests: number; reason: string }

const tracegateScenarios: TracegateScenario[] = [
  { id: 'camera-calibration', label: 'Sensor replacement + calibration update', status: 'REVIEW_REQUIRED', closure: 4, requirements: 2, tests: 3, reason: 'Human review required before scenario disposition' },
  { id: 'model-upgrade', label: 'Perception model revision', status: 'BLOCKED_UNKNOWN', closure: 3, requirements: 2, tests: 3, reason: 'Required latency test failed' },
  { id: 'payload-swap', label: 'Modular payload swap', status: 'READY_WITH_RESTRICTIONS', closure: 2, requirements: 1, tests: 1, reason: 'Ready only with recorded operating restriction' },
  { id: 'expired-evidence', label: 'Expired calibration evidence', status: 'BLOCKED_UNKNOWN', closure: 3, requirements: 2, tests: 3, reason: 'Mandatory evidence is stale or not run' },
  { id: 'configuration-conflict', label: 'Conflicting configuration identity', status: 'REVIEW_REQUIRED', closure: 4, requirements: 2, tests: 3, reason: 'Unresolved configuration conflict' },
]

function TracegatePanel() {
  const [scenarioId, setScenarioId] = useState(tracegateScenarios[0].id)
  const [reviewed, setReviewed] = useState(false)
  const scenario = tracegateScenarios.find((item) => item.id === scenarioId) ?? tracegateScenarios[0]
  const status = reviewed && scenario.status === 'REVIEW_REQUIRED' ? 'READY' : scenario.status
  const statusTone = status === 'READY' ? 'green' : status === 'REVIEW_REQUIRED' ? 'orange' : 'red'
  const statusCopy = reviewed && scenario.status === 'REVIEW_REQUIRED' ? 'Demo review recorded; evidence remains informational' : scenario.reason
  return <div className="panel tracegate-panel"><div className="panel-title"><div><span className="eyebrow">Tracegate / change-to-proof obligations</span><h2>Evidence readiness</h2></div><span className="tag">PROTOTYPE</span></div><div className="tracegate-body"><div className="tracegate-scenario"><label><span>Change scenario</span><select value={scenarioId} onChange={(event) => { setScenarioId(event.target.value); setReviewed(false) }}>{tracegateScenarios.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><span className="tracegate-event mono">TG-{scenario.id.toUpperCase()}</span></div><div className="tracegate-summary"><div className={`tracegate-seal ${statusTone}`}><span>{status === 'READY' ? '✓' : '!'}</span><small>{status.replaceAll('_', ' ')}</small></div><div><strong>{statusCopy}</strong><p>Deterministic graph closure, conservative test selection, and evidence classification for the digital twin only.</p></div></div><div className="tracegate-grid"><div><span>Impact closure</span><strong>{scenario.closure} nodes</strong></div><div><span>Affected requirements</span><strong>{scenario.requirements}</strong></div><div><span>Selected tests</span><strong>{scenario.tests}</strong></div><div><span>Policy</span><strong className="mono">RULES-0.1</strong></div></div><div className="tracegate-controls"><button className="button ghost" disabled={scenario.status !== 'REVIEW_REQUIRED'} onClick={() => setReviewed(true)}>{reviewed ? 'Demo review recorded' : 'Record demo review'}</button><span>Informational only · never a flight, safety, or release authorization</span></div></div></div>
}

type AutonomyMode = 'supervised' | 'bounded-route' | 'degraded-recovery' | 'confidence-hold'
const autonomyModes: Record<AutonomyMode, { label: string; detail: string; gate: string }> = {
  supervised: { label: 'Supervised autonomy rehearsal', detail: 'Twin proposes the next phase; trainee reviews each transition.', gate: 'Human review at every phase boundary' },
  'bounded-route': { label: 'Bounded route execution', detail: 'Twin follows a synthetic route inside the training geofence.', gate: 'Synthetic geofence + route checksum' },
  'degraded-recovery': { label: 'Degraded-link recovery', detail: 'Twin rehearses conservative behavior after a simulated link-quality drop.', gate: 'No transport; recovery is local to the twin' },
  'confidence-hold': { label: 'Sensor-confidence hold', detail: 'Twin pauses its simulated progression when confidence falls below threshold.', gate: 'Evidence review before resume' },
}

function AutonomyOperationsPanel() {
  const [mode, setMode] = useState<AutonomyMode>('supervised')
  const [state, setState] = useState<'Ready' | 'Running' | 'Paused' | 'Review'>('Ready')
  const [step, setStep] = useState(1)
  const [event, setEvent] = useState('Mode selected; transport remains closed')
  const current = autonomyModes[mode]
  const start = () => { setState('Running'); setStep((value) => Math.min(4, value + 1)); setEvent(`Simulated ${current.label.toLowerCase()} started`) }
  const pause = () => { setState('Paused'); setEvent('Simulation paused by trainee; no external command was issued') }
  const inject = () => { setState('Review'); setStep(3); setEvent(mode === 'degraded-recovery' ? 'Synthetic link degradation injected; recovery review required' : 'Synthetic confidence event injected; human review required') }
  const reset = () => { setState('Ready'); setStep(1); setEvent('Autonomy rehearsal reset to initial state') }
  return <div className="panel autonomy-panel"><div className="panel-title"><div><span className="eyebrow">Autonomy operations / simulation</span><h2>Mode manager</h2></div><div className="autonomy-badges"><StatusPill tone={state === 'Running' ? 'green' : state === 'Review' ? 'orange' : 'blue'}>{state}</StatusPill><span className="tag">SIM-AUTO-01</span></div></div><div className="autonomy-body"><div className="autonomy-controls"><label><span>Autonomous mode</span><select value={mode} onChange={(e) => { setMode(e.target.value as AutonomyMode); reset() }}>{Object.entries(autonomyModes).map(([id, item]) => <option key={id} value={id}>{item.label}</option>)}</select></label><div className="autonomy-actions"><button className="button orange" onClick={start} disabled={state === 'Running'}>Start simulated mode</button><button className="button ghost" onClick={pause} disabled={state !== 'Running'}>Pause</button><button className="button ghost" onClick={inject}>Inject review event</button><button className="button ghost" onClick={reset}>Reset</button></div></div><div className="autonomy-layout"><div className="autonomy-map"><div className="map-grid" /><span className="auto-map-label top">SYNTHETIC RANGE / NO GPS</span><span className="auto-map-label zone">TRAINING GEOFENCE</span><span className="auto-map-label home">HOME</span><svg viewBox="0 0 420 190" preserveAspectRatio="none" aria-label="Synthetic autonomy route map"><path className="auto-route" d="M55 145 C90 108 100 50 170 65 S230 160 285 116 S340 55 370 43" /><path className="auto-route-dashed" d="M55 145 C90 108 100 50 170 65 S230 160 285 116 S340 55 370 43" /><circle className="auto-node" cx="55" cy="145" r="7" /><circle className="auto-node" cx="170" cy="65" r="7" /><circle className="auto-node" cx="285" cy="116" r="7" /><circle className="auto-node" cx="370" cy="43" r="7" /></svg><div className="auto-map-legend"><span><i className="route-key" /> planned synthetic path</span><span><i className="node-key" /> checkpoint</span></div></div><div className="autonomy-detail"><span className="eyebrow">Selected mode</span><h3>{current.label}</h3><p>{current.detail}</p><div className="autonomy-gate"><Icon name="shield" size={14} /><span>{current.gate}</span></div><div className="autonomy-progress"><span>Lifecycle</span><div>{['Ready', 'Running', 'Review', 'Complete'].map((label, index) => <i key={label} className={index < step ? 'done' : index === step ? 'current' : ''}><b>{index + 1}</b><small>{label}</small></i>)}</div></div><div className="autonomy-event"><span className="status-dot orange" />{event}</div></div></div><div className="autonomy-boundary"><Icon name="lock" size={14} /><span>Simulation-only orchestration. No route, mode, recovery action, or autonomy state leaves this browser-local digital twin.</span></div></div></div>
}

type TwinState = { phase: 'Grounded' | 'Taxi' | 'Airborne' | 'Return to home'; altitude: number; heading: number; speed: number; battery: number; link: number }

type TrainingEvent = { time: string; command: string; detail: string; status: 'Applied' | 'Queued' | 'Blocked' }

function TrainingPage({ selectedAircraft }: { selectedAircraft: Aircraft }) {
  const [running, setRunning] = useState(false)
  const [scenarioTime, setScenarioTime] = useState(0)
  const [twin, setTwin] = useState<TwinState>({ phase: 'Grounded', altitude: 0, heading: 0, speed: 0, battery: 100, link: 100 })
  const [events, setEvents] = useState<TrainingEvent[]>([{ time: '00:00:00', command: 'Scenario loaded', detail: 'North range familiarization / digital twin only', status: 'Applied' }])
  useEffect(() => { if (!running) return; const timer = window.setInterval(() => { setScenarioTime((value) => value + 1); setTwin((value) => ({ ...value, battery: Math.max(0, value.battery - .02), link: Math.max(92, value.link - .01) })) }, 1000); return () => window.clearInterval(timer) }, [running])
  const stamp = (seconds: number) => `00:${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  const issue = (command: string, detail: string, patch: Partial<TwinState>) => { setTwin((value) => ({ ...value, ...patch })); setEvents((items) => [{ time: stamp(scenarioTime), command, detail, status: 'Applied' as const }, ...items].slice(0, 6)) }
  const toggleScenario = () => { setRunning((value) => !value); if (!running) issue('Scenario start', 'Simulation clock running; hardware transport remains closed', { phase: 'Taxi' }) }
  return <>
    <div className="training-banner"><span className="sim-mark">T</span><div><strong>DISCONNECTED TRAINING SANDBOX</strong><span>Commands apply only to the UCAS digital twin. Radio, autopilot, gimbal, payload, and aircraft transport are unavailable by construction.</span></div><span className="banner-code">TRAIN / DT-01</span></div>
    <SectionHeading eyebrow="Training / command rehearsal" title="Simulation C2 console" detail="Practice command sequencing, preflight discipline, and incident response against a deterministic aircraft twin." action={<div className="training-clock"><span className={`status-dot ${running ? 'green' : 'orange'}`} /> {running ? 'Scenario running' : 'Scenario paused'} <strong>{stamp(scenarioTime)}</strong></div>} />
    <div className="training-toolbar"><div className="monitor-select"><span className="eyebrow">Scenario</span><strong>North range familiarization <span className="tag">DIGITAL TWIN</span></strong></div><StatusPill tone="blue">{selectedAircraft.name}</StatusPill><button className="button orange" onClick={toggleScenario}><Icon name="pulse" size={14} /> {running ? 'Pause scenario' : 'Start scenario'}</button><button className="button ghost" onClick={() => { setRunning(false); setScenarioTime(0); setTwin({ phase: 'Grounded', altitude: 0, heading: 0, speed: 0, battery: 100, link: 100 }); setEvents([{ time: '00:00:00', command: 'Scenario reset', detail: 'Twin returned to safe ground state', status: 'Applied' }]) }}>Reset twin</button></div>
    <div className="training-grid"><div className="panel twin-panel"><div className="panel-title"><div><span className="eyebrow">Digital twin / state</span><h2>{selectedAircraft.name}</h2></div><StatusPill tone="green">Transport closed</StatusPill></div><div className="twin-map"><div className="map-grid" /><div className="range-label north">NORTH RANGE / TEST ONLY</div><div className="range-label home">HOME</div><div className="range-label zone">SAFE TRAINING ZONE</div><div className={`twin-marker ${running ? 'moving' : ''}`} style={{ left: `${35 + Math.min(35, twin.altitude / 4)}%`, top: `${63 - Math.min(34, twin.altitude / 4)}%` }}><span /><b>DT-001</b></div><div className="range-line" /></div><div className="twin-stats"><div><span>Phase</span><strong>{twin.phase}</strong></div><div><span>Altitude</span><strong>{twin.altitude.toFixed(0)} <small>m AGL</small></strong></div><div><span>Heading</span><strong>{String(twin.heading).padStart(3, '0')}°</strong></div><div><span>Ground speed</span><strong>{twin.speed.toFixed(1)} <small>m/s</small></strong></div><div><span>Battery</span><strong>{twin.battery.toFixed(0)}%</strong></div><div><span>Link</span><strong>{twin.link.toFixed(0)}%</strong></div></div></div><div className="panel gate-panel"><div className="panel-title"><div><span className="eyebrow">Safety gates</span><h2>Before any exercise</h2></div><span className="tag">6 / 6 PASS</span></div><div className="gate-list"><div><span className="gate-check">✓</span><div><strong>Digital twin selected</strong><small>sim-ucas-001 / no hardware identity</small></div></div><div><span className="gate-check">✓</span><div><strong>Transport disabled</strong><small>radio, MAVLink, serial, and network adapters closed</small></div></div><div><span className="gate-check">✓</span><div><strong>Command scope limited</strong><small>state changes are local to this browser session</small></div></div><div><span className="gate-check">✓</span><div><strong>Audit stream active</strong><small>every mock command receives a scenario timestamp</small></div></div><div><span className="gate-check">✓</span><div><strong>Geofence loaded</strong><small>safe training zone / no real coordinates</small></div></div><div><span className="gate-lock"><Icon name="lock" size={13} /></span><div><strong>Aircraft control path</strong><small>unavailable by construction</small></div></div></div></div></div>
    <AutonomyOperationsPanel /><TracegatePanel /><div className="training-lower"><div className="panel command-panel"><div className="panel-title"><div><span className="eyebrow">Mock command deck</span><h2>Digital-twin controls</h2></div><span className="tag">NO AIRCRAFT I/O</span></div><div className="command-groups"><div><span className="command-label">Flight phase</span><div className="command-row"><button className="button ghost" onClick={() => issue('Begin taxi', 'Twin moved to taxi phase', { phase: 'Taxi', speed: 4 })}>Begin taxi</button><button className="button ghost" onClick={() => issue('Takeoff', 'Twin transitioned to simulated airborne state', { phase: 'Airborne', altitude: 60, speed: 12 })}>Simulate takeoff</button><button className="button ghost" onClick={() => issue('Land', 'Twin returned to grounded state', { phase: 'Grounded', altitude: 0, speed: 0 })}>Simulate land</button></div></div><div><span className="command-label">Navigation intent</span><div className="command-row"><button className="button ghost" onClick={() => issue('Set altitude', 'Target altitude 120 m AGL', { altitude: 120, phase: 'Airborne' })}>Set 120 m</button><button className="button ghost" onClick={() => issue('Set heading', 'Target heading 042°', { heading: 42 })}>Set heading 042°</button><button className="button ghost" onClick={() => issue('Hold position', 'Twin holding current simulated position', { speed: 0 })}>Hold position</button><button className="button ghost" onClick={() => issue('Return to home', 'Twin following simulated home vector', { phase: 'Return to home', heading: 180, speed: 8 })}>Return to home</button></div></div></div><div className="command-warning"><Icon name="shield" size={16} /><span>Every control above mutates only the in-memory digital twin. There is no command API, radio transport, autopilot adapter, or real-aircraft identifier in this build.</span></div></div><div className="panel event-panel"><div className="panel-title"><div><span className="eyebrow">Audit / rehearsal</span><h2>Command queue</h2></div><span className="muted mono">latest 6</span></div><div className="training-events">{events.map((event, index) => <div key={`${event.time}-${event.command}-${index}`}><span className="event-time">{event.time}</span><StatusPill tone={event.status === 'Applied' ? 'green' : 'orange'}>{event.status}</StatusPill><div><strong>{event.command}</strong><small>{event.detail}</small></div></div>)}</div></div></div>
  </>
}

function MaintenancePage() {
  return <><SimBanner /><SectionHeading eyebrow="Operations / records" title="Maintenance" detail="Condition records stay separate from telemetry freshness and aircraft control." action={<button className="button orange"><Icon name="plus" size={15} /> New record</button>} /><div className="metric-grid"><MetricCard label="Open records" value="04" detail="Across 3 scoped articles" icon="file" tone="orange" /><MetricCard label="Due this week" value="01" detail="Battery inspection" icon="wrench" tone="blue" /><MetricCard label="Suspended articles" value="01" detail="No write access" icon="lock" tone="ink" /><MetricCard label="Last completed" value="2d" detail="UCAS / 001 · inspection" icon="shield" tone="green" /></div><div className="panel table-panel"><div className="panel-title"><div><span className="eyebrow">Maintenance register</span><h2>Assigned records</h2></div><div className="table-actions"><button className="filter-button">All statuses <Icon name="chevron" size={13} /></button><button className="filter-button">All aircraft <Icon name="chevron" size={13} /></button></div></div><table><thead><tr><th>Aircraft</th><th>Record</th><th>Status</th><th>Due / completed</th><th>Owner</th><th /></tr></thead><tbody><tr><td><strong>UCAS / 002</strong><small>SIMULATED · Heavy-lift</small></td><td><strong>Battery inspection</strong><small>MAINT-004 · scheduled</small></td><td><StatusPill tone="orange">Due soon</StatusPill></td><td>24 Oct 2026</td><td>Niko Okafor</td><td><button className="icon-button"><Icon name="more" /></button></td></tr><tr><td><strong>UCAS / 001</strong><small>SIMULATED · Quad-X</small></td><td><strong>Propeller check</strong><small>MAINT-003 · completed</small></td><td><StatusPill tone="green">Complete</StatusPill></td><td>15 Oct 2026</td><td>Maya Chen</td><td><button className="icon-button"><Icon name="more" /></button></td></tr><tr className="muted-row"><td><strong>UCAS / 007</strong><small>LAB · Fixed-wing</small></td><td><strong>Link isolation review</strong><small>MAINT-002 · held</small></td><td><StatusPill tone="red">Suspended</StatusPill></td><td>—</td><td>Access restricted</td><td><button className="icon-button" disabled><Icon name="lock" /></button></td></tr></tbody></table></div><div className="note-callout"><span className="note-icon"><Icon name="shield" /></span><div><strong>Read-only boundary preserved</strong><p>Maintenance notes do not create a command path. Lab and aircraft telemetry sources remain separately labeled throughout the record history.</p></div></div></>
}

function AccessPage({ catalog, currentUser, onSelectUser, onInvite, search, setSearch }: { catalog: RbacCatalog; currentUser: typeof personas[PersonaId]; onSelectUser: (user: User) => void; onInvite: () => void; search: string; setSearch: (value: string) => void }) {
  const filtered = users.filter((user) => `${user.name} ${user.email} ${user.scope}`.toLowerCase().includes(search.toLowerCase()))
  const roleName = (id: RoleId) => catalog.roles.find((role) => role.id === id)?.display_name ?? id
  return <><div className="access-header"><div><span className="eyebrow">Administration / people & policy</span><h1>Access management</h1><p>Explain who can see the fleet, why, and for how long.</p></div><button className="button orange" onClick={onInvite}><Icon name="plus" size={15} /> Invite user</button></div><div className="admin-safety"><span className="admin-safety-mark"><Icon name="shield" size={17} /></span><div><strong>Server authorization is authoritative</strong><span>The UI is an explanation surface. Every API, export, and live stream request is checked again at the service boundary.</span></div><span className="tag">POLICY v1.4</span></div><div className="metric-grid admin-metrics"><MetricCard label="Users" value="42" detail="38 active · 2 pending" icon="users" tone="ink" /><MetricCard label="Active assignments" value="77" detail="4 expire in 7 days" icon="shield" tone="orange" /><MetricCard label="Suspended" value="02" detail="No effective access" icon="lock" tone="blue" /><MetricCard label="MFA coverage" value="96%" detail="2 users need enrollment" icon="pulse" tone="green" /></div><div className="panel table-panel access-table"><div className="panel-title"><div><span className="eyebrow">Directory / delegated scope</span><h2>People and assignments</h2></div><div className="table-actions"><label className="search-box"><Icon name="search" size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search people or scope" /></label><button className="filter-button">All statuses <Icon name="chevron" size={13} /></button></div></div><table><thead><tr><th>Name</th><th>Role</th><th>Scope</th><th>Status</th><th>Expiry</th><th /></tr></thead><tbody>{filtered.map((user) => <tr key={user.id} onClick={() => onSelectUser(user)} className="clickable-row"><td><div className="person-cell"><span className="avatar">{user.initials}</span><span><strong>{user.name}</strong><small>{user.email}</small></span></div></td><td>{user.roles.map((role) => <span className="role-chip" key={role}>{roleName(role)}</span>)}</td><td><strong>{user.scope}</strong><small>{user.assignment} · Direct assignment</small></td><td><StatusPill tone={user.status === 'active' ? 'green' : user.status === 'suspended' ? 'red' : 'orange'}>{user.status}</StatusPill></td><td>{user.expiry}</td><td><Icon name="arrow" size={15} /></td></tr>)}</tbody></table>{filtered.length === 0 && <div className="empty-state"><span className="empty-mark"><Icon name="search" /></span><strong>No matching assignments</strong><p>Try another name, email, or scope.</p></div>}<div className="table-footer"><span>Showing {filtered.length} of 42 users</span><span>Access scope: <strong>{currentUser.name}</strong> · {currentUser.role}</span></div></div></>
}

function UserDetail({ user, catalog, onBack, onInvite, onToast }: { user: User; catalog: RbacCatalog; onBack: () => void; onInvite: () => void; onToast: (message: string) => void }) {
  const role = catalog.roles.find((item) => item.id === user.roles[0])
  const permissions = role?.permissions ?? []
  const descriptions = new Map(catalog.permissions.map((item) => [item.id, item.description]))
  return <><button className="back-link" onClick={onBack}><Icon name="arrow" size={14} /> Back to access</button><div className="detail-header"><div className="person-hero"><span className="avatar large">{user.initials}</span><div><span className="eyebrow">User access detail</span><h1>{user.name}</h1><p>{user.email} · Last sign-in {user.lastSeen}</p></div></div><div className="detail-actions"><StatusPill tone={user.status === 'active' ? 'green' : 'red'}>{user.status}</StatusPill><button className="button danger" onClick={() => onToast(`${user.name} suspension requires step-up authentication.`)}>{user.status === 'suspended' ? 'Reinstate user' : 'Suspend user'}</button></div></div><div className="user-meta"><span><Icon name="shield" size={14} /> MFA / {user.mfa}</span><span><Icon name="users" size={14} /> 2 active sessions</span><span><Icon name="lock" size={14} /> No aircraft control permission</span></div><div className="detail-columns"><div className="panel"><div className="panel-title"><div><span className="eyebrow">Resolved authorization</span><h2>Effective access</h2></div><span className="tag">LIVE DECISION</span></div><div className="effective-list">{permissions.map((permission) => <div key={permission}><span className="permission-icon"><Icon name={permission.endsWith('.write') ? 'wrench' : 'shield'} size={14} /></span><div><strong>{permission.replaceAll('.', ' / ')}</strong><small>{descriptions.get(permission) ?? 'Catalog description unavailable'}</small></div><span className="permission-source">{role?.display_name} · {user.scope}</span></div>)}</div></div><div className="panel assignment-card"><div className="panel-title"><div><span className="eyebrow">Assignment record</span><h2>{user.assignment}</h2></div><button className="icon-button"><Icon name="more" /></button></div><div className="assignment-fields"><div><span>Role</span><strong>{role?.display_name}</strong></div><div><span>Scope</span><strong>{user.scope}</strong></div><div><span>Source</span><strong>Direct assignment</strong></div><div><span>Expires</span><strong>{user.expiry}</strong></div><div><span>Version</span><strong>v3 <span className="muted">· optimistic lock</span></strong></div></div><div className="panel-footer"><button className="button ghost" onClick={onInvite}>Edit assignment</button><button className="text-button danger-text" onClick={() => onToast('Assignment revocation staged. Review screen opened.')}>Revoke assignment</button></div></div></div><div className="panel audit-mini"><div className="panel-title"><div><span className="eyebrow">Recent access changes</span><h2>Audit trail</h2></div><button className="text-button" onClick={() => onToast('Audit view selected.')}>View full audit <Icon name="arrow" size={14} /></button></div><div className="mini-audit"><span className="audit-time">17 Oct · 14:02 UTC</span><strong>assignment.updated</strong><span>by Avery Rivera</span><StatusPill tone="green">Success</StatusPill></div><div className="mini-audit"><span className="audit-time">10 Oct · 09:14 UTC</span><strong>session.revoked</strong><span>by Auth service</span><StatusPill tone="neutral">Recorded</StatusPill></div></div></>
}

function RolesPage({ catalog }: { catalog: RbacCatalog }) {
  return <><SectionHeading eyebrow="Administration / policy reference" title="Role catalog" detail="Immutable system roles keep permission semantics stable while scope stays explicit." action={<StatusPill tone="blue">Catalog v1.0</StatusPill>} /><div className="role-note"><Icon name="lock" size={17} /><span><strong>System roles are read-only.</strong> Custom roles are intentionally deferred until permission usage and approval workflows are reviewed.</span></div><div className="role-cards">{catalog.roles.map((role) => <div className="role-card panel" key={role.id}><div className="role-card-head"><div><span className="role-symbol">{role.display_name.slice(0, 1)}</span><div><h2>{role.display_name}</h2><span className="mono">{role.id}</span></div></div><span className="tag">IMMUTABLE</span></div><p>{role.id === 'telemetry-viewer' ? 'Read-only analyst, stakeholder, or support viewer.' : role.id === 'drone-operator' ? 'Authorized operator for assigned aircraft and operational records.' : role.id === 'access-administrator' ? 'Manages people, assignments, and access audit within delegated scope.' : 'Break-glass platform owner with enhanced audit and MFA.'}</p><div className="role-count"><strong>{role.permissions.length}</strong><span>permissions</span><span className="role-stream">{role.permissions.includes('telemetry.stream.read') ? 'Live stream access' : 'Policy access'}</span></div><div className="permission-tags">{role.permissions.map((permission) => <span key={permission}>{permission}</span>)}</div></div>)}</div><div className="note-callout"><span className="note-icon"><Icon name="shield" /></span><div><strong>No aircraft-control permissions exist in this catalog</strong><p>Commands, mission changes, autonomy authorization, and device credentials remain outside this management surface by design.</p></div></div></>
}

function AuditPage() {
  return <><SectionHeading eyebrow="Administration / traceability" title="Access audit" detail="Policy changes are recorded as metadata. Secrets, tokens, and telemetry payloads never appear here." action={<button className="button ghost"><Icon name="external" size={14} /> Export metadata</button>} /><div className="audit-filters"><label className="search-box"><Icon name="search" size={16} /><input placeholder="Search actor, target, request ID" /></label><button className="filter-button">All actions <Icon name="chevron" size={13} /></button><button className="filter-button">Last 7 days <Icon name="chevron" size={13} /></button><StatusPill tone="green">Metadata only</StatusPill></div><div className="panel table-panel"><table><thead><tr><th>Time (UTC)</th><th>Actor</th><th>Action</th><th>Target</th><th>Scope</th><th>Result</th></tr></thead><tbody><tr><td className="mono">17 Oct · 14:02</td><td><strong>Avery Rivera</strong><small>user-admin-01</small></td><td><span className="audit-action">assignment.updated</span></td><td>Jules Chen</td><td>Aircraft / sim-ucas-001</td><td><StatusPill tone="green">Success</StatusPill></td></tr><tr><td className="mono">17 Oct · 13:55</td><td><strong>Auth service</strong><small>system</small></td><td><span className="audit-action">login.failed</span></td><td>Jules Chen</td><td>—</td><td><StatusPill tone="red">Denied</StatusPill></td></tr><tr><td className="mono">16 Oct · 09:24</td><td><strong>Avery Rivera</strong><small>user-admin-01</small></td><td><span className="audit-action">assignment.created</span></td><td>Niko Okafor</td><td>Fleet / North test range</td><td><StatusPill tone="green">Success</StatusPill></td></tr><tr><td className="mono">10 Oct · 09:14</td><td><strong>Auth service</strong><small>system</small></td><td><span className="audit-action">session.revoked</span></td><td>Mina Patel</td><td>Organization</td><td><StatusPill tone="neutral">Recorded</StatusPill></td></tr></tbody></table><div className="table-footer"><span>Showing 4 of 128 events</span><span>Retention / 365 days · request IDs preserved</span></div></div><div className="audit-guard"><Icon name="lock" size={17} /><div><strong>Audit detail stays safe to inspect</strong><p>Before/after assignment state, request ID, authentication method, and policy version are retained. Bearer tokens, JWT payloads, private keys, and raw authorization headers are excluded.</p></div></div></>
}

function InviteModal({ catalog, onClose, onToast }: { catalog: RbacCatalog; onClose: () => void; onToast: (message: string) => void }) {
  const [step, setStep] = useState(1)
  const [role, setRole] = useState<RoleId>('telemetry-viewer')
  const [scope, setScope] = useState('Aircraft / sim-ucas-001')
  const roleData = catalog.roles.find((item) => item.id === role)
  return <div className="modal-backdrop" onMouseDown={onClose}><div className="modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-top"><div><span className="eyebrow">Access change / new assignment</span><h2>Invite a user</h2></div><button className="icon-button" onClick={onClose}><Icon name="close" /></button></div><div className="stepper"><span className={step >= 1 ? 'current' : ''}>01 <b>Identity</b></span><i /><span className={step >= 2 ? 'current' : ''}>02 <b>Role</b></span><i /><span className={step >= 3 ? 'current' : ''}>03 <b>Scope</b></span><i /><span className={step >= 4 ? 'current' : ''}>04 <b>Review</b></span></div>{step === 1 && <div className="form-stack"><label>Display name<input defaultValue="Sam Taylor" /></label><label>Email address<input defaultValue="sam.taylor@example.test" /></label><label>Identity provider<select><option>Managed identity / synthetic</option><option>OIDC provider / pending</option></select></label></div>}{step === 2 && <div className="role-select-list">{catalog.roles.filter((item) => item.id !== 'system-administrator').map((item) => <button key={item.id} className={role === item.id ? 'role-select selected' : 'role-select'} onClick={() => setRole(item.id)}><span className="role-symbol">{item.display_name.slice(0, 1)}</span><span><strong>{item.display_name}</strong><small>{item.permissions.length} permissions · {item.permissions.includes('telemetry.stream.read') ? 'Can read live stream' : 'Policy administration'}</small></span><span className="radio-dot" /></button>)}</div>}{step === 3 && <div className="form-stack"><label>Resource scope<select value={scope} onChange={(event) => setScope(event.target.value)}><option>Aircraft / sim-ucas-001</option><option>Fleet / North test range</option><option>Site / Test operations</option></select></label><label>Access expires<select><option>24 Oct 2026 · 7 days</option><option>No expiry · requires approval</option><option>31 Dec 2026 · 75 days</option></select></label><label>Reason<textarea defaultValue="Synthetic telemetry review and operations support" /></label><div className="scope-preview"><Icon name="pulse" size={15} /><span>This scope includes <strong>2 simulated telemetry surfaces</strong>. It does not grant aircraft control.</span></div></div>}{step === 4 && <div className="review-stack"><div className="review-card"><span>Identity</span><strong>Sam Taylor</strong><small>sam.taylor@example.test</small></div><div className="review-card"><span>Role</span><strong>{roleData?.display_name}</strong><small>{roleData?.permissions.length} permissions from RBAC catalog v1.0</small></div><div className="review-card"><span>Scope & expiry</span><strong>{scope}</strong><small>Expires 24 Oct 2026 · Direct assignment</small></div><div className="review-warning"><Icon name="shield" size={16} /><span>Granting this assignment allows the user to read the selected telemetry scope. It does not grant aircraft control.</span></div></div>}<div className="modal-actions"><button className="button ghost" onClick={step === 1 ? onClose : () => setStep(step - 1)}>{step === 1 ? 'Cancel' : 'Back'}</button>{step < 4 ? <button className="button orange" onClick={() => setStep(step + 1)}>Continue <Icon name="arrow" size={14} /></button> : <button className="button orange" onClick={() => { onClose(); onToast('Assignment review saved as a synthetic audit event.') }}>Save and record audit event</button>}</div></div></div>
}

function App() {
  const [page, setPage] = useState<Page>(pageFromLocation)
  const [persona, setPersona] = useState<PersonaId>('access-admin')
  const [selectedAircraft, setSelectedAircraft] = useState(aircraft[0])
  const [selectedUser, setSelectedUser] = useState<User | null>(null)
  const [catalog, setCatalog] = useState<RbacCatalog | null>(null)
  const [catalogError, setCatalogError] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [toast, setToast] = useState('')
  const currentUser = personas[persona]

  useEffect(() => {
    fetch('/rbac-catalog.json').then((response) => { if (!response.ok) throw new Error('catalog') ; return response.json() as Promise<RbacCatalog> }).then(setCatalog).catch(() => setCatalogError(true))
  }, [])

  useEffect(() => {
    const update = () => setPage(pageFromLocation())
    window.addEventListener('hashchange', update)
    window.addEventListener('popstate', update)
    return () => { window.removeEventListener('hashchange', update); window.removeEventListener('popstate', update) }
  }, [])

  useEffect(() => { if (toast) { const timer = window.setTimeout(() => setToast(''), 3200); return () => window.clearTimeout(timer) } }, [toast])

  const navigate = (next: Page) => { setSelectedUser(null); setPage(next); window.history.pushState({}, '', next === 'fleet' ? '/' : `/${next}`) }
  const allowedPage = currentUser.allowed.includes(page)
  const roleCatalog = catalog ?? { permissions: [], roles: [] }
  const pageContent = useMemo(() => {
    if (catalogError) return <div className="full-state error-state"><Icon name="lock" size={24} /><strong>RBAC catalog unavailable</strong><p>Permission definitions could not be loaded. No access controls are enabled.</p></div>
    if (!catalog) return <div className="full-state"><span className="spinner" /><strong>Loading policy catalog</strong><p>Reading the canonical RBAC contract before rendering access controls.</p></div>
    if (!allowedPage) return <div className="full-state denied-state"><span className="denied-mark"><Icon name="lock" size={22} /></span><strong>Access not assigned</strong><p>Your server-resolved role does not include this surface. This view is hidden from navigation and remains protected at the API boundary.</p><button className="button ghost" onClick={() => navigate('fleet')}>Return to fleet</button></div>
    if (selectedUser && page === 'access') return <UserDetail user={selectedUser} catalog={catalog} onBack={() => setSelectedUser(null)} onInvite={() => setInviteOpen(true)} onToast={setToast} />
    if (page === 'fleet') return <><WorkspaceWelcome navigate={navigate} /><FleetPage onNavigate={navigate} selectedAircraft={selectedAircraft} setSelectedAircraft={setSelectedAircraft} /></>
    if (page === 'monitor') return <MonitorPage selectedAircraft={selectedAircraft} setSelectedAircraft={setSelectedAircraft} onNavigate={navigate} />
    if (page === 'observations') return <Observations />
    if (page === 'worldview') return <Suspense fallback={<div className="full-state">Loading read-only World View…</div>}><WorldView /></Suspense>
    if (page === 'reports') return <Reports />
    if (page === 'ai') return <LocalAIWorkbench />
    if (page === 'cameras') return <CameraWallPage selectedAircraft={selectedAircraft} onNavigate={navigate} />
    if (page === 'missions') return <MissionAutonomy />
    if (page === 'training') return <TrainingPage selectedAircraft={selectedAircraft} />
    if (page === 'maintenance') return <MaintenancePage />
    if (page === 'access') return <AccessPage catalog={catalog} currentUser={currentUser} onSelectUser={setSelectedUser} onInvite={() => setInviteOpen(true)} search={search} setSearch={setSearch} />
    if (page === 'roles') return <RolesPage catalog={catalog} />
    return <AuditPage />
  }, [catalog, catalogError, allowedPage, page, selectedUser, selectedAircraft, currentUser, search])

  const nav = [{ id: 'fleet' as Page, label: 'Fleet', icon: 'grid' }, { id: 'monitor' as Page, label: 'Telemetry', icon: 'pulse' }, { id: 'observations' as Page, label: 'Observations', icon: 'grid' }, { id: 'worldview' as Page, label: 'World View', icon: 'search' }, { id: 'reports' as Page, label: 'Reports & documents', icon: 'file' }, { id: 'ai' as Page, label: 'Local AI & media', icon: 'shield' }, { id: 'cameras' as Page, label: 'Camera wall', icon: 'camera' }, { id: 'missions' as Page, label: 'Mission Autonomy', icon: 'grid' }, { id: 'training' as Page, label: 'Training C2', icon: 'shield' }, { id: 'maintenance' as Page, label: 'Maintenance', icon: 'wrench' }, ...(currentUser.allowed.includes('access') ? [{ id: 'access' as Page, label: 'Access management', icon: 'users' }, { id: 'roles' as Page, label: 'Role catalog', icon: 'shield' }, { id: 'audit' as Page, label: 'Access audit', icon: 'file' }] : [])]
  return <div className="app-shell"><aside className="sidebar"><div className="brand"><span className="brand-mark"><i /><i /><i /></span><span><strong>SignalWarden AI</strong><small>observation / intelligence</small></span></div><div className="environment-chip"><span className="status-dot orange" /><span><strong>SIMULATION</strong><small>read-only environment</small></span></div><nav className="main-nav">{nav.map((item) => <button key={item.id} className={page === item.id ? 'nav-item active' : 'nav-item'} onClick={() => navigate(item.id)}><Icon name={item.icon} /><span>{item.label}</span>{item.id === 'monitor' && <em>DEMO</em>}</button>)}</nav><div className="sidebar-bottom"><div className="help-card"><span className="help-ornament">+</span><strong>Evidence before inference</strong><p>Review source uncertainty and exact evidence citations.</p><button onClick={() => navigate('observations')}>Open workspace <Icon name="arrow" size={13} /></button></div><div className="sidebar-meta"><span>SIGNALWARDEN AI / REFERENCE</span><span>v0.1.0 · policy 1.4</span></div></div></aside><main className="main"><header className="topbar"><div className="breadcrumbs"><span>SIGNALWARDEN AI</span><b>/</b><strong>{titleFor(page)}</strong></div><div className="top-actions"><span className="secure-status"><Icon name="lock" size={13} /> {'Local reference · demo persona only'}</span><button className="icon-button notification" aria-label="Notifications"><Icon name="bell" size={18} /><i /></button><label className="persona-select"><span className="avatar tiny">{currentUser.initials}</span><select value={persona} onChange={(event) => { setPersona(event.target.value as PersonaId); setSelectedUser(null); if (!personas[event.target.value as PersonaId].allowed.includes(page)) navigate('fleet') }}><option value="access-admin">Avery Rivera · Access Admin</option><option value="operator">Maya Chen · Drone Operator</option><option value="viewer">Jonas Reed · Viewer</option></select><Icon name="chevron" size={13} /></label></div></header><div className="content">{pageContent}</div></main>{inviteOpen && catalog && <InviteModal catalog={catalog} onClose={() => setInviteOpen(false)} onToast={setToast} />}{toast && <div className="toast"><span className="toast-check">✓</span>{toast}</div>}</div>
}

createRoot(document.getElementById('root')!).render(<App />)
