const KST_OFFSET_MS = 9 * 60 * 60 * 1000

export const DAILY_LIMIT = 20_000

/** KST 기준 YYYY-MM-DD. 자정 리셋의 기준이다. */
export function kstDateString(now: Date): string {
  return new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10)
}

/** 'YYYY-MM-DD' 의 다음 날. 밀린 다이제스트를 하루씩 따라잡는 데 쓴다. */
export function nextKstDate(kstDate: string): string {
  const d = new Date(`${kstDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/**
 * 남은 예산에 따라 폴링 주기를 늘린다.
 * 한도 초과로 020 에러를 맞아 서비스가 통째로 멈추는 것이 최악의 실패이므로 보수적으로 잡는다.
 *
 * dailyLimit 은 호출자가 넘긴다 — core/ 는 순수해야 하므로 환경 변수를 직접
 * 읽지 않는다. 계정마다 발급된 한도가 다를 수 있어(config.ts 의 DART_DAILY_LIMIT)
 * DAILY_LIMIT 상수를 그대로 쓰면 안 된다.
 */
export function budgetGuard(used: number, baseIntervalMs: number, dailyLimit: number): number {
  if (used >= dailyLimit) return 300_000
  const ratio = used / dailyLimit
  if (ratio > 0.95) return baseIntervalMs * 10
  if (ratio > 0.80) return baseIntervalMs * 2
  return baseIntervalMs
}
