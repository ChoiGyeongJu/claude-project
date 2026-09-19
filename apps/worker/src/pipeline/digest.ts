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
