import { describe, it, expect, vi } from 'vitest'
import type { NormalizedEvent } from '@app/shared'
import type { EventSource } from '../ports/source.js'
import type { EventStore } from '../ports/store.js'
import { runIngest } from './ingest.js'

const NOW = new Date('2026-09-19T06:30:00Z')

function mkEvent(over: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    sourceId: 'dart',
    externalId: '1',
    occurredAt: NOW,
    firstSeenAt: NOW,
    title: '무상증자결정',
    url: 'https://example.test',
    subject: { name: '샘플', ticker: '005930', market: 'Y' },
    raw: {},
    ...over,
  }
}

function fakeStore(recordReturns = true) {
  const recordEvent = vi.fn(async () => recordReturns)
  const store = { recordEvent } as unknown as EventStore
  return { store, recordEvent }
}

function fakeSource(events: NormalizedEvent[]): EventSource {
  return { id: 'dart', fetchLatest: async () => events }
}

describe('runIngest', () => {
  it('pass 이벤트는 enqueue=true로 기록한다', async () => {
    const { store, recordEvent } = fakeStore()
    const stats = await runIngest({ source: fakeSource([mkEvent()]), store }, NOW)

    expect(stats).toMatchObject({ fetched: 1, recorded: 1, enqueued: 1 })
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: '1' }),
      expect.objectContaining({ action: 'pass', tier: 'critical' }),
      expect.objectContaining({ enqueue: true }),
    )
  })

  it('drop 이벤트도 사유와 함께 기록하되 enqueue하지 않는다', async () => {
    const { store, recordEvent } = fakeStore()
    const stats = await runIngest(
      { source: fakeSource([mkEvent({ title: '주주명부폐쇄기간또는기준일설정' })]), store },
      NOW,
    )

    expect(stats).toMatchObject({ recorded: 1, enqueued: 0 })
    expect(recordEvent).toHaveBeenCalledWith(
      expect.anything(),
      { action: 'drop', reason: 'no-keyword-match' },
      { enqueue: false, expiresAt: null },
    )
  })

  it('10분 넘은 공시는 기록만 하고 발송하지 않는다 — 재기동 폭탄 방지', async () => {
    const { store, recordEvent } = fakeStore()
    const old = mkEvent({ firstSeenAt: new Date(NOW.getTime() - 11 * 60_000) })
    const stats = await runIngest({ source: fakeSource([old]), store }, NOW)

    expect(stats.enqueued).toBe(0)
    expect(recordEvent).toHaveBeenCalledWith(
      expect.anything(),
      { action: 'drop', reason: 'too-old' },
      { enqueue: false, expiresAt: null },
    )
  })

  it('중복은 duplicated로 집계한다', async () => {
    const { store } = fakeStore(false)
    const stats = await runIngest({ source: fakeSource([mkEvent()]), store }, NOW)
    expect(stats).toMatchObject({ recorded: 0, duplicated: 1 })
  })

  it('빈 응답도 안전하게 처리한다', async () => {
    const { store } = fakeStore()
    expect(await runIngest({ source: fakeSource([]), store }, NOW))
      .toEqual({ fetched: 0, recorded: 0, enqueued: 0, duplicated: 0 })
  })
})
