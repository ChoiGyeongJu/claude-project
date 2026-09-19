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
