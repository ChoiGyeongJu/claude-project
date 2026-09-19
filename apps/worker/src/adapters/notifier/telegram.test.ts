import { describe, it, expect, vi } from 'vitest'
import { LOCAL_RATE_LIMIT } from '../../ports/notifier.js'
import { createTelegramNotifier } from './telegram.js'

function notifierWith(body: unknown, httpOk = true, httpStatus = 200) {
  const fetchImpl = vi.fn(async () => ({
    ok: httpOk,
    status: httpStatus,
    json: async () => body,
  })) as unknown as typeof fetch
  const n = createTelegramNotifier({ token: 'bot-token', chatId: '-100', fetchImpl })
  return { n, fetchImpl }
}

describe('createTelegramNotifier', () => {
  it('성공하면 ok를 반환한다', async () => {
    const { n } = notifierWith({ ok: true })
    expect(await n.send('hello')).toEqual({ ok: true })
  })

  it('MarkdownV2로 보낸다', async () => {
    const { n, fetchImpl } = notifierWith({ ok: true })
    await n.send('hello')
    const init = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } })
      .mock.calls[0]![1]
    expect(String(init.body)).toContain('MarkdownV2')
  })

  it('429면 retry_after를 밀리초로 환산해 반환한다', async () => {
    const { n } = notifierWith(
      { ok: false, error_code: 429, parameters: { retry_after: 7 } }, false, 429,
    )
    expect(await n.send('x')).toMatchObject({ ok: false, retryAfterMs: 7_000 })
  })

  it('그 외 실패는 retryAfterMs가 null이다', async () => {
    const { n } = notifierWith({ ok: false, description: 'Bad Request' }, false, 400)
    expect(await n.send('x')).toMatchObject({ ok: false, retryAfterMs: null })
  })

  it('토큰을 에러 메시지에 노출하지 않는다', async () => {
    const { n } = notifierWith({ ok: false, description: 'Unauthorized' }, false, 401)
    const r = await n.send('x')
    expect(JSON.stringify(r)).not.toContain('bot-token')
  })

  it('자체 rate limit에 걸리면 API를 호출하지 않고 재시도를 요청한다', async () => {
    const t = new Date('2026-09-19T06:30:00Z')
    const fetchImpl = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ ok: true }),
    })) as unknown as typeof fetch
    const n = createTelegramNotifier({
      token: 'bot-token', chatId: '-100', fetchImpl, now: () => t,
    })

    for (let i = 0; i < 5; i += 1) expect((await n.send('x')).ok).toBe(true)

    expect(await n.send('x')).toMatchObject({
      ok: false, retryAfterMs: 4_000, error: LOCAL_RATE_LIMIT,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(5)   // 6번째는 호출되지 않았다
  })

  it('fetch 실패는 재시도가능한 실패로 반환한다', async () => {
    const fakeToken = 'fake-bot-token-1234567890abcdef'
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed: ECONNREFUSED')
    }) as unknown as typeof fetch
    const n = createTelegramNotifier({
      token: fakeToken, chatId: '-100', fetchImpl,
    })

    const r = await n.send('x')
    expect(r).toMatchObject({ ok: false, retryAfterMs: null })
    expect(JSON.stringify(r)).not.toContain(fakeToken)
  })

  it('res.json() 실패는 재시도가능한 실패로 반환한다', async () => {
    const fakeToken = 'fake-bot-token-1234567890abcdef'
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token')
      },
    })) as unknown as typeof fetch
    const n = createTelegramNotifier({
      token: fakeToken, chatId: '-100', fetchImpl,
    })

    const r = await n.send('x')
    expect(r).toMatchObject({ ok: false, retryAfterMs: null })
    expect(JSON.stringify(r)).not.toContain(fakeToken)
  })
})
