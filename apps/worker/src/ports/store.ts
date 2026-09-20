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

  /**
   * 이 소스에서 가장 최근 기록된 externalId 를 최대 `limit` 개,
   * **오래된 것부터** 정렬해 반환한다. 행이 없으면 빈 배열.
   *
   * 재기동 시 seen-set 을 이 값으로 심는다. 심지 않으면 매 사이클 목록 API가
   * 돌려주는 최신 100건 전부가 recordEvent 로 가고(건당 트랜잭션 1개), 2.5초 주기가
   * DB 왕복에 묶여 설정한 주기대로 돌지 못한다.
   *
   * 정렬 방향이 중요하다 — seen-set 은 삽입 순서를 나이로 쓰고 가장 오래된 것부터
   * 축출하므로, 최신순으로 넣으면 가장 최근 id 가 먼저 버려진다.
   */
  recentExternalIds(sourceId: string, limit: number): Promise<string[]>

  /**
   * 가장 최근 events.first_seen_at 의 KST 날짜(YYYY-MM-DD). 행이 없으면 null.
   *
   * lastDigestDate 를 메모리에만 두면 KST 자정을 넘긴 재기동이 그 값을 오늘로
   * 되돌려 전날 다이제스트가 영영 발송되지 않는다 — 따라잡기 루프가 통째로
   * 무력화된다.
   */
  lastEventKstDate(): Promise<string | null>

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

  /** 일일 다이제스트용 집계. kstDate는 YYYY-MM-DD. */
  digestFor(kstDate: string): Promise<{
    sent: { critical: number; high: number; normal: number }
    dead: number
    missedCandidates: Array<{ title: string; corpName: string | null; ticker: string | null }>
    /** outbox.lastError 집계. 측정하지 않으면서 "에러 없음"을 표시하면 거짓 안심이 된다. */
    errorCounts: Record<string, number>
    /** 잘리지 않은 미매칭 총계. missedCandidates 는 상위 N건만 담으므로 이 값과 다를 수 있다. */
    missedTotal: number
  }>
}
