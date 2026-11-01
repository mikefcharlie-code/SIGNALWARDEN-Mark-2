export function elapsedLabel(timestamp: string | null | undefined, now: number): string {
  if (!timestamp || !Number.isFinite(Date.parse(timestamp)) || !Number.isFinite(now)) return 'Age unknown'
  const elapsed = now - Date.parse(timestamp)
  if (elapsed < 0) return 'Future timestamp · check clock'
  const seconds = Math.floor(elapsed / 1000)
  if (seconds < 60) return `${seconds}s old`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s old`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m old`
  return `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h old`
}

export function receiptVerification(online: boolean, status: 'ready' | 'loading' | 'error', retained: boolean): string {
  if (!retained) return 'No accepted snapshot'
  if (!online) return 'Unverified · browser offline'
  if (status === 'error') return 'Unverified · API read failed'
  if (status === 'loading') return 'Unverified · refresh in progress'
  return 'API receipt verified · source not live'
}
