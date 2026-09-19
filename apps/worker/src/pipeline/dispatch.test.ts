import { describe, it, expect, vi } from 'vitest'
import type { NormalizedEvent } from '@app/shared'
import type { EventStore, PendingOutbox } from '../ports/store.js'
import type { Notifier } from '../ports/notifier.js'
import { noopSummarizer } from '../adapters/summarizer/noop.js'
import { runDispatch } from './dispatch.js'

const NOW = new Date('2026-09-19T06:30:00Z')

const event: NormalizedEvent = {
  sourceId: 'dart', externalId: '1', occurredAt: null, firstSeenAt: NOW,
  title: '무상증자결정', url: 'https://example.test',
  subject: { name: '샘플', ticker: '005930', market: 'Y' }, raw: {},
}

function pending(over: Partial<PendingOutbox> = {}): PendingOutbox {
  return {
    id: 1, eventId: 10, tier: 'critical', event,
    attempts: 0, expiresAt: new Date(NOW.getTime() + 300_000), ...over,
  }
}

function deps(items: PendingOutbox[], send: Notifier['send']) {
  const markSent = vi.fn(async () => {})
  const markFailed = vi.fn(async () => {})
  const markDead = vi.fn(async () => {})
  const store = {
    claimPending: async () => items,
    markSent, markFailed, markDead,
  } as unknown as EventStore
  return {
    deps: { store, notifier: { send }, summarizer: noopSummarizer },
    markSent, markFailed, markDead,
  }
}

describe('runDispatch', () => {
  it('성공하면 sent로 표시한다', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    const { deps: d, markSent } = deps([pending()], send)

    const stats = await runDispatch(d, NOW)
    expect(stats.sent).toBe(1)
    expect(markSent).toHaveBeenCalledWith(1)
  })

  it('만료된 항목은 보내지 않고 dead 처리한다', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    const expired = pending({ expiresAt: new Date(NOW.getTime() - 1_000) })
    const { deps: d, markDead } = deps([expired], send)

    const stats = await runDispatch(d, NOW)
    expect(send).not.toHaveBeenCalled()
    expect(stats.expired).toBe(1)
    expect(markDead).toHaveBeenCalledWith(1, 'expired')
  })

  it('실패하면 백오프를 적용해 재시도를 예약한다', async () => {
    const send = vi.fn(async () => ({ ok: false as const, retryAfterMs: null, error: 'boom' }))
    const { deps: d, markFailed } = deps([pending()], send)

    await runDispatch(d, NOW)
    expect(markFailed).toHaveBeenCalledWith(1, 'boom', new Date(NOW.getTime() + 5_000))
  })

  it('429는 retry_after를 그대로 존중한다', async () => {
    const send = vi.fn(async () => ({ ok: false as const, retryAfterMs: 7_000, error: '429' }))
    const { deps: d, markFailed } = deps([pending()], send)

    await runDispatch(d, NOW)
    expect(markFailed).toHaveBeenCalledWith(1, '429', new Date(NOW.getTime() + 7_000))
  })

  it('최대 시도를 소진하면 dead 처리한다', async () => {
    const send = vi.fn(async () => ({ ok: false as const, retryAfterMs: null, error: 'boom' }))
    const { deps: d, markDead } = deps([pending({ attempts: 4 })], send)

    await runDispatch(d, NOW)
    expect(markDead).toHaveBeenCalledWith(1, 'boom')
  })

  it('critical은 병합하지 않고 개별 발송한다', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    const items = [pending({ id: 1 }), pending({ id: 2 }), pending({ id: 3 })]
    const { deps: d } = deps(items, send)

    await runDispatch(d, NOW)
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('non-critical이 임계 이상이면 한 메시지로 병합한다', async () => {
    // vi.fn<Notifier['send']>: 인자 타입을 명시해야 send.mock.calls[0]![0]의
    // 타입이 string으로 좁혀진다 — 타입 인자가 없으면 noUncheckedIndexedAccess 하에서
    // calls[0]이 빈 튜플로 추론되어 tsc가 TS2493으로 거부한다 (vitest 런타임은 통과).
    const send = vi.fn<Notifier['send']>(async () => ({ ok: true as const }))
    const items = [
      pending({ id: 1, tier: 'high' }),
      pending({ id: 2, tier: 'high' }),
      pending({ id: 3, tier: 'normal' }),
    ]
    const { deps: d, markSent } = deps(items, send)

    const stats = await runDispatch(d, NOW)
    expect(send).toHaveBeenCalledTimes(1)
    expect(String(send.mock.calls[0]![0])).toContain('공시 3건')
    expect(stats.sent).toBe(3)
    expect(markSent).toHaveBeenCalledTimes(3)
  })
})
