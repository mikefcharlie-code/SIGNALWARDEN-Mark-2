export type ModelGroup = 'llm' | 'image-generation' | 'video-generation' | 'image-classification' | 'video-classification'
export type InstallDevice = 'cpu' | 'cuda'
export type InstallAction = 'install' | 'download' | 'install-download' | 'verify'
export type InstallJob = {
  id: string; group: ModelGroup; device: InstallDevice; action: InstallAction
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  stage: string; logs: string[]; error: string | null
}
export type InstallPlan = {
  group: ModelGroup; repo_id: string; revision: string; license: string
  download_bytes: number; free_bytes: number; free_enough: boolean
  ram_gb: number; vram_gb: number; warnings: string[]
  runtimeInstalled: boolean; device: InstallDevice | null
}
export type InstallerStatus = { enabled: boolean; host: string; cacheRoot: string; groups: InstallPlan[]; job: InstallJob | null }
export const activeJob = (job: InstallJob | null) => job?.state === 'queued' || job?.state === 'running'

/** Same-origin only. The admin token stays in component memory, never URLs/storage. */
export async function installerRequest<T>(token: string, path: string, body?: object): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetch(`/api/v1/local-ai/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal, cache: 'no-store', redirect: 'error',
    })
    if (!response.ok) {
      // Do not render arbitrary proxy/server response text or accidentally echo credentials.
      const messages: Record<number, string> = {
        401: 'Administrator token rejected. Check the token and reconnect.',
        403: 'Installer disabled or this browser origin is not allowed. Ask the server administrator to check installer configuration.',
        404: 'Installer disabled, endpoint unavailable, or job not found. Check administrator enablement and reconnect to refresh server state.',
        409: 'Another job is active or the selected environment conflicts. Refresh server status before retrying.',
        400: 'The server rejected the setup options. Refresh the plan and check device and license consent.',
        413: 'Installer request rejected: payload too large.',
        415: 'Installer request rejected: JSON content type required. Check the API proxy configuration.',
        503: 'Installer unavailable. An administrator must enable browser installation on the API host.',
      }
      throw new Error(messages[response.status] ?? `Installer request failed (HTTP ${response.status}).`)
    }
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Installer API not reachable. Check the API proxy configuration.')
    return await response.json() as T
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('Installer request timed out. Reconnect to check whether the job started; do not blindly launch it again.')
    if (error instanceof TypeError) throw new Error('Cannot reach the installer API. Reconnect to check job state before retrying.')
    throw error
  } finally { clearTimeout(timeout) }
}

export function startInstall(token: string, group: ModelGroup, device: InstallDevice, action: InstallAction, acceptLicense: boolean) {
  return installerRequest<InstallJob>(token, 'jobs', { group, device, action, acceptLicense })
}
