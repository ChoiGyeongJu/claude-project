import { describe, it, expect } from 'vitest'
import { isTooOld, ttlFor, expiresAt, MAX_DELIVERY_AGE_MS, MERGE_THRESHOLD } from './policy.js'

const NOW = new Date('2026-09-19T06:30:00.000Z')

describe('isTooOld — 재기동 폭탄 방지', () => {
  it('10분 이내면 발송한다', () => {
    expect(isTooOld(new Date(NOW.getTime() - 9 * 60_000), NOW)).toBe(false)
  })

  it('10분을 넘으면 발송하지 않는다', () => {
    expect(isTooOld(new Date(NOW.getTime() - 11 * 60_000), NOW)).toBe(true)
  })

  it('상한은 정확히 10분이다', () => {
    expect(MAX_DELIVERY_AGE_MS).toBe(10 * 60_000)
  })
})

describe('ttlFor — 늦은 알림은 보내지 않는다', () => {
  it('critical은 5분', () => expect(ttlFor('critical')).toBe(5 * 60_000))
  it('high는 30분', () => expect(ttlFor('high')).toBe(30 * 60_000))
  it('normal은 2시간', () => expect(ttlFor('normal')).toBe(120 * 60_000))
})

describe('expiresAt', () => {
  it('now + ttl을 반환한다', () => {
    expect(expiresAt('critical', NOW).toISOString()).toBe('2026-09-19T06:35:00.000Z')
  })
})

describe('MERGE_THRESHOLD', () => {
  it('대기 3건 이상이면 병합한다', () => expect(MERGE_THRESHOLD).toBe(3))
})
