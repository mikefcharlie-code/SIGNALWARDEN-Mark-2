export type InferenceGroup = 'llm' | 'image-generation' | 'video-generation' | 'image-classification' | 'video-classification'
export type InferenceDevice = 'cpu' | 'cuda'
export type InferenceState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type InferenceCitation = { record_id: string; timestamp: string | number }
export type InferenceClip = { start_seconds: number; end_seconds: number; topk: Array<{ label: string; score: number }> }
export type InferenceTopK = { label: string; score: number }
export type InferenceResult = {
  group: InferenceGroup; advisory: boolean; synthetic: boolean; source_synthetic?: boolean; model_ran?: boolean; kind: string; answer?: string
  citations?: InferenceCitation[]; abstained?: boolean; topk?: InferenceTopK[]; clips?: InferenceClip[]
  artifact?: string; mime?: string
}
export type InferenceJob = { id: string; group: InferenceGroup; state: InferenceState; stage: string; error: null | { code: string; message: string }; result?: InferenceResult }
export type InferenceGroupStatus = { group: InferenceGroup; runtimeInstalled: boolean; device: string | null; modelPresent: boolean; ready: boolean; detail: string }
export type InferenceLimits = { uploadBytes: number; promptChars: number; videoSeconds: number; imageMaxSide: number; videoWidth: number; videoHeight: number }
export type InferenceStatus = { enabled: boolean; groups: InferenceGroupStatus[]; labels: string[]; limits: InferenceLimits; job?: InferenceJob }
export type InferenceRequest = { group: InferenceGroup; device: InferenceDevice; prompt?: string; recordIds?: string[]; media?: { name: string; data: string } }

const errorMessages: Record<number, string> = { 400: 'The inference request was rejected. Check the selected group, device, prompt, record IDs, or media.', 401: 'Administrator token rejected. Check the inference token and reconnect.', 403: 'Local inference is disabled or this browser origin is not allowed.', 404: 'Inference endpoint or job was not found. Refresh status and try again.', 409: 'Another inference job is active, or the selected runtime is not available.', 413: 'The inference payload is too large. Reduce the prompt or media.', 415: 'The inference API requires JSON for this request.', 422: 'The server could not validate this inference input.', 503: 'Local inference is unavailable. Ask an administrator to enable it.' }

async function responseError(response: Response): Promise<Error> {
  let detail = ''
  const type = response.headers.get('content-type') ?? ''
  if (type.includes('application/json')) {
    try { const body = await response.json() as { error?: { code?: string; message?: string } | string; detail?: string }; const raw = typeof body.error === 'string' ? body.error : body.error?.message ?? body.detail; if (body.error && typeof body.error !== 'string' && body.error.code === 'invalid_media') detail = 'The selected media is invalid for this group or exceeds the server limits.'; else if (body.error && typeof body.error !== 'string' && body.error.code === 'model_unavailable') detail = 'The selected local model is unavailable on this device.'; else if (raw) detail = raw } catch { /* use status fallback */ }
  }
  return new Error(detail || errorMessages[response.status] || `Inference request failed (HTTP ${response.status}).`)
}

export async function inferenceRequest<T>(token: string, path: string, body?: object, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 30_000); const onAbort = () => controller.abort(); signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const endpoint = path ? `/api/v1/local-ai/inference/${path}` : '/api/v1/local-ai/inference'
    const response = await fetch(endpoint, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal, cache: 'no-store', redirect: 'error' })
    if (!response.ok) throw await responseError(response)
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Inference API returned an unexpected response. Check the API proxy configuration.')
    return await response.json() as T
  } catch (error) { if (error instanceof Error && error.name === 'AbortError') throw new Error(signal?.aborted ? 'Inference request was superseded.' : 'Inference request timed out. Refresh status before retrying.'); if (error instanceof TypeError) throw new Error('Cannot reach the local inference API. Refresh status before retrying.'); throw error } finally { clearTimeout(timeout); signal?.removeEventListener('abort', onAbort) }
}

