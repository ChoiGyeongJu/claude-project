import { nextKstDate } from '../core/budget.js'
import { formatDigest } from '../core/digest.js'
import type { Notifier } from '../ports/notifier.js'
import type { EventStore } from '../ports/store.js'

export type DigestDeps = {
  store: EventStore
  notifier: Notifier
  sourceId: string
}

/** 발송에 성공했는지 반환한다. 결과를 버리면 실패를 알 방법이 없다. */
export async function runDigest(deps: DigestDeps, kstDate: string): Promise<boolean> {
  const agg = await deps.store.digestFor(kstDate)
  const apiCalls = await deps.store.getApiUsage(deps.sourceId, kstDate)

  const res = await deps.notifier.send(formatDigest({
    kstDate,
    sent: agg.sent,
    dead: agg.dead,
    apiCalls,
    missedCandidates: agg.missedCandidates,
    errorCounts: agg.errorCounts,
    missedTotal: agg.missedTotal,
  }))

  return res.ok
}

/**
 * lastDigestDate 부터 currentKstDate 직전까지, 밀린 날짜를 하루씩 모두 보낸다.
 * `lastDigestDate = currentKstDate` 로 건너뛰면 장애가 자정을 두 번 넘겼을 때
 * 중간 날의 다이제스트가 영영 사라진다 — 다이제스트는 운영자의 유일한 사후
 * 감사 기록이므로 누락되면 안 된다. 반환값은 다음 lastDigestDate(= currentKstDate,
 * 단 lastDigestDate 가 이미 그 이상이면 원래 값 그대로)다.
 *
 * `!==` 로 두면 안 된다: 시계 스큐나 오래된 상태로 재시작해 lastDigestDate 가
 * 현재보다 앞서 있으면 조건이 영원히 거짓이 되지 않아 다이제스트를 무한 발송한다.
 * ISO 날짜 문자열은 사전순 비교가 날짜 순서와 일치하므로 `<` 로 비교하면
 * lastDigestDate 가 같거나 앞선 경우 즉시 종료된다.
 */
export async function catchUpDigests(
  deps: DigestDeps, lastDigestDate: string, currentKstDate: string,
): Promise<string> {
  let date = lastDigestDate
  while (date < currentKstDate) {
    // 발송 결과를 확인하지 않고 날짜를 전진시키면, 한도 초과·429·네트워크 오류로
    // 거부된 다이제스트가 조용히 사라진다. 그날의 기록은 두 번 다시 나오지 않는다.
    // 실패하면 날짜를 그대로 두고 빠져나가 다음 사이클이 같은 날짜를 재시도한다
    // (자체 레이트 리밋에 걸린 경우도 여기로 온다 — 다음 사이클에 자연히 풀린다).
    if (!(await runDigest(deps, date))) return date
    date = nextKstDate(date)
  }
  return date
}
