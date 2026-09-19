import type { Verdict } from '@app/shared'
import { evaluateDart } from '../core/dart/rules.js'
import { expiresAt, isTooOld } from '../core/policy.js'
import type { EventSource } from '../ports/source.js'
import type { EventStore } from '../ports/store.js'

export type IngestDeps = { source: EventSource; store: EventStore }

export type IngestStats = {
  fetched: number
  recorded: number
  enqueued: number
  duplicated: number
}

export async function runIngest(deps: IngestDeps, now: Date): Promise<IngestStats> {
  const events = await deps.source.fetchLatest(now)
  const stats: IngestStats = { fetched: events.length, recorded: 0, enqueued: 0, duplicated: 0 }

  for (const event of events) {
    let verdict: Verdict = evaluateDart(event)

    // 게이트 8 — 오래된 공시는 통과했더라도 발송하지 않는다
    if (verdict.action === 'pass' && isTooOld(event.firstSeenAt, now)) {
      verdict = { action: 'drop', reason: 'too-old' }
    }

    const enqueue = verdict.action === 'pass'
    const inserted = await deps.store.recordEvent(event, verdict, {
      enqueue,
      expiresAt: verdict.action === 'pass' ? expiresAt(verdict.tier, now) : null,
    })

    if (!inserted) { stats.duplicated += 1; continue }
    stats.recorded += 1
    if (enqueue) stats.enqueued += 1
  }

  return stats
}
