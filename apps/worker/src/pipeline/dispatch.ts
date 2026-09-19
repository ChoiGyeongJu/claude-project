import { formatEvent, formatMerged } from '../core/format.js'
import { MERGE_THRESHOLD } from '../core/policy.js'
import { MAX_ATTEMPTS, nextAttemptAt } from '../core/retry.js'
import { LOCAL_RATE_LIMIT } from '../ports/notifier.js'
import type { Notifier } from '../ports/notifier.js'
import type { EventStore, PendingOutbox } from '../ports/store.js'
import type { Summarizer } from '../ports/summarizer.js'

export type DispatchDeps = {
  store: EventStore
  notifier: Notifier
  summarizer: Summarizer
}

export type DispatchStats = { sent: number; failed: number; dead: number; expired: number }

const CLAIM_LIMIT = 20

export async function runDispatch(deps: DispatchDeps, now: Date): Promise<DispatchStats> {
  const stats: DispatchStats = { sent: 0, failed: 0, dead: 0, expired: 0 }
  const claimed = await deps.store.claimPending(now, CLAIM_LIMIT)
  if (claimed.length === 0) return stats

  // 만료 먼저 걷어낸다 — 늦은 알림은 보내지 않는다
  const live: PendingOutbox[] = []
  for (const item of claimed) {
    if (item.expiresAt.getTime() <= now.getTime()) {
      await deps.store.markDead(item.id, 'expired')
      stats.expired += 1
    } else {
      live.push(item)
    }
  }

  const criticals = live.filter((i) => i.tier === 'critical')
  const others = live.filter((i) => i.tier !== 'critical')

  // critical — 속도가 목적이므로 병합하지 않는다
  for (const item of criticals) {
    await sendOne(deps, item, formatEvent(item.event, item.tier), now, stats)
  }

  // 그 외 — 임계 이상이면 한 메시지로 묶어 rate limit 압박을 줄인다
  if (others.length >= MERGE_THRESHOLD) {
    const text = formatMerged(others.map((i) => ({ event: i.event, tier: i.tier })))
    const res = await deps.notifier.send(text)
    for (const item of others) await applyResult(deps, item, res, now, stats)
  } else {
    for (const item of others) {
      const summary = await deps.summarizer.summarize(item.event)
      const text = formatEvent(item.event, item.tier, summary ?? undefined)
      await sendOne(deps, item, text, now, stats)
    }
  }

  return stats
}

async function sendOne(
  deps: DispatchDeps, item: PendingOutbox, text: string, now: Date, stats: DispatchStats,
): Promise<void> {
  const res = await deps.notifier.send(text)
  await applyResult(deps, item, res, now, stats)
}

async function applyResult(
  deps: DispatchDeps,
  item: PendingOutbox,
  res: Awaited<ReturnType<Notifier['send']>>,
  now: Date,
  stats: DispatchStats,
): Promise<void> {
  if (res.ok) {
    await deps.store.markSent(item.id)
    stats.sent += 1
    return
  }

  // 우리가 스스로 조절해서 안 보낸 것은 실패가 아니다 — 시도 횟수를 소비하면
  // 버스트 때 자가 스로틀링만으로 재시도 예산이 바닥나 정상 알림이 버려진다.
  const throttled = res.error === LOCAL_RATE_LIMIT
  const attempts = throttled ? item.attempts : item.attempts + 1

  if (!throttled && attempts >= MAX_ATTEMPTS) {
    await deps.store.markDead(item.id, res.error)
    stats.dead += 1
    return
  }

  // 429의 retry_after는 추측하지 않고 그대로 따른다
  const next = res.retryAfterMs !== null
    ? new Date(now.getTime() + res.retryAfterMs)
    : nextAttemptAt(item.attempts, now)

  await deps.store.markFailed(item.id, res.error, next)
  stats.failed += 1
}
