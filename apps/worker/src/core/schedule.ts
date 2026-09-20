const KST_OFFSET_MS = 9 * 60 * 60 * 1000

export const INTERVAL_ACTIVE_MS = 2_500
export const INTERVAL_OFFHOURS_MS = 30_000
export const INTERVAL_WEEKEND_MS = 300_000

/** UTC Date를 KST 기준 요일·시로 환산한다. */
export function toKst(now: Date): { day: number; hour: number } {
  const k = new Date(now.getTime() + KST_OFFSET_MS)
  return { day: k.getUTCDay(), hour: k.getUTCHours() }
}

/**
 * 시간대별 폴링 주기.
 * 평일 08:00~18:59 KST = 2.5초, 그 외 평일 = 30초, 주말 = 5분.
 * 공휴일은 판별하지 않는다 (공휴일에도 30초는 예산상 문제없다).
 */
export function pollIntervalMs(now: Date): number {
  const { day, hour } = toKst(now)
  if (day === 0 || day === 6) return INTERVAL_WEEKEND_MS
  if (hour >= 8 && hour < 19) return INTERVAL_ACTIVE_MS
  return INTERVAL_OFFHOURS_MS
}
