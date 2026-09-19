import { describe, it, expect, vi } from 'vitest'
import fixture from '../../__fixtures__/dart-list.json' with { type: 'json' }
import { createDartSource, DartApiError } from './dart.js'

const NOW = new Date('2026-09-19T06:30:00Z')

function sourceWith(json: unknown, ok = true) {
  const fetchImpl = vi.fn(async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => json,
  })) as unknown as typeof fetch
  const src = createDartSource({ apiKey: 'test-key', fetchImpl })
  return { src, fetchImpl }
}

describe('createDartSource', () => {
  it('list.json을 page_count=100, 최신순으로 호출한다', async () => {
    const { src, fetchImpl } = sourceWith(fixture)
    await src.fetchLatest(NOW)

    const url = String((fetchImpl as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0])
    expect(url).toContain('/api/list.json')
    expect(url).toContain('page_count=100')
    expect(url).toContain('sort=date')
    expect(url).toContain('sort_mth=desc')
  })

  it('API 키를 URL에 담되 로그에 남기지 않도록 반환값에는 포함하지 않는다', async () => {
    const { src } = sourceWith(fixture)
    const events = await src.fetchLatest(NOW)
    expect(JSON.stringify(events)).not.toContain('test-key')
  })

  it('정상 응답을 NormalizedEvent 배열로 변환한다', async () => {
    const { src } = sourceWith(fixture)
    const events = await src.fetchLatest(NOW)
    expect(events).toHaveLength(3)
    expect(events[0]!.externalId).toBe('20260919000123')
    expect(events[0]!.firstSeenAt).toBe(NOW)
  })

  it('013(데이터 없음)은 빈 배열을 반환한다', async () => {
    const { src } = sourceWith({ status: '013', message: '조회된 데이타가 없습니다.' })
    expect(await src.fetchLatest(NOW)).toEqual([])
  })

  it('020(한도 초과)은 DartApiError를 던진다', async () => {
    const { src } = sourceWith({ status: '020', message: '요청 제한을 초과하였습니다.' })
    await expect(src.fetchLatest(NOW)).rejects.toThrow(DartApiError)
  })

  it('800(점검중)은 DartApiError를 던진다', async () => {
    const { src } = sourceWith({ status: '800', message: '시스템 점검' })
    await expect(src.fetchLatest(NOW)).rejects.toMatchObject({ status: '800' })
  })

  it('HTTP 실패는 던진다', async () => {
    const { src } = sourceWith({}, false)
    await expect(src.fetchLatest(NOW)).rejects.toThrow()
  })

  it('AbortSignal.timeout 에 의한 타임아웃은 예외로 전파되어 루프가 잡을 수 있다', async () => {
    // dart.ts 에는 자체 try/catch 가 없다 — 타임아웃도 다른 네트워크 실패와 똑같이
    // 예외로 던져져 main 루프의 catch 가 처리해야 한다. 삼켜서 빈 배열을 반환하면
    // 미수신 이벤트가 조용히 사라진다.
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    }) as unknown as typeof fetch
    const src = createDartSource({ apiKey: 'test-key', fetchImpl })
    await expect(src.fetchLatest(NOW)).rejects.toMatchObject({ name: 'TimeoutError' })
  })

  it('DartApiError.status 는 생성자 인자로 전달된 값을 보존한다', async () => {
    const { src } = sourceWith({ status: '020', message: '한도 초과' })
    try {
      await src.fetchLatest(NOW)
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DartApiError)
      expect((err as DartApiError).status).toBe('020')
    }
  })
})
