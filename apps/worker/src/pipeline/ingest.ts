import type { Verdict } from '@app/shared'
import { evaluateDart } from '../core/dart/rules.js'
import { expiresAt } from '../core/policy.js'
import type { EventSource } from '../ports/source.js'
import type { EventStore } from '../ports/store.js'

export type IngestDeps = { source: EventSource; store: EventStore }

/**
 * 사이클을 넘어 살아남는 수집 상태. 이 두 값이 스펙 §6.4 의 "재기동 폭탄 방지"를
 * 실제로 구현한다.
 *
 * `highWaterMark` — 지금까지 처리한 가장 큰 externalId. DART `rcept_no` 는
 *   `YYYYMMDD` + 6자리 일련번호로 된 **고정 길이 14자리**라 사전순 비교가 수치
 *   비교와 일치한다. 이 마크 이하는 DB를 아예 건드리지 않고 건너뛴다.
 *
 *   이것이 없으면 `fetchLatest` 가 매 사이클 같은 최신 100건을 돌려주는데 그 100건
 *   전부가 `recordEvent` 로 가고, 건당 트랜잭션 1개라 2.5초 주기에서 초당 약 40
 *   트랜잭션이 원격 Postgres 로 날아간다 — 그중 99%는 유니크 충돌로 아무것도 하지
 *   않는 no-op 이다. 폴링 주기는 설정값이 아니라 DB가 허락하는 속도가 되어버린다.
 *
 *   다만 마크 이하를 건너뛴다는 것은, DART 가 접수번호 역순으로 공시를 노출하는
 *   경우(더 작은 rcept_no 가 더 큰 것보다 늦게 목록에 뜨는 경우) 그 건을 영영
 *   놓친다는 뜻이기도 하다. 실제로 그런 역전이 일어나는지는 관측된 바 없고
 *   (스펙 §14 미확인 항목), 일어난다면 마크에 작은 수치 여유(margin)를 두는 것이
 *   봉쇄책이다. 비공개 채널 단계에서 실측할 대상이다.
 *
 * `coldStart` — 아직 한 번도 수집에 성공하지 않았는가. 첫 성공 사이클에서만 참이다.
 */
export type IngestState = {
  highWaterMark: string | null
  coldStart: boolean
}

export type IngestStats = {
  fetched: number
  /** highWaterMark 이하라 DB를 건드리지 않고 건너뛴 건수. 정상 상태에선 대부분이 여기 잡힌다. */
  skipped: number
  recorded: number
  enqueued: number
  /** pass 판정이지만 콜드 스타트라 발송 예약을 하지 않은 건수. */
  suppressed: number
  duplicated: number
}

export type IngestResult = { stats: IngestStats; state: IngestState }

export async function runIngest(
  deps: IngestDeps, state: IngestState, now: Date,
): Promise<IngestResult> {
  const events = await deps.source.fetchLatest(now)
  const stats: IngestStats = {
    fetched: events.length, skipped: 0, recorded: 0, enqueued: 0, suppressed: 0, duplicated: 0,
  }

  // 비교 기준은 **사이클 진입 시점의 마크**로 고정한다. 루프 안에서 전진시킨 값과
  // 비교하면, 목록이 최신순(내림차순)이라 첫 건이 마크를 최고치로 올려버리고 나머지
  // 전부가 그 아래로 깔려 건너뛰어진다 — 한 사이클에 1건만 처리하게 된다.
  const entering = state.highWaterMark
  let highWaterMark = entering

  for (const event of events) {
    if (highWaterMark === null || event.externalId > highWaterMark) {
      highWaterMark = event.externalId
    }

    if (entering !== null && event.externalId <= entering) {
      stats.skipped += 1
      continue
    }

    const verdict: Verdict = evaluateDart(event)

    // 게이트 8 — 콜드 스타트 억제. 재기동 직후 워커는 **자신이 얼마나 오래 죽어
    // 있었는지 알 수 없다.** 마크 위에 쌓인 것이 방금 들어온 1건인지 사흘치 밀린
    // 물량인지 구분할 방법이 없으므로, 첫 사이클은 전부 기록만 하고 한 건도
    // 발송하지 않는다. 두 번째 사이클부터 마크 위에 올라오는 것은 워커가 살아서
    // 지켜보는 동안 새로 접수된 것이 확실하므로 정상 발송한다.
    //
    // verdict 자체는 건드리지 않는다. events.verdict/rule 은 필터가 내린 판정을
    // 담는 칼럼이고 골든셋·룰 튜닝(스펙 §7.4)이 그 값을 근거로 삼는다 — 워커의
    // 가동 시간을 필터 판정으로 덮어쓰면 그 데이터가 오염된다. 억제된 건은
    // "verdict=pass 인데 outbox 행이 없는 이벤트"로 사후 식별된다.
    const enqueue = verdict.action === 'pass' && !state.coldStart

    const inserted = await deps.store.recordEvent(event, verdict, {
      enqueue,
      expiresAt: verdict.action === 'pass' && enqueue ? expiresAt(verdict.tier, now) : null,
    })

    if (!inserted) { stats.duplicated += 1; continue }
    stats.recorded += 1
    if (enqueue) stats.enqueued += 1
    else if (verdict.action === 'pass') stats.suppressed += 1
  }

  // 마크와 coldStart 는 루프가 끝까지 돌았을 때만 반환된다. recordEvent 가 도중에
  // 던지면 runIngest 전체가 던지고 호출자가 상태를 갱신하지 않으므로, 다음 사이클이
  // 같은 구간을 다시 읽는다 — 유니크 제약이 중복을 막아주므로 안전하다.
  return { stats, state: { highWaterMark, coldStart: false } }
}
