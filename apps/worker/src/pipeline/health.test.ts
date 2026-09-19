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

  it('URL이 없으면 아무것도 하지 않는다 — 로컬 개발에서 방해되면 안 된다', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const hb = createHeartbeat({ url: null, fetchImpl })

    await hb.ping()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('핑 실패가 워커를 죽이지 않는다', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('down') }) as unknown as typeof fetch
    const hb = createHeartbeat({ url: 'https://hc.test/abc', fetchImpl })

    await expect(hb.ping()).resolves.toBeUndefined()
  })
})
