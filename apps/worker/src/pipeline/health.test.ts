import { describe, it, expect, vi } from 'vitest'
import { createHeartbeat } from './health.js'

describe('createHeartbeat — VM이 통째로 죽는 경우를 잡는 유일한 수단', () => {
  it('설정된 URL로 핑을 보낸다', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch
    const hb = createHeartbeat({ url: 'https://hc.test/abc', fetchImpl })

    await hb.ping()
    expect((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0])
      .toBe('https://hc.test/abc')
  })

  it('200 응답은 true를 반환한다', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch
    const hb = createHeartbeat({ url: 'https://hc.test/abc', fetchImpl })

    const result = await hb.ping()
    expect(result).toBe(true)
  })

  it('4xx 응답은 false를 반환하고 워커를 죽이지 않는다', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch
    const hb = createHeartbeat({ url: 'https://hc.test/abc', fetchImpl })

    const result = await hb.ping()
    expect(result).toBe(false)
  })

  it('5xx 응답은 false를 반환하고 워커를 죽이지 않는다', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500 })) as unknown as typeof fetch
    const hb = createHeartbeat({ url: 'https://hc.test/abc', fetchImpl })

    const result = await hb.ping()
    expect(result).toBe(false)
  })

  it('URL이 없으면 true를 반환하고 아무것도 하지 않는다 — 로컬 개발에서 방해되면 안 된다', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const hb = createHeartbeat({ url: null, fetchImpl })

    const result = await hb.ping()
    expect(result).toBe(true)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('네트워크 실패는 false를 반환하고 워커를 죽이지 않는다', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('down') }) as unknown as typeof fetch
    const hb = createHeartbeat({ url: 'https://hc.test/abc', fetchImpl })

    const result = await hb.ping()
    expect(result).toBe(false)
  })

  it('AbortSignal.timeout 에 의한 타임아웃도 false를 반환한다 — finally 에서 도므로 여기가 매달리면 루프 전체가 멈춘다', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    }) as unknown as typeof fetch
    const hb = createHeartbeat({ url: 'https://hc.test/abc', fetchImpl })

    const result = await hb.ping()
    expect(result).toBe(false)
  })
})
