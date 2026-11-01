import { useEffect, useRef, useState } from 'react'
import { activeJob, installerRequest, startInstall } from './local-ai-installer'
import type { InstallAction, InstallDevice, InstallJob, InstallerStatus, ModelGroup } from './local-ai-installer'

type Props = { group: ModelGroup; device: InstallDevice; source: string }
const describeError = (error: unknown) => error instanceof Error ? error.message : 'Installer request failed. Reconnect to check server state.'
const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`

export default function BrowserModelInstaller({ group, device, source }: Props) {
  const [token, setToken] = useState('')
  const [status, setStatus] = useState<InstallerStatus | null>(null)
  const [job, setJob] = useState<InstallJob | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reviewed, setReviewed] = useState(false)
  const [license, setLicense] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const generation = useRef(0)
  const plan = status?.groups.find((item) => item.group === group)
  const running = activeJob(job)
  const mismatch = plan?.runtimeInstalled && plan.device !== device

  useEffect(() => { setReviewed(false); setLicense(false) }, [group, device, status])
  useEffect(() => () => { generation.current += 1 }, [])

  async function connect() {
    const current = generation.current
    setBusy(true); setError(null)
    try {
      const next = await installerRequest<InstallerStatus>(token, 'status')
      if (current !== generation.current) return
      setStatus(next); setJob(next.job); setUncertain(false)
    } catch (err) { if (current === generation.current) { setError(describeError(err)); setStatus(null) } }
    finally { if (current === generation.current) setBusy(false) }
  }

  useEffect(() => {
    if (!running || !job) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await installerRequest<InstallJob>(token, `jobs/${encodeURIComponent(job.id)}`)
        if (stopped) return
        setJob(next); setError(null)
        if (!activeJob(next)) {
          // Refresh environment facts only, never infer readiness from installed weights.
          const fresh = await installerRequest<InstallerStatus>(token, 'status')
          if (!stopped) setStatus(fresh)
          return
        }
      } catch (err) { if (!stopped) setError(`${describeError(err)} Job status is unknown until connection recovers.`) }
      if (!stopped) timer = setTimeout(poll, 2000)
    }
    timer = setTimeout(poll, 1000)
    return () => { stopped = true; clearTimeout(timer) }
  }, [job?.id, running, token])

  async function launch(action: InstallAction) {
    const current = generation.current
    setBusy(true); setError(null)
    try {
      const next = await startInstall(token, group, device, action, license)
      if (current === generation.current) { setJob(next); setReviewed(false) }
    } catch (err) {
      // A network timeout can happen after acceptance. Require a status refresh before another POST.
      if (current === generation.current) { setError(describeError(err)); setUncertain(true) }
    } finally { if (current === generation.current) setBusy(false) }
  }

  async function cancel() {
    if (!job) return
    const current = generation.current
    setBusy(true); setError(null)
    try {
      const next = await installerRequest<InstallJob>(token, `jobs/${encodeURIComponent(job.id)}/cancel`, {})
      if (current === generation.current) setJob(next)
    } catch (err) { if (current === generation.current) setError(describeError(err)) }
    finally { if (current === generation.current) setBusy(false) }
  }

  const locked = busy || running || uncertain || !status?.enabled || !plan || !reviewed
  return <section className="panel lai-panel lai-installer" aria-labelledby="lai-installer-title">
    <div className="panel-title"><div><span className="eyebrow">03 / browser-launched setup</span><h2 id="lai-installer-title">Model Download and Installation</h2></div><span className="tag">EXPLICIT ADMIN ACTION</span></div>
    <p className="lai-intro">Launch the pinned installer on the <strong>Management API host</strong>, not on the computer running this browser. No download runs automatically. Installation contacts PyTorch and PyPI; model downloads contact Hugging Face. This does not start inference or enable external AI.</p>
    <div className="lai-install-body">
      <div className="lai-install-connect"><label>Installer administrator token<input type="password" autoComplete="off" spellCheck={false} value={token} onChange={(event) => { generation.current += 1; setToken(event.target.value); setStatus(null); setJob(null); setReviewed(false); setLicense(false); setError(null); setBusy(false); setUncertain(false) }} /></label><button type="button" className="button ghost" disabled={!token || busy} onClick={() => void connect()}>{busy ? 'Contacting server…' : status ? 'Refresh server status' : 'Connect to installer'}</button></div>
      <p className="lai-small">Server-side opt-in and an allowed browser origin are required. The token is held only in this screen’s memory; use HTTPS outside loopback. See <code>docs/local-ai-browser-setup.md</code> for administrator setup. Navigating away does not cancel a server job.</p>
      {status && <div className="lai-install-plan"><strong>Installation target: {status.host}</strong><code>{status.cacheRoot}</code>{plan && <><dl className="lai-facts"><div><dt>Pinned repository / license</dt><dd>{plan.repo_id} · {plan.license}</dd></div><div><dt>Immutable revision</dt><dd>{plan.revision}</dd></div><div><dt>Model download / free disk</dt><dd>{gib(plan.download_bytes)} / {gib(plan.free_bytes)}</dd></div><div><dt>Runtime environment</dt><dd>{plan.runtimeInstalled ? `Present (${plan.device ?? 'unknown device'}) — not an inference readiness check` : 'Not installed'}</dd></div></dl>{plan.warnings.map((warning) => <p className="lai-small" key={warning}>{warning}</p>)}{!plan.free_enough && <p className="lai-copy-error">Disk is below the model’s planning budget. Free space before installation or download.</p>}{mismatch && <p className="lai-copy-error">Existing runtime uses {plan.device ?? 'an unknown device'}. Select that device or ask an administrator to remove the group’s environment before changing it.</p>}</>}</div>}
      {plan && <><label className="lai-checkbox"><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} /> I authorize changes on {status?.host} for {plan.repo_id} ({device}) and have reviewed disk and memory guidance.</label><label className="lai-checkbox"><input type="checkbox" checked={license} onChange={(event) => setLicense(event.target.checked)} /> I reviewed and accept the <a href={source} target="_blank" rel="noreferrer">selected model’s license and terms</a> for downloading.</label></>}
      <div className="lai-install-actions"><button type="button" className="button" disabled={locked || !license || !plan?.free_enough || !!mismatch} onClick={() => void launch('install-download')}>Install runtime &amp; download model</button><button type="button" className="button ghost" disabled={locked || !!mismatch} onClick={() => void launch('install')}>Install runtime only</button><button type="button" className="button ghost" disabled={locked || !license || !plan?.free_enough} onClick={() => void launch('download')}>Download model only</button><button type="button" className="button ghost" disabled={locked} onClick={() => void launch('verify')}>Verify model files</button></div>
      {error && <p className="lai-copy-error" role="alert">{error}</p>}
      {job && <div className="lai-install-job"><div className="lai-install-job-heading"><h3>Job: {job.group} · {job.action} · {job.device}</h3>{running && <button type="button" className="button ghost" disabled={busy} onClick={() => void cancel()}>Cancel job</button>}</div><p role="status">{job.state.toUpperCase()} · {job.stage}</p><p className="lai-small">Job ID: {job.id}. Logs report actual installer output; no fabricated percentage. Verification checks pinned files, not inference quality.</p>{job.error && <p className="lai-copy-error" role="alert">{job.error}</p>}<pre aria-label="Installer logs">{job.logs.length ? job.logs.join('\n') : 'Waiting for installer output…'}</pre>{job.state === 'succeeded' && <p>Completed. Use the separate smoke-test handoff below to test inference; a verified download does not mean the model is running.</p>}{job.state === 'cancelled' && <p>Cancelled. Completed packages and verified files may remain. A later explicit run can reuse valid downloads.</p>}</div>}
    </div>
  </section>
}
