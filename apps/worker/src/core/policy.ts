import type { Tier } from '@app/shared'

/** 접수 후 이 시간이 지난 공시는 발송하지 않는다 (장시간 다운 후 재기동 대비). */
export const MAX_DELIVERY_AGE_MS = 10 * 60_000

/** outbox 대기가 이 건수 이상이면 한 메시지로 병합한다. */
export const MERGE_THRESHOLD = 3

const TTL_MS: Record<Tier, number> = {
  critical: 5 * 60_000,
  high: 30 * 60_000,
  normal: 120 * 60_000,
}

export function isTooOld(firstSeen: Date, now: Date): boolean {
  return now.getTime() - firstSeen.getTime() > MAX_DELIVERY_AGE_MS
}

export function ttlFor(tier: Tier): number {
  return TTL_MS[tier]
}

export function expiresAt(tier: Tier, now: Date): Date {
  return new Date(now.getTime() + ttlFor(tier))
}
