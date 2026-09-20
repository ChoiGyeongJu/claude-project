import { describe, it, expect, vi } from 'vitest'
import type { NormalizedEvent } from '@app/shared'
import { createLlmSummarizer, SUMMARY_SYSTEM_PROMPT, violatesBoundary } from './llm.js'
import { noopSummarizer } from './noop.js'

const event: NormalizedEvent = {
  sourceId: 'dart',
  externalId: '1',
  occurredAt: null,
  firstSeenAt: new Date('2026-09-19T06:30:00Z'),
  title: '타법인주식및출자증권취득결정',
  url: 'https://example.test',
  subject: { name: '샘플', ticker: '005930', market: 'Y' },
  raw: {},
}

function summarizerWith(impl: () => Promise<unknown>) {
  const fetchImpl = vi.fn(impl) as unknown as typeof fetch
  return createLlmSummarizer({ apiKey: 'k', model: 'm', endpoint: 'https://llm.test', fetchImpl })
}

describe('SUMMARY_SYSTEM_PROMPT — 규제선', () => {
  it.each(['호재', '악재', '목표가', '매수', '매도', '투자의견'])(
    '"%s"를 요구하지 않는다',
    (word) => {
      expect(SUMMARY_SYSTEM_PROMPT).not.toContain(word)
    }
  )

  it('제목 해석과 수치 포함을 지시한다', () => {
    expect(SUMMARY_SYSTEM_PROMPT).toContain('제목')
    expect(SUMMARY_SYSTEM_PROMPT).toContain('금액')
  })
})

describe('createLlmSummarizer', () => {
  it('요약 텍스트를 반환한다', async () => {
    const s = summarizerWith(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: '계약금액 500억원' }] }),
    }))
    expect(await s.summarize(event)).toBe('계약금액 500억원')
  })

  it('HTTP 실패 시 null을 반환한다 — 요약 실패가 발송을 막으면 안 된다', async () => {
    const s = summarizerWith(async () => ({ ok: false, status: 500, json: async () => ({}) }))
    expect(await s.summarize(event)).toBeNull()
  })

  it('예외가 나도 null을 반환한다', async () => {
    const s = summarizerWith(async () => {
      throw new Error('network down')
    })
    expect(await s.summarize(event)).toBeNull()
  })

  it('AbortSignal.timeout 에 의한 타임아웃도 null을 반환한다 — 요약 실패가 발송을 막으면 안 된다', async () => {
    const s = summarizerWith(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    })
    expect(await s.summarize(event)).toBeNull()
  })

  it('응답 형태가 다르면 null을 반환한다', async () => {
    const s = summarizerWith(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ foo: 1 }),
    }))
    expect(await s.summarize(event)).toBeNull()
  })

  it('규제선: 모델이 호재를 포함하면 null을 반환한다', async () => {
    const s = summarizerWith(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: '이것은 호재입니다' }] }),
    }))
    expect(await s.summarize(event)).toBeNull()
  })

  it('규제선: 모델이 투자의견을 포함하면 null을 반환한다', async () => {
    const s = summarizerWith(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: '주가 상승 여력이 있습니다' }] }),
    }))
    expect(await s.summarize(event)).toBeNull()
  })

  it('정상 요약은 통과한다', async () => {
    const s = summarizerWith(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: '타법인의 주식을 취득하기로 결정했다' }] }),
    }))
    expect(await s.summarize(event)).toBe('타법인의 주식을 취득하기로 결정했다')
  })
})

describe('violatesBoundary — 출력 검증', () => {
  it.each([
    '호재', '악재', '목표가', '적정주가', '매수', '매도', '투자의견', '상승 여력', '하락 여력',
    // 아래는 실제로 훨씬 흔한 표현인데 전부 스크린을 그냥 통과하고 있었다.
    '목표주가', '수혜', '저평가', '고평가', '긍정적', '부정적', '전망',
  ])(
    '"%s"를 포함하면 true',
    (word) => {
      expect(violatesBoundary(`거래 ${word} 상황`)).toBe(true)
    }
  )

  it(
    '"목표주가"를 잡는다 — 부분 문자열 함정. ' +
      "'목표주가'.includes('목표가') 는 false 라 '목표가' 항목만으로는 걸리지 않았다",
    () => {
      expect('목표주가 8만원'.includes('목표가')).toBe(false) // 함정 자체를 고정한다
      expect(violatesBoundary('목표주가 8만원으로 제시')).toBe(true)
    },
  )

  it.each([
    ['수혜', '이번 계약으로 수혜가 예상된다'],
    ['저평가', '현재 주가는 저평가 상태다'],
    ['고평가', '동종업계 대비 고평가되어 있다'],
    ['긍정적', '실적에 긍정적 영향을 줄 것이다'],
    ['부정적', '주가에 부정적으로 작용할 수 있다'],
    ['전망', '향후 실적 개선이 전망된다'],
  ])('"%s" — 실제 문장 형태로도 잡는다', (_word, sentence) => {
    expect(violatesBoundary(sentence)).toBe(true)
  })

  it('규제 금지어가 없으면 false', () => {
    expect(violatesBoundary('타법인 주식 취득 결정')).toBe(false)
  })

  it('사실 서술은 통과한다 — 과차단으로 요약이 전부 죽으면 안 된다', () => {
    expect(violatesBoundary('계약금액은 500억원이며 최근 연매출의 23%에 해당한다')).toBe(false)
  })
})

describe('noopSummarizer', () => {
  it('항상 null — critical 경로에서 LLM을 건너뛰는 데 쓴다', async () => {
    expect(await noopSummarizer.summarize(event)).toBeNull()
  })
})
