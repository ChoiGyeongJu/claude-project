import { nextKstDate } from '../core/budget.js'
import { formatDigest } from '../core/digest.js'
import type { Notifier } from '../ports/notifier.js'
import type { EventStore } from '../ports/store.js'

export type DigestDeps = {
  store: EventStore
  notifier: Notifier
  sourceId: string
}

export async function runDigest(deps: DigestDeps, kstDate: string): Promise<void> {
  const agg = await deps.store.digestFor(kstDate)
  const apiCalls = await deps.store.getApiUsage(deps.sourceId, kstDate)

  await deps.notifier.send(formatDigest({
    kstDate,
    sent: agg.sent,
    dead: agg.dead,
    apiCalls,
    missedCandidates: agg.missedCandidates,
    errorCounts: agg.errorCounts,
    missedTotal: agg.missedTotal,
  }))
}

/**
 * lastDigestDate 부터 currentKstDate 직전까지, 밀린 날짜를 하루씩 모두 보낸다.
 * `lastDigestDate = currentKstDate` 로 건너뛰면 장애가 자정을 두 번 넘겼을 때
 * 중간 날의 다이제스트가 영영 사라진다 — 다이제스트는 운영자의 유일한 사후
 * 감사 기록이므로 누락되면 안 된다. 반환값은 다음 lastDigestDate(= currentKstDate)다.
 */
export async function catchUpDigests(
  deps: DigestDeps, lastDigestDate: string, currentKstDate: string,
): Promise<string> {
  let date = lastDigestDate
  while (date !== currentKstDate) {
    await runDigest(deps, date)
    date = nextKstDate(date)
  }
  return date
}
