import { describe, it, expect } from 'vitest'
import { pollIntervalMs } from './schedule.js'

/** 인자는 UTC Date. KST = UTC+9 로 판정된다. */
describe('pollIntervalMs', () => {
  it('평일 장중(KST 10:00)은 10초', () => {
    expect(pollIntervalMs(new Date('2026-09-18T01:00:00Z'))).toBe(10_000)
  })

  it('평일 08:00 경계를 포함한다', () => {
    expect(pollIntervalMs(new Date('2026-09-17T23:00:00Z'))).toBe(10_000) // KST 금 08:00
  })

  it('평일 19:00 경계는 제외한다', () => {
    expect(pollIntervalMs(new Date('2026-09-18T10:00:00Z'))).toBe(30_000) // KST 금 19:00
  })

  it('평일 야간(KST 22:00)은 30초', () => {
    expect(pollIntervalMs(new Date('2026-09-18T13:00:00Z'))).toBe(30_000)
  })

  it('토요일은 5분', () => {
    expect(pollIntervalMs(new Date('2026-09-19T03:00:00Z'))).toBe(300_000) // KST 토 12:00
  })

  it('일요일은 5분', () => {
    expect(pollIntervalMs(new Date('2026-09-20T03:00:00Z'))).toBe(300_000)
  })
})
