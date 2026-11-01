export interface ObservationJsonOptions {
  signal?: AbortSignal
  onAttempt?: (attempt: number) => void
  timeoutMs?: number
  maxAttempts?: number
}

export class ObservationNetworkError extends Error {
  readonly cause?: unknown
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'ObservationNetworkError'
    this.cause = cause
  }
}

class AttemptTimeoutError extends ObservationNetworkError {
  constructor() {
    super('Observation request timed out')
    this.name = 'TimeoutError'
  }
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])
const MAX_ATTEMPTS = 3
const MAX_RETRY_AFTER_MS = 2_000
const BACKOFF_BASE_MS = 100

function callerAbort(signal: AbortSignal | undefined): never {
  const reason = signal?.reason
  if (reason instanceof Error || (typeof reason === 'object' && reason !== null)) throw reason
  throw new DOMException('The operation was aborted', 'AbortError')
}

function assertLatticeUrl(url: string): void {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) {
    throw new ObservationNetworkError('Only same-origin /api/v1/lattice URLs are permitted')
  }
  let parsed: URL
  try {
    parsed = new URL(url, 'http://same-origin.invalid')
  } catch (error) {
    throw new ObservationNetworkError('Invalid observation URL', error)
  }
  if (parsed.origin !== 'http://same-origin.invalid' || !/^\/api\/v1\/lattice(?:\/|$)/.test(parsed.pathname)) {
    throw new ObservationNetworkError('Only same-origin /api/v1/lattice URLs are permitted')
  }
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after')
  if (value === null) return undefined
  const seconds = Number(value.trim())
  let milliseconds: number
  if (Number.isFinite(seconds)) milliseconds = Math.max(0, seconds * 1_000)
  else {
    const date = Date.parse(value)
    if (!Number.isFinite(date)) return undefined
    milliseconds = Math.max(0, date - Date.now())
  }
  return Math.min(MAX_RETRY_AFTER_MS, milliseconds)
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException ? error.name === 'AbortError' : error instanceof Error && error.name === 'AbortError'
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) callerAbort(signal)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms)
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError'))
    }
    function done() {
      signal.removeEventListener('abort', abort)
      resolve()
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

function backoffMs(attempt: number): number {
  const ceiling = Math.min(1_000, BACKOFF_BASE_MS * 2 ** (attempt - 1))
  return Math.floor(ceiling * (0.5 + Math.random() * 0.5))
}

/** Fetch a read-only lattice JSON endpoint with bounded, cancellation-safe resilience. */
export async function getObservationJson<T>(url: string, options: ObservationJsonOptions = {}): Promise<T> {
  assertLatticeUrl(url)
  const timeoutCap = url.split('?')[0] === '/api/v1/lattice/assistance' ? 60_000 : 15_000
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.min(timeoutCap, Math.max(1, options.timeoutMs as number)) : 4_000
  const maxAttempts = Number.isFinite(options.maxAttempts)
    ? Math.min(MAX_ATTEMPTS, Math.max(1, Math.floor(options.maxAttempts as number)))
    : MAX_ATTEMPTS
  const callerSignal = options.signal
  if (callerSignal?.aborted) callerAbort(callerSignal)

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (callerSignal?.aborted) callerAbort(callerSignal)
    options.onAttempt?.(attempt)
    const controller = new AbortController()
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let rejectTimeout!: (error: Error) => void
    const timeoutFailure = new Promise<never>((_, reject) => { rejectTimeout = reject })
    const forwardAbort = () => {
      controller.abort()
      rejectTimeout(new DOMException('The operation was aborted', 'AbortError'))
    }
    callerSignal?.addEventListener('abort', forwardAbort, { once: true })
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      rejectTimeout(new AttemptTimeoutError())
    }, timeoutMs)
    try {
      const response = await Promise.race([
        fetch(url, {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          signal: controller.signal,
        }),
        timeoutFailure,
      ])
      if (!response.ok) {
        const error = new ObservationNetworkError(`Observation request failed: ${response.status} ${response.statusText}`)
        if (!RETRYABLE_STATUS.has(response.status) || attempt === maxAttempts) throw error
        controller.abort()
        if (response.body) void response.body.cancel().catch(() => undefined)
        const retryDelay = response.status === 429 || response.status === 503 ? retryAfterMs(response) : undefined
        await wait(retryDelay ?? backoffMs(attempt), callerSignal ?? new AbortController().signal)
        continue
      }
      try {
        const value = (await Promise.race([response.json(), timeoutFailure])) as T
        if (callerSignal?.aborted) callerAbort(callerSignal)
        return value
      } catch (error) {
        if (timedOut) throw new AttemptTimeoutError()
        if (isAbort(error) && callerSignal?.aborted) callerAbort(callerSignal)
        throw new ObservationNetworkError('Observation response was not valid JSON', error)
      }
    } catch (error) {
      if (callerSignal?.aborted) callerAbort(callerSignal)
      const retryable = timedOut || (error instanceof TypeError && !isAbort(error))
      if (!retryable || attempt === maxAttempts) {
        if (timedOut) throw new AttemptTimeoutError()
        throw error
      }
      await wait(backoffMs(attempt), callerSignal ?? new AbortController().signal)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      callerSignal?.removeEventListener('abort', forwardAbort)
    }
  }
  throw new ObservationNetworkError('Observation request failed')
}
