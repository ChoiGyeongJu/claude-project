import { describe, it, expect } from 'vitest'
import { DAILY_LIMIT, kstDateString, budgetGuard } from './budget.js'

describe('DAILY_LIMIT', () => {
  it('OpenDART 한도는 일 20,000건이다', () => expect(DAILY_LIMIT).toBe(20_000))
})

describe('kstDateString', () => {
  it('UTC 자정 직전도 KST 기준 다음날로 계산한다', () => {
    expect(kstDateString(new Date('2026-09-19T15:30:00Z'))).toBe('2026-09-20')
  })
  it('UTC 아침은 같은 날', () => {
    expect(kstDateString(new Date('2026-09-19T06:30:00Z'))).toBe('2026-09-19')
  })
})

describe('budgetGuard — 한도 초과로 서비스가 멈추는 것이 최악이다', () => {
  it('여유가 있으면 기본 주기를 유지한다', () => {
    expect(budgetGuard(5_000, 2_500)).toBe(2_500)
  })
  it('80%를 넘으면 2배로 늘린다', () => {
    expect(budgetGuard(16_500, 2_500)).toBe(5_000)
  })
  it('95%를 넘으면 10배로 늘린다', () => {
    expect(budgetGuard(19_100, 2_500)).toBe(25_000)
  })
  it('한도에 도달하면 5분으로 고정한다', () => {
    expect(budgetGuard(20_000, 2_500)).toBe(300_000)
  })
})
