import type { NormalizedEvent, Tier, Verdict } from '@app/shared'

export type PendingOutbox = {
  id: number
  eventId: number
  tier: Tier
  event: NormalizedEvent
  attempts: number
  expiresAt: Date
}

export type EventStore = {
  /**
   * 이벤트를 기록하고, pass면 같은 트랜잭션에서 outbox도 예약한다.
   * 이미 존재하는 externalId면 아무것도 하지 않고 false를 반환한다.
   */
  recordEvent(
    event: NormalizedEvent,
    verdict: Verdict,
    opts: { enqueue: boolean; expiresAt: Date | null },
  ): Promise<boolean>

  claimPending(now: Date, limit: number): Promise<PendingOutbox[]>
  markSent(outboxId: number): Promise<void>
  /**
   * 실패를 기록한다. `attempts` 는 **호출자가 결정한 최종값**이며 스토어는 시키는 대로 쓴다.
   * 스토어가 스스로 +1 하면 스로틀링(local-rate-limit)까지 예산을 잠식해,
   * 자가 조절만으로 정상 알림이 dead 가 된다.
   */
  markFailed(outboxId: number, error: string, nextAttemptAt: Date, attempts: number): Promise<void>
  markDead(outboxId: number, error: string): Promise<void>

  incrementApiUsage(sourceId: string, kstDate: string): Promise<number>
  getApiUsage(sourceId: string, kstDate: string): Promise<number>
}
