import { describe, it, expect, vi } from 'vitest'
import type { EventStore } from '../ports/store.js'
import type { Notifier } from '../ports/notifier.js'
import { catchUpDigests } from './digest.js'

function deps(digestFor: EventStore['digestFor'], send: Notifier['send']) {
  const store = {
    digestFor,
    getApiUsage: async () => 0,
  } as unknown as EventStore
  return { store, notifier: { send }, sourceId: 'dart' }
}

const emptyAgg = {
  sent: { critical: 0, high: 0, normal: 0 },
  dead: 0,
  missedCandidates: [],
  errorCounts: {},
  missedTotal: 0,
}

describe('catchUpDigests — 장애가 자정을 두 번 넘겨도 중간 날을 잃지 않는다', () => {
  it('lastDigestDate 가 하루 뒤처지면 하루치만 보낸다', async () => {
    const digestFor = vi.fn<EventStore['digestFor']>(async () => emptyAgg)
    const send = vi.fn(async () => ({ ok: true }) as const)
    const next = await catchUpDigests(deps(digestFor, send), '2026-09-18', '2026-09-19')

    expect(next).toBe('2026-09-19')
    expect(digestFor).toHaveBeenCalledTimes(1)
    expect(digestFor).toHaveBeenCalledWith('2026-09-18')
  })

  it('lastDigestDate 가 이틀 뒤처지면 두 번의 runDigest 호출을 날짜 순서대로 보낸다', async () => {
    const digestFor = vi.fn<EventStore['digestFor']>(async () => emptyAgg)
    const send = vi.fn(async () => ({ ok: true }) as const)
    const next = await catchUpDigests(deps(digestFor, send), '2026-09-17', '2026-09-19')

    expect(next).toBe('2026-09-19')
    expect(digestFor).toHaveBeenCalledTimes(2)
    // 순서가 중요하다 — 호출 인자 배열 자체가 순서를 담는다
    expect(digestFor.mock.calls.map((c) => c[0])).toEqual(['2026-09-17', '2026-09-18'])
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('lastDigestDate 가 currentKstDate 와 같으면 아무것도 보내지 않는다', async () => {
    const digestFor = vi.fn<EventStore['digestFor']>(async () => emptyAgg)
    const send = vi.fn(async () => ({ ok: true }) as const)
    const next = await catchUpDigests(deps(digestFor, send), '2026-09-19', '2026-09-19')

    expect(next).toBe('2026-09-19')
    expect(digestFor).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('월 경계를 넘어 밀렸어도 날짜를 하루씩 정확히 따라잡는다', async () => {
    const digestFor = vi.fn<EventStore['digestFor']>(async () => emptyAgg)
    const send = vi.fn(async () => ({ ok: true }) as const)
    const next = await catchUpDigests(deps(digestFor, send), '2026-01-30', '2026-02-02')

    expect(next).toBe('2026-02-02')
    expect(digestFor.mock.calls.map((c) => c[0])).toEqual(['2026-01-30', '2026-01-31', '2026-02-01'])
  })
})
