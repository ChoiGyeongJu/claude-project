import { describe, it, expect, vi } from 'vitest'
import type { NormalizedEvent } from '@app/shared'
import { createLlmSummarizer, SUMMARY_SYSTEM_PROMPT } from './llm.js'
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

  it('사실 요약과 수치 추출을 지시한다', () => {
    expect(SUMMARY_SYSTEM_PROMPT).toContain('사실')
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

  it('응답 형태가 다르면 null을 반환한다', async () => {
    const s = summarizerWith(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ foo: 1 }),
    }))
    expect(await s.summarize(event)).toBeNull()
  })
})

describe('noopSummarizer', () => {
  it('항상 null — critical 경로에서 LLM을 건너뛰는 데 쓴다', async () => {
    expect(await noopSummarizer.summarize(event)).toBeNull()
  })
})
