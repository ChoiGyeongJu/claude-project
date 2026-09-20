import { describe, it, expect } from 'vitest'
import { ttlFor, expiresAt, MERGE_THRESHOLD } from './policy.js'

const NOW = new Date('2026-09-19T06:30:00.000Z')

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
