import type { NormalizedEvent } from '@app/shared'
import type { Summarizer } from '../../ports/summarizer.js'

/**
 * 규제 제약: 투자 판단을 생성하지 않는다.
 * 사실 요약과 수치 추출만 수행한다.
 */
export const SUMMARY_SYSTEM_PROMPT = [
  '너는 한국 기업 공시를 요약하는 도구다.',
  '공시에 적힌 사실만 2~3줄로 요약하라.',
  '금액, 비율, 지분율, 기간 같은 수치가 있으면 반드시 포함하라.',
  '공시에 없는 내용을 추측하거나 덧붙이지 마라.',
  '평가, 전망, 권유에 해당하는 표현을 쓰지 마라.',
].join('\n')

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
        return text?.trim() || null
      } catch {
        return null // 요약 실패가 발송을 막아서는 안 된다
      }
    },
  }
}
