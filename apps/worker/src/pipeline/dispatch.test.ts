import { describe, it, expect, vi } from 'vitest'
import type { NormalizedEvent } from '@app/shared'
import type { EventStore, PendingOutbox } from '../ports/store.js'
import type { Notifier } from '../ports/notifier.js'
import { LOCAL_RATE_LIMIT } from '../ports/notifier.js'
import { MAX_MERGED_CHARS } from '../core/policy.js'
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
  // vi.fn<EventStore['markFailed']>: 아래 회귀 테스트가 markFailed.mock.calls[0]![3]으로
  // attempts를 꺼내 다음 사이클에 되먹인다 — 타입 인자가 없으면 dispatch.ts의 마지막 테스트와
  // 같은 이유로 calls[0]이 빈 튜플로 추론되어 tsc가 거부한다.
  const markFailed = vi.fn<EventStore['markFailed']>(async () => {})
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
    // attempts는 store가 스스로 증가시키지 않는다 — dispatch가 계산해 넘긴 최종값(0 + 1)이어야 한다.
    expect(markFailed).toHaveBeenCalledWith(1, 'boom', new Date(NOW.getTime() + 5_000), 1)
  })

  it('429는 retry_after를 그대로 존중한다', async () => {
    const send = vi.fn(async () => ({ ok: false as const, retryAfterMs: 7_000, error: '429' }))
    const { deps: d, markFailed } = deps([pending()], send)

    await runDispatch(d, NOW)
    expect(markFailed).toHaveBeenCalledWith(1, '429', new Date(NOW.getTime() + 7_000), 1)
  })

  it('local-rate-limit로 스로틀링되면 markFailed에 attempts를 그대로(증가 없이) 전달한다', async () => {
    const send = vi.fn(async () => (
      { ok: false as const, retryAfterMs: 4_000, error: LOCAL_RATE_LIMIT }
    ))
    const { deps: d, markFailed, markDead } = deps([pending({ attempts: 2 })], send)

    await runDispatch(d, NOW)
    // 우리 스스로 조인 것이므로 시도 횟수가 소비되지 않는다 — 2 그대로 넘어가야 한다.
    expect(markFailed).toHaveBeenCalledWith(1, LOCAL_RATE_LIMIT, new Date(NOW.getTime() + 4_000), 2)
    expect(markDead).not.toHaveBeenCalled()
  })

  it('진짜 실패면 markFailed에 attempts + 1을 전달한다', async () => {
    const send = vi.fn(async () => ({ ok: false as const, retryAfterMs: null, error: 'boom' }))
    const { deps: d, markFailed } = deps([pending({ attempts: 2 })], send)

    await runDispatch(d, NOW)
    expect(markFailed).toHaveBeenCalledWith(1, 'boom', new Date(NOW.getTime() + 60_000), 3)
  })

  it(
    '스로틀링이 여러 사이클 반복돼도 store에 기록되는 attempts는 누적되지 않는다 — ' +
      'store가 attempts를 스스로 +1 하면 이 값이 사이클마다 불어나 자가 스로틀링만으로 ' +
      '재시도 예산이 바닥나고, 그 뒤 진짜 실패 한 번에 dead 처리된다. attempts를 호출자가 ' +
      '결정해 넘기고 store는 시키는 대로 쓰기만 하면(postgres.ts) 이 값이 절대 불어나지 않는다.',
    async () => {
      const send = vi.fn(async () => (
        { ok: false as const, retryAfterMs: 4_000, error: LOCAL_RATE_LIMIT }
      ))

      // 1번째 사이클: DB에서 읽어온 attempts가 4라고 가정한다.
      const cycle1 = deps([pending({ attempts: 4 })], send)
      await runDispatch(cycle1.deps, NOW)
      expect(cycle1.markFailed).toHaveBeenCalledWith(
        1, LOCAL_RATE_LIMIT, new Date(NOW.getTime() + 4_000), 4,
      )
      expect(cycle1.markDead).not.toHaveBeenCalled()

      // store가 "시키는 대로 쓴다"는 계약을 지킨다면, 다음 사이클의 claimPending은
      // 여전히 attempts: 4를 돌려준다 (5로 불어나 있으면 안 된다).
      const attemptsWrittenByStore = cycle1.markFailed.mock.calls[0]![3]
      expect(attemptsWrittenByStore).toBe(4)

      // 2번째 사이클: 다시 스로틀링돼도 여전히 dead가 아니어야 한다.
      const cycle2 = deps([pending({ attempts: attemptsWrittenByStore })], send)
      await runDispatch(cycle2.deps, NOW)
      expect(cycle2.markFailed).toHaveBeenCalledWith(
        1, LOCAL_RATE_LIMIT, new Date(NOW.getTime() + 4_000), 4,
      )
      expect(cycle2.markDead).not.toHaveBeenCalled()
    },
  )

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

  it('예산 안에 다 들어가면 병합 메시지 하나에 전부 담긴다 (정상 케이스는 그대로다)', async () => {
    const send = vi.fn<Notifier['send']>(async () => ({ ok: true as const }))
    const items = [
      pending({ id: 1, tier: 'high' }),
      pending({ id: 2, tier: 'high' }),
      pending({ id: 3, tier: 'normal' }),
      pending({ id: 4, tier: 'normal' }),
    ]
    const { deps: d, markSent } = deps(items, send)

    const stats = await runDispatch(d, NOW)
    expect(send).toHaveBeenCalledTimes(1)
    expect(String(send.mock.calls[0]![0])).toContain('공시 4건')
    expect(stats.sent).toBe(4)
    expect(markSent).toHaveBeenCalledTimes(4)
  })

  it(
    '병합 메시지가 MAX_MERGED_CHARS를 넘으면 담기는 항목까지만 보내고, ' +
      '나머지는 markSent/markFailed/markDead 어느 것도 호출되지 않는다 — ' +
      '텔레그램 4096자 한도를 넘겨 배치 전체가 거부되는 것을 막기 위해서다. ' +
      '담기지 못한 항목은 store를 전혀 건드리지 않아야 pending으로 남아 다음 ' +
      '사이클에 다시 claim된다 (유실되지 않는다).',
    async () => {
      const send = vi.fn<Notifier['send']>(async () => ({ ok: true as const }))
      // 제목을 크게 부풀려 몇 건만 지나도 MAX_MERGED_CHARS(3,500)를 넘도록 만든다.
      // 사전에 formatMerged로 직접 측정해 확인한 값: 900자 제목 기준 누적 길이는
      // 1건 979, 2건 1923, 3건 2867, 4건 3811 — 그래서 정확히 3건까지만 담겨야 한다.
      const longTitle = 'A'.repeat(900)
      const longEvent: NormalizedEvent = { ...event, title: longTitle }
      const items = [1, 2, 3, 4, 5].map((id) =>
        pending({ id, tier: 'high', event: longEvent }),
      )
      const { deps: d, markSent, markFailed, markDead } = deps(items, send)

      const stats = await runDispatch(d, NOW)

      expect(send).toHaveBeenCalledTimes(1)
      expect(String(send.mock.calls[0]![0]).length).toBeLessThanOrEqual(MAX_MERGED_CHARS)

      expect(markSent).toHaveBeenCalledTimes(3)
      expect(markSent).toHaveBeenCalledWith(1)
      expect(markSent).toHaveBeenCalledWith(2)
      expect(markSent).toHaveBeenCalledWith(3)
      expect(markSent).not.toHaveBeenCalledWith(4)
      expect(markSent).not.toHaveBeenCalledWith(5)

      // 4, 5번은 markSent뿐 아니라 markFailed/markDead도 전혀 호출되지 않아야 한다 —
      // 어떤 store 호출도 받지 않아야 outbox 행이 pending 그대로 남는다.
      expect(markFailed).not.toHaveBeenCalled()
      expect(markDead).not.toHaveBeenCalled()

      expect(stats.sent).toBe(3)
    },
  )
})
