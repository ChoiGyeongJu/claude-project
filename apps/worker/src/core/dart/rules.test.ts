import { describe, it, expect } from 'vitest'
import type { NormalizedEvent } from '@app/shared'
import { evaluateDart } from './rules.js'

const SEEN = new Date('2026-09-19T06:30:00.000Z')

function ev(title: string, opts: Partial<NormalizedEvent['subject']> = {}): NormalizedEvent {
  return {
    sourceId: 'dart',
    externalId: '20260919000001',
    occurredAt: SEEN,
    firstSeenAt: SEEN,
    title,
    url: 'https://example.test',
    subject: { name: '샘플', ticker: '005930', market: 'Y', ...opts },
    raw: {},
  }
}

describe('게이트 1 — 비상장 제외', () => {
  it('ticker가 없으면 drop', () => {
    const v = evaluateDart(ev('무상증자결정', { ticker: undefined }))
    expect(v).toEqual({ action: 'drop', reason: 'no-stock-code' })
  })
})

describe('게이트 2 — 시장 제외', () => {
  it('market이 Y/K가 아니면 drop', () => {
    const v = evaluateDart(ev('무상증자결정', { market: undefined }))
    expect(v).toEqual({ action: 'drop', reason: 'market-not-target' })
  })
})

describe('게이트 3 — 정기보고서 제외', () => {
  it.each(['사업보고서 (2025.12)', '반기보고서 (2025.06)', '분기보고서 (2025.03)'])(
    '%s 는 drop', (title) => {
      expect(evaluateDart(ev(title))).toEqual({ action: 'drop', reason: 'periodic-report' })
    })
})

describe('게이트 4 — 정정 접두어', () => {
  it('[기재정정]은 drop', () => {
    expect(evaluateDart(ev('[기재정정]무상증자결정')))
      .toEqual({ action: 'drop', reason: 'minor-correction' })
  })

  it('[발행조건확정]은 high로 통과', () => {
    const v = evaluateDart(ev('[발행조건확정]유상증자결정'))
    expect(v).toMatchObject({ action: 'pass', tier: 'high', rule: 'prefix:발행조건확정' })
  })

  it('[정정명령부과]는 critical로 통과', () => {
    const v = evaluateDart(ev('[정정명령부과]사업보고서'))
    expect(v).toMatchObject({ action: 'pass', tier: 'critical', rule: 'prefix:정정명령부과' })
  })
})

describe('게이트 5 — 노이즈 제외', () => {
  it('임원·주요주주 소유상황보고서는 drop', () => {
    expect(evaluateDart(ev('임원·주요주주특정증권등소유상황보고서')))
      .toEqual({ action: 'drop', reason: 'noise' })
  })

  it('IR개최는 drop', () => {
    expect(evaluateDart(ev('기업설명회(IR)개최(안내공시)')))
      .toEqual({ action: 'drop', reason: 'noise' })
  })
})

describe('게이트 6 — 키워드 티어링', () => {
  it.each([
    '단일판매·공급계약체결',
    '무상증자결정',
    '자기주식취득결정',
    '최대주주변경',
    '횡령·배임혐의발생',
  ])('%s 는 critical', (title) => {
    const v = evaluateDart(ev(title))
    expect(v).toMatchObject({ action: 'pass', tier: 'critical' })
  })

  it.each([
    '매출액또는손익구조30%(대규모법인은15%)이상변동',
    '타법인주식및출자증권취득결정',
    '현금·현물배당결정',
  ])('%s 는 high', (title) => {
    const v = evaluateDart(ev(title))
    expect(v).toMatchObject({ action: 'pass', tier: 'high' })
  })

  it('매칭된 키워드를 rule에 남긴다', () => {
    const v = evaluateDart(ev('무상증자결정'))
    expect(v).toMatchObject({ rule: 'keyword:무상증자결정' })
  })
})

/**
 * 화이트리스트에 취득 계열만 있고 처분·소각 계열이 통째로 빠져 있었다.
 * 자사주 소각은 유통주식수를 영구히 줄이는, 시장에서 가장 강한 촉매 중 하나인데
 * no-keyword-match 로 조용히 버려지고 있었다 — 버려진 건은 발송에 나타나지 않으므로
 * 다이제스트의 미매칭 목록을 보지 않는 한 영원히 보이지 않는다(스펙 §7.4).
 */
describe('게이트 6 — 처분·소각 계열', () => {
  it.each([
    '자기주식처분결정',
    '자기주식소각결정',
    '타법인주식및출자증권처분결정',
    '자기주식취득신탁계약해지결정',
  ])('%s 는 critical', (title) => {
    expect(evaluateDart(ev(title))).toMatchObject({
      action: 'pass', tier: 'critical', rule: `keyword:${title}`,
    })
  })

  it.each([
    ['자기주식취득결정', '자기주식처분결정'],
    ['자기주식취득신탁계약체결결정', '자기주식취득신탁계약해지결정'],
    ['타법인주식및출자증권취득결정', '타법인주식및출자증권처분결정'],
  ])(
    '%s 과 %s 를 서로 다른 키워드로 구분한다 — 부분 문자열로 섞이면 안 된다',
    (acquire, dispose) => {
      expect(evaluateDart(ev(dispose))).toMatchObject({ rule: `keyword:${dispose}` })
      expect(evaluateDart(ev(acquire)).action).toBe('pass')
    },
  )

  it('해지결정이 취득결정 키워드에 먼저 걸리지 않는다 — 배열 순서 회귀', () => {
    // '자기주식취득신탁계약해지결정'.includes('자기주식취득결정') 가 false 여야
    // 배열 앞쪽 항목이 이 제목을 가로채지 않는다.
    expect('자기주식취득신탁계약해지결정'.includes('자기주식취득결정')).toBe(false)
    expect(evaluateDart(ev('자기주식취득신탁계약해지결정')))
      .toMatchObject({ rule: 'keyword:자기주식취득신탁계약해지결정' })
  })
})

describe('게이트 7 — 화이트리스트 미매칭', () => {
  it('목록에 없는 공시는 drop하고 사유를 남긴다', () => {
    expect(evaluateDart(ev('주주명부폐쇄기간또는기준일설정')))
      .toEqual({ action: 'drop', reason: 'no-keyword-match' })
  })
})

describe('추가: 인식되지 않는 접두어 제거 후 정기보고서 판정', () => {
  it('[변경]사업보고서 는 unrecognized prefix를 제거하고 periodic-report로 drop', () => {
    expect(evaluateDart(ev('[변경]사업보고서')))
      .toEqual({ action: 'drop', reason: 'periodic-report' })
  })
})
