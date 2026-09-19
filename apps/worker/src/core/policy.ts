import type { Tier } from '@app/shared'

/** outbox 대기가 이 건수 이상이면 한 메시지로 병합한다. */
export const MERGE_THRESHOLD = 3

/**
 * 병합 메시지 하나가 넘을 수 없는 문자 수. 텔레그램 sendMessage 본문 한도는 4096자이고,
 * 넘으면 배치 전체가 거부되어 안에 묶인 항목이 전부 같이 죽는다.
 *
 * 3,500은 4096에서 여유를 둔 값이다 — 오늘의 CLAIM_LIMIT(20)·요약 없음 조합에서는
 * 병합 메시지가 이 한도 근처에도 못 간다는 사실에 기대지 말 것. 그 우연한 여유는
 * CLAIM_LIMIT을 올리거나 병합 항목에 요약을 붙이는 순간 조용히 깨진다 — 이 상수가
 * 없으면 텔레그램의 4096이라는 값은 코드 어디에도 나타나지 않는다.
 */
export const MAX_MERGED_CHARS = 3_500

const TTL_MS: Record<Tier, number> = {
  critical: 5 * 60_000,
  high: 30 * 60_000,
  normal: 120 * 60_000,
}

export function ttlFor(tier: Tier): number {
  return TTL_MS[tier]
}

export function expiresAt(tier: Tier, now: Date): Date {
  return new Date(now.getTime() + ttlFor(tier))
}
