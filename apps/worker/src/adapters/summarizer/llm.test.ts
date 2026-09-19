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
  it.each(['호재', '악재', '목표가', '적정주가', '매수', '매도', '투자의견', '상승 여력', '하락 여력'])(
    '"%s"를 포함하면 true',
    (word) => {
      expect(violatesBoundary(`거래 ${word} 상황`)).toBe(true)
    }
  )

  it('규제 금지어가 없으면 false', () => {
    expect(violatesBoundary('타법인 주식 취득 결정')).toBe(false)
  })
})

describe('noopSummarizer', () => {
  it('항상 null — critical 경로에서 LLM을 건너뛰는 데 쓴다', async () => {
    expect(await noopSummarizer.summarize(event)).toBeNull()
  })
})
