import { useEffect, useMemo, useState } from 'react'
import './local-ai-workbench.css'
import BrowserModelInstaller from './BrowserModelInstaller'
import LocalAIInference from './LocalAIInference'
import { commandFor, externalConfiguration, registryStatusCommand, smokeCommand } from './local-ai-workbench-commands'

type Group = 'llm' | 'image-generation' | 'video-generation' | 'image-classification' | 'video-classification'
type Device = 'cpu' | 'cuda'
type Availability = 'available' | 'blocked' | 'unknown'

export type LocalAIWorkbenchProps = {
  /** Optional server-reported facts. An omitted value is intentionally shown as unknown. */
  modelStatus?: Partial<Record<Group, { availability: Availability; detail: string }>>
  repositoryRoot?: string
}

type ModelCard = {
  group: Group
  label: string
  model: string
  download: string
  disk: string
  ram: string
  vram: string
  device: string
  license: string
  notes: string
  source: string
  smoke: string
}

const models: ModelCard[] = [
  { group: 'llm', label: 'Language model', model: 'Qwen/Qwen3-0.6B', download: '1.519 GB', disk: '8 GiB', ram: '6 GiB', vram: 'about 3 GiB', device: 'CPU or CUDA', license: 'Apache-2.0', notes: 'Short, bounded prompts only; model output is advisory.', source: 'https://huggingface.co/Qwen/Qwen3-0.6B', smoke: 'smoke --group llm --device cpu' },
  { group: 'image-generation', label: 'Image generation', model: 'segmind/SSD-1B (fp16)', download: '4.469 GB', disk: '14 GiB', ram: '16 GiB', vram: '8 GiB+', device: 'CPU (slow) or CUDA', license: 'Apache-2.0*', notes: 'Tiny 256×256 smoke only; not an operational image workflow.', source: 'https://huggingface.co/segmind/SSD-1B', smoke: 'smoke --group image-generation --device cuda --output "$UCAS_AI_HOME/outputs/image-smoke.png"' },
  { group: 'video-generation', label: 'Video generation', model: 'Wan2.1 T2V 1.3B Diffusers', download: '28.929 GB', disk: '42 GiB', ram: '48 GiB free / 64 GiB installed', vram: '16 GiB+', device: 'CUDA required', license: 'Apache-2.0', notes: 'Nine-frame GIF smoke; no practical CPU path.', source: 'https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B-Diffusers', smoke: 'smoke --group video-generation --device cuda --output "$UCAS_AI_HOME/outputs/video-smoke.gif"' },
  { group: 'image-classification', label: 'Image classification', model: 'microsoft/resnet-18', download: '0.047 GB', disk: '4 GiB', ram: '2 GiB', vram: 'about 1 GiB', device: 'CPU or CUDA', license: 'Apache-2.0', notes: 'Synthetic geometric fixture; ImageNet labels are not drone-observation validation.', source: 'https://huggingface.co/microsoft/resnet-18', smoke: 'smoke --group image-classification --device cpu --output "$UCAS_AI_HOME/outputs/image-classification-fixture.png"' },
  { group: 'video-classification', label: 'Video classification', model: 'microsoft/xclip-base-patch32', download: '0.790 GB', disk: '6 GiB', ram: '6 GiB', vram: 'about 3 GiB', device: 'CPU or CUDA', license: 'MIT', notes: 'Eight synthetic frames and fixed candidates; scores are not calibrated confidence.', source: 'https://huggingface.co/microsoft/xclip-base-patch32', smoke: 'smoke --group video-classification --device cpu --output "$UCAS_AI_HOME/outputs/video-classification-fixture.gif"' },
]

const groups: Group[] = models.map(({ group }) => group)

function statusLabel(status: { availability: Availability; detail: string } | undefined) {
  if (!status) return { text: 'Not checked', tone: 'neutral', detail: 'The browser cannot inspect local files, venvs, model hashes, RAM, or VRAM.' }
  if (status.availability === 'available') return { text: 'Reported ready', tone: 'green', detail: status.detail }
  if (status.availability === 'blocked') return { text: 'Blocked', tone: 'red', detail: status.detail }
  return { text: 'Unknown', tone: 'orange', detail: status.detail }
}

