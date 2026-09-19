export const MAX_ATTEMPTS = 5

const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000, 1_800_000] as const

export function backoffMs(attempts: number): number {
  const i = Math.min(Math.max(attempts, 0), BACKOFF_MS.length - 1)
  return BACKOFF_MS[i]!
}

export function nextAttemptAt(attempts: number, now: Date): Date {
  return new Date(now.getTime() + backoffMs(attempts))
}
