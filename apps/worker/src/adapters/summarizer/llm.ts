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

/**
 * 출력에 하나라도 들어 있으면 요약을 통째로 버린다 (스펙 §12 유사투자자문 회피).
 *
 * 부분 문자열 비교이므로 **실제로 쓰이는 표기를 하나하나 다 적어야 한다.**
 * '목표가'가 목록에 있다고 "목표주가 8만원"이 걸리지 않는다 —
 * '목표주가'.includes('목표가') 는 false 다. 아래 목록은 그 함정을 메운 것이다.
 *
 * 과차단(정상 요약을 버리는 것)은 요약이 없는 알림으로 끝나지만, 미차단은
 * 규제선을 넘은 문장을 그대로 발송한다. 비대칭이 크므로 넓게 잡는다.
 */
const FORBIDDEN_IN_OUTPUT: readonly string[] = [
  '호재',
  '악재',
  '목표가',
  '목표주가',
  '적정주가',
  '매수',
  '매도',
  '투자의견',
  '상승 여력',
  '하락 여력',
  '수혜',
  '저평가',
  '고평가',
  '긍정적',
  '부정적',
  '전망',
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

/** 생성은 오래 걸릴 수 있으나 무한히는 아니다. 매달리면 알림 전체가 멈춘다. */
const REQUEST_TIMEOUT_MS = 30_000

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
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