export function LocalAIWorkbench({ modelStatus, repositoryRoot = '.' }: LocalAIWorkbenchProps = {}) {
  const [selectedGroup, setSelectedGroup] = useState<Group>('llm')
  const [device, setDevice] = useState<Device>('cpu')
  const [copied, setCopied] = useState<string | null>(null)
  const [copyError, setCopyError] = useState<string | null>(null)
  const [externalOptIn, setExternalOptIn] = useState(false)
  const selected = useMemo(() => models.find((item) => item.group === selectedGroup)!, [selectedGroup])
  const selectedStatus = statusLabel(modelStatus?.[selectedGroup])

  useEffect(() => {
    if (selectedGroup === 'video-generation' && device !== 'cuda') setDevice('cuda')
  }, [selectedGroup, device])

  async function copy(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(id)
      setCopyError(null)
      window.setTimeout(() => setCopied((current) => current === id ? null : current), 1800)
    } catch {
      setCopied(null)
      setCopyError(id)
    }
  }

  const planCommand = commandFor(repositoryRoot, selectedGroup, device, 'plan')
  const statusCommand = registryStatusCommand(repositoryRoot)
  const setupCommand = commandFor(repositoryRoot, selectedGroup, device, 'setup')
  const downloadCommand = commandFor(repositoryRoot, selectedGroup, device, 'download')
  const verifyCommand = commandFor(repositoryRoot, selectedGroup, device, 'verify')
  const smoke = smokeCommand(repositoryRoot, selectedGroup, device)
  const externalCommand = externalConfiguration(selected.model)
  const serverCommand = `UCAS_LATTICE_MODE=mock UCAS_AI_MODE=local UCAS_AI_LOCAL_RUNTIME=openai-compatible \\\nUCAS_AI_LOCAL_MODEL=Qwen/Qwen3-0.6B UCAS_LATTICE_AI_ENDPOINT=http://127.0.0.1:8080 \\\npython services/management-api/app.py`

  return <section className="lai-workbench" aria-labelledby="lai-title">
    <header className="lai-header">
      <div><span className="eyebrow">SignalWarden AI / operator setup</span><h1 id="lai-title">Local AI workbench</h1><p>Optional, explicit model installation from your browser, with separate smoke testing. No weights download at startup.</p></div>
      <span className="status-pill orange"><span className="status-dot orange" /> NO AUTO-DOWNLOAD</span>
    </header>

    <section className="lai-notice" role="note"><strong>Bounded installation boundary</strong><span>Authorized browser actions can install isolated runtimes and download or verify pinned models on the Management API host. They do not start inference, change provider configuration, ingest camera media, or link any output to a vehicle or effector.</span></section>

    <section className="lai-grid">
      <div className="panel lai-panel">
        <div className="panel-title"><div><span className="eyebrow">01 / choose a pinned snapshot</span><h2>Model groups</h2></div><span className="tag">5 OPTIONAL GROUPS</span></div>
        <div className="lai-model-list">{models.map((item) => { const state = statusLabel(modelStatus?.[item.group]); return <button type="button" className={`lai-model-row ${selectedGroup === item.group ? 'selected' : ''}`} key={item.group} onClick={() => setSelectedGroup(item.group)}><span className="lai-model-index">{String(groups.indexOf(item.group) + 1).padStart(2, '0')}</span><span><strong>{item.label}</strong><small>{item.model}</small></span><span className={`status-pill ${state.tone}`}>{state.text}</span></button> })}</div>
        <div className="lai-status-detail"><strong>{selectedStatus.text}</strong><span>{selectedStatus.detail}</span></div>
      </div>

      <div className="panel lai-panel lai-detail">
        <div className="panel-title"><div><span className="eyebrow">02 / selected model</span><h2>{selected.label}</h2></div><a className="text-button" href={selected.source} target="_blank" rel="noreferrer">Model card ↗</a></div>
        <dl className="lai-facts"><div><dt>Snapshot</dt><dd>{selected.model}</dd></div><div><dt>Download</dt><dd>{selected.download}</dd></div><div><dt>Disk budget</dt><dd>{selected.disk}</dd></div><div><dt>Available RAM</dt><dd>{selected.ram}</dd></div><div><dt>VRAM guidance</dt><dd>{selected.vram}</dd></div><div><dt>Runtime / license</dt><dd>{selected.device} · {selected.license}</dd></div></dl>
        <p className="lai-caveat">{selected.notes}</p>
        <label className="lai-select-label">Setup device<select value={device} onChange={(event) => setDevice(event.target.value as Device)}><option value="cpu" disabled={selectedGroup === 'video-generation'}>CPU{selectedGroup === 'video-generation' ? ' (unavailable for video generation)' : ''}</option><option value="cuda">CUDA (NVIDIA)</option></select></label>
      </div>
    </section>

    <BrowserModelInstaller group={selectedGroup} device={device} source={selected.source} />

    <LocalAIInference selectedGroup={selectedGroup} selectedDevice={device} />

    <section className="panel lai-panel lai-commands"><div className="panel-title"><div><span className="eyebrow">Optional / advanced shell handoff</span><h2>Install, verify, then smoke-test</h2></div><span className="tag">MANUAL ALTERNATIVE</span></div><p className="lai-intro">Check the pinned registry and local resource status before setup or download. These commands mirror <code>scripts/local_ai_setup.py</code> and <code>scripts/local_ai_run.py</code>; installation and model download are separate.</p>{[['registry plan', planCommand], ['registry status (doctor)', statusCommand], ['setup', setupCommand], ['download', downloadCommand], ['verify', verifyCommand], ['smoke', smoke]].map(([label, command]) => <div className="lai-command" key={label}><div><span>{label}</span><code>{command}</code></div><button type="button" className="button ghost" onClick={() => void copy(command, label)}>{copied === label ? 'Copied' : 'Copy'}</button></div>)}{copyError && <p className="lai-copy-error" role="status">Copy failed for “{copyError}”. Select the command text and copy it manually, or use your terminal’s normal clipboard tools.</p>}</section>

    <section className="lai-grid lai-lower-grid">
      <div className="panel lai-panel"><div className="panel-title"><div><span className="eyebrow">04 / media entry points</span><h2>Bounded local media</h2></div><span className="tag">EXPLICIT SUBMIT</span></div><p>The inference panel accepts only the selected PNG/JPEG image or MP4/GIF video, within the displayed client limits. The server validates duration and dimensions before any worker runs.</p><ul className="lai-bullets"><li><strong>Generation:</strong> synthetic demo/training output, labeled advisory and never an operational asset.</li><li><strong>Classification:</strong> scores are relative model outputs, not calibrated confidence or physical truth.</li><li><strong>Blocked:</strong> no automatic upload, hosted media API, camera ingestion, or vehicle/effector linkage.</li></ul></div>
      <div className="panel lai-panel"><div className="panel-title"><div><span className="eyebrow">05 / workspace connection</span><h2>Local LLM server</h2></div><span className="status-pill blue">LOOPBACK ONLY</span></div><p>Only the LLM has a workspace integration path. Start the verified server separately on literal loopback, then configure the Management API server-side.</p><div className="lai-code-block"><code>"$UCAS_AI_HOME/venvs/llm/bin/python" {repositoryRoot}/scripts/local_ai_run.py serve-llm --host 127.0.0.1 --port 8080 --device {device}</code><button type="button" className="button ghost" onClick={() => void copy(serverCommand, 'server')}>{copied === 'server' ? 'Copied' : 'Copy env config'}</button></div><p className="lai-small">The browser cannot apply these environment variables. Do not put provider credentials in browser settings. The API forwards only aggregate data-quality counts for local assistance: no observation IDs, coordinates, or source text.</p></div>
    </section>

    <section className="panel lai-panel lai-disclosure"><div className="panel-title"><div><span className="eyebrow">06 / provider boundary</span><h2>External AI is opt-in, never an automatic fallback</h2></div><label className="lai-checkbox"><input type="checkbox" checked={externalOptIn} onChange={(event) => setExternalOptIn(event.target.checked)} /> I understand data may leave this system</label></div><div className={externalOptIn ? 'lai-egress active' : 'lai-egress'}><strong>{externalOptIn ? 'EXTERNAL AI OPT-IN ACKNOWLEDGED — CONFIGURATION STILL NOT APPLIED' : 'No external request from this screen · server status not checked'}</strong><p>{externalOptIn ? 'This acknowledgement changes no server setting. Configuration is NOT applied here; an administrator must run the handoff in a trusted server shell and document provider, destination, retained data, and consent before sending.' : <>No external request is made from this screen. Check <a href="/observations#ob-advisory">current provider/mode/model availability</a> in the server-reported advisory status.</>}</p>{externalOptIn && <div className="lai-external-handoff"><span>Trusted server-shell handoff for an external provider model</span><code>{externalCommand}</code><p>The API destination is fixed to <code>https://api.openai.com/v1/chat/completions</code>. Export the key as <code>UCAS_AI_EXTERNAL_API_KEY</code> in the trusted server shell, then restart or relaunch the API. Never enter or copy a provider credential into browser settings. Configuration NOT applied.</p><button type="button" className="button ghost" onClick={() => void copy(externalCommand, 'external')}>{copied === 'external' ? 'Copied' : 'Copy handoff'}</button></div>}</div><p className="lai-small">If local inference is unavailable, SignalWarden uses its deterministic rules fallback for bounded assistance. That fallback is explicitly labeled as rules-based; it does not imply that a model ran or that media was analyzed.</p></section>
  </section>
}

export default LocalAIWorkbench
