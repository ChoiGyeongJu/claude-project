import type { NormalizedEvent } from '@app/shared'
import type { Summarizer } from '../../ports/summarizer.js'

/**
 * 규제 제약: 투자 판단을 생성하지 않는다.
 * 현재 입력은 공시 제목만 제공된다 (본문은 Task 18에서 추후 구현).
 * 제목 해석만 수행한다.
 */
export const SUMMARY_SYSTEM_PROMPT = [
  '너는 한국 기업 공시 제목을 일반 투자자가 이해할 수 있게 풀어 쓰는 도구다.',
  '입력으로는 회사명과 공시 제목만 주어진다. 공시 본문은 주어지지 않는다.',
  '공시 제목이 어떤 종류의 사건을 뜻하는지 한 문장으로 설명하라.',
  '금액, 비율, 지분율 같은 수치는 제목에 실제로 있을 때만 포함하라.',
  '제목에 없는 내용을 추측하거나 지어내지 마라.',
  '평가, 전망, 권유에 해당하는 표현을 쓰지 마라.',
].join('\n')

const FORBIDDEN_IN_OUTPUT: readonly string[] = [
  '호재',
  '악재',
  '목표가',
  '적정주가',
  '매수',
  '매도',
  '투자의견',
  '상승 여력',
  '하락 여력',
]

export function violatesBoundary(text: string): boolean {
  return FORBIDDEN_IN_OUTPUT.some((w) => text.includes(w))
}

export type LlmConfig = {
  apiKey: string
  model: string
  endpoint: string
  fetchImpl?: typeof fetch
}

type LlmResponse = { content?: Array<{ type: string; text?: string }> }

export function createLlmSummarizer(cfg: LlmConfig): Summarizer {
  const doFetch = cfg.fetchImpl ?? fetch

  return {
    async summarize(event: NormalizedEvent): Promise<string | null> {
      try {
        const res = await doFetch(cfg.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': cfg.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: cfg.model,
            max_tokens: 300,
            system: SUMMARY_SYSTEM_PROMPT,
            messages: [
              {
                role: 'user',
                content: `회사: ${event.subject?.name ?? '미상'}\n공시명: ${event.title}`,
              },
            ],
          }),
        })

        if (!res.ok) return null

        const body = (await res.json()) as LlmResponse
        const text = body.content?.find((c) => c.type === 'text')?.text
        const trimmed = text?.trim()
        if (!trimmed) return null
        if (violatesBoundary(trimmed)) return null
        return trimmed
      } catch {
        return null // 요약 실패가 발송을 막아서는 안 된다
      }
    },
  }
}