export const activeInferenceJob = (job?: InferenceJob | null) => job?.state === 'queued' || job?.state === 'running'
export const MAX_PROMPT_CHARS = 2000
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024
export function validateMedia(file: { name: string; size: number; type: string }, group: InferenceGroup): string | null { if (file.size > MAX_UPLOAD_BYTES) return 'Media is larger than the 8 MiB client limit.'; const image = /^image\/(png|jpeg)$/.test(file.type); const video = file.type === 'video/mp4' || file.type === 'image/gif'; if (group.includes('image') && !image) return 'Image groups accept PNG or JPEG only.'; if (group.includes('video') && !video) return 'Video groups accept MP4 or GIF only (maximum 10 seconds, 1280×720).'; return null }

export function buildInferenceRequest(group: InferenceGroup, device: InferenceDevice, prompt: string, recordIds: string, media?: { name: string; data: string }): InferenceRequest {
  const generation = group === 'llm' || group.endsWith('generation'); const classification = group.endsWith('classification');
  return { group, device, ...(generation && prompt.trim() ? { prompt: prompt.trim() } : {}), ...(group === 'llm' && recordIds.trim() ? { recordIds: recordIds.split(/[\n,]/).map((id) => id.trim()).filter(Boolean) } : {}), ...(classification && media ? { media } : {}) }
}
export const formatTopk = (items: InferenceTopK) => `${items.label} (${items.score})`
export const formatCitation = (item: InferenceCitation) => `${item.record_id} @ ${item.timestamp}`
export const formatClip = (item: InferenceClip) => `${item.start_seconds}–${item.end_seconds}s: ${item.topk.map(formatTopk).join(', ')}`

const artifactTypes = new Set(['image/png', 'image/jpeg', 'video/mp4', 'image/gif'])
export async function downloadInferenceArtifact(token: string, jobId: string, signal?: AbortSignal): Promise<Blob> {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 30_000); const onAbort = () => controller.abort(); signal?.addEventListener('abort', onAbort, { once: true })
  try { const response = await fetch(`/api/v1/local-ai/inference/jobs/${encodeURIComponent(jobId)}/artifact`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal, cache: 'no-store', redirect: 'error' }); if (!response.ok) throw await responseError(response); const type = response.headers.get('content-type')?.split(';')[0].toLowerCase() ?? ''; const length = Number(response.headers.get('content-length') ?? 0); if (!artifactTypes.has(type)) throw new Error('Artifact returned an unsupported content type.'); if (length > MAX_UPLOAD_BYTES) throw new Error('Artifact exceeds the 8 MiB download limit.'); const blob = await response.blob(); if (blob.size > MAX_UPLOAD_BYTES) throw new Error('Artifact exceeds the 8 MiB download limit.'); return blob } catch (error) { if (error instanceof Error && error.name === 'AbortError') throw new Error(signal?.aborted ? 'Artifact download was superseded.' : 'Artifact download timed out.'); if (error instanceof TypeError) throw new Error('Cannot reach the local inference API.'); throw error } finally { clearTimeout(timeout); signal?.removeEventListener('abort', onAbort) }
}
export const startInference = (token: string, request: InferenceRequest, signal?: AbortSignal) => inferenceRequest<InferenceJob>(token, '', request, signal)
export const inferenceStatus = (token: string, signal?: AbortSignal) => inferenceRequest<InferenceStatus>(token, 'status', undefined, signal)
export const inferenceJob = (token: string, id: string, signal?: AbortSignal) => inferenceRequest<InferenceJob>(token, `jobs/${encodeURIComponent(id)}`, undefined, signal)
export const cancelInference = (token: string, id: string, signal?: AbortSignal) => inferenceRequest<InferenceJob>(token, `jobs/${encodeURIComponent(id)}/cancel`, {}, signal)
