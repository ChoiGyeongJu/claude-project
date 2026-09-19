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

  it('fetch 에러 메시지가 토큰을 포함해도 제거한다 (레이어 2 방어)', async () => {
    const fakeToken = 'super-secret-bot-token-abcd1234efgh5678'
    const fetchImpl = vi.fn(async () => {
      throw new TypeError(
        `fetch failed for https://api.telegram.org/bot${fakeToken}/sendMessage: connection refused`
      )
    }) as unknown as typeof fetch
    const n = createTelegramNotifier({
      token: fakeToken, chatId: '-100', fetchImpl,
    })

    const r = await n.send('x')
    expect(r).toMatchObject({ ok: false, retryAfterMs: null })
    expect(JSON.stringify(r)).not.toContain(fakeToken)
    if (!r.ok) {
      expect(r.error).not.toContain('connection refused')
      expect(r.error).toBe('network error')
    }
  })

  it('fetch 에러 메시지가 전체 URL을 포함해도 제거한다', async () => {
    const fakeToken = 'ultra-secret-token-xyz9876uvwx4321pqr'
    const fullUrl = `https://api.telegram.org/bot${fakeToken}/sendMessage`
    const fetchImpl = vi.fn(async () => {
      throw new TypeError(`Failed to fetch ${fullUrl}`)
    }) as unknown as typeof fetch
    const n = createTelegramNotifier({
      token: fakeToken, chatId: '-100', fetchImpl,
    })

    const r = await n.send('x')
    expect(JSON.stringify(r)).not.toContain(fakeToken)
    expect(JSON.stringify(r)).not.toContain(fullUrl)
    if (!r.ok) {
      expect(r.error).toBe('network error')
    }
  })

  it('Telegram 실패 응답이 토큰을 포함하면 제거한다', async () => {
    const fakeToken = 'redact-test-token-ijkl0123mnop4567'
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        ok: false,
        description: `Invalid bot token: ${fakeToken}`,
      }),
    })) as unknown as typeof fetch
    const n = createTelegramNotifier({
      token: fakeToken, chatId: '-100', fetchImpl,
    })

    const r = await n.send('x')
    expect(JSON.stringify(r)).not.toContain(fakeToken)
    if (!r.ok) {
      expect(r.error).toBe('Invalid bot token: ***')
    }
  })

  it('빈 토큰은 메시지를 손상시키지 않는다', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        ok: false,
        description: 'some error *** message',
      }),
    })) as unknown as typeof fetch
    const n = createTelegramNotifier({
      token: '', chatId: '-100', fetchImpl,
    })

    const r = await n.send('x')
    // 빈 토큰으로는 교체가 일어나지 않아야 하고, *** 문자가 그대로 남아있어야 한다
    if (!r.ok) {
      expect(r.error).toBe('some error *** message')
    }
  })

  it('짧은 토큰(8자 미만)은 교체되지 않는다', async () => {
    const shortToken = 'short'
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        ok: false,
        description: `Invalid token: ${shortToken}`,
      }),
    })) as unknown as typeof fetch
    const n = createTelegramNotifier({
      token: shortToken, chatId: '-100', fetchImpl,
    })

    const r = await n.send('x')
    // 짧은 토큰은 교체되지 않으므로 원본 토큰이 그대로 남아있다
    if (!r.ok) {
      expect(r.error).toBe(`Invalid token: ${shortToken}`)
    }
  })
})
