import { describe, it, expect } from 'vitest'
import { DAILY_LIMIT, kstDateString, budgetGuard, nextKstDate } from './budget.js'

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

describe('nextKstDate — 밀린 다이제스트를 하루씩 따라잡는 데 쓴다', () => {
  it('월 경계를 넘긴다', () => {
    expect(nextKstDate('2026-01-31')).toBe('2026-02-01')
  })
  it('연 경계를 넘긴다', () => {
    expect(nextKstDate('2025-12-31')).toBe('2026-01-01')
  })
  it('윤년의 2월 28일 다음은 29일이다', () => {
    expect(nextKstDate('2024-02-28')).toBe('2024-02-29')
  })
  it('평년의 2월 28일 다음은 3월 1일이다', () => {
    expect(nextKstDate('2026-02-28')).toBe('2026-03-01')
  })
})

describe('budgetGuard — 한도 초과로 서비스가 멈추는 것이 최악이다', () => {
  it('여유가 있으면 기본 주기를 유지한다', () => {
    expect(budgetGuard(5_000, 2_500, DAILY_LIMIT)).toBe(2_500)
  })
  it('80%를 넘으면 2배로 늘린다', () => {
    expect(budgetGuard(16_500, 2_500, DAILY_LIMIT)).toBe(5_000)
  })
  it('95%를 넘으면 10배로 늘린다', () => {
    expect(budgetGuard(19_100, 2_500, DAILY_LIMIT)).toBe(25_000)
  })
  it('한도에 도달하면 5분으로 고정한다', () => {
    expect(budgetGuard(20_000, 2_500, DAILY_LIMIT)).toBe(300_000)
  })
  it('정확히 80%는 아직 하한 구간이다 (경계는 초과만 해당)', () => {
    expect(budgetGuard(16_000, 2_500, DAILY_LIMIT)).toBe(2_500)
  })
  it('정확히 95%는 아직 2배 구간이다 (경계는 초과만 해당)', () => {
    expect(budgetGuard(19_000, 2_500, DAILY_LIMIT)).toBe(5_000)
  })
})

/**
 * 계정마다 발급된 한도가 다를 수 있다(config.ts 의 DART_DAILY_LIMIT). 40,000 한도를
 * 가진 계정에서도 같은 비율 경계에서 같은 배수로 늘어나야 한다 — 하드코딩된
 * DAILY_LIMIT 을 계속 참조하는 회귀가 나면 40,000 한도 계정은 16,000에서
 * 이미 스로틀링되어 사용 가능한 폴링 예산이 절반으로 줄어든다.
 */
describe('budgetGuard — 40,000 한도 계정에서도 같은 경계 산술이 성립한다', () => {
  const LIMIT = 40_000

  it('여유가 있으면 기본 주기를 유지한다', () => {
    expect(budgetGuard(10_000, 2_500, LIMIT)).toBe(2_500)
  })
  it('정확히 80%는 아직 하한 구간이다', () => {
    expect(budgetGuard(32_000, 2_500, LIMIT)).toBe(2_500)
  })
  it('80%를 넘으면 2배로 늘린다', () => {
    expect(budgetGuard(33_000, 2_500, LIMIT)).toBe(5_000)
  })
  it('정확히 95%는 아직 2배 구간이다', () => {
    expect(budgetGuard(38_000, 2_500, LIMIT)).toBe(5_000)
  })
  it('95%를 넘으면 10배로 늘린다', () => {
    expect(budgetGuard(38_200, 2_500, LIMIT)).toBe(25_000)
  })
  it('한도에 도달하면 5분으로 고정한다', () => {
    expect(budgetGuard(40_000, 2_500, LIMIT)).toBe(300_000)
  })
})
