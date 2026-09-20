const KST_OFFSET_MS = 9 * 60 * 60 * 1000

export const INTERVAL_ACTIVE_MS = 10_000
export const INTERVAL_OFFHOURS_MS = 30_000
export const INTERVAL_WEEKEND_MS = 300_000

/** UTC Date를 KST 기준 요일·시로 환산한다. */
export function toKst(now: Date): { day: number; hour: number } {
  const k = new Date(now.getTime() + KST_OFFSET_MS)
  return { day: k.getUTCDay(), hour: k.getUTCHours() }
}

/**
 * 시간대별 폴링 주기.
 * 평일 08:00~18:59 KST = 10초, 그 외 평일 = 30초, 주말 = 5분.
 * 공휴일은 판별하지 않는다 (공휴일에도 30초는 예산상 문제없다).
 *
 * 장중 10초는 하루 약 5,500콜로, DART 한도(DART_DAILY_LIMIT, 기본 20,000)의 28%
 * 수준이라 budgetGuard 의 80% 감속선에 한참 못 미친다. 더 조여도 예산 자체는
 * 버티지만(2.5초 = 17,400콜) 그렇게 벌어들이는 것은 평균 4초의 탐지 지연뿐인데,
 * DART 자체의 접수→API 노출 지연을 측정한 적이 없어 그 4초가 실제 이득인지 알 수
 * 없다. 재검토하려면 그 지연부터 재야 한다.
 */
export function pollIntervalMs(now: Date): number {
  const { day, hour } = toKst(now)
  if (day === 0 || day === 6) return INTERVAL_WEEKEND_MS
  if (hour >= 8 && hour < 19) return INTERVAL_ACTIVE_MS
  return INTERVAL_OFFHOURS_MS
}
