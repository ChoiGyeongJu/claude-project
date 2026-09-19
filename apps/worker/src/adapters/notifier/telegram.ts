import type { Notifier, SendResult } from '../../ports/notifier.js'
import { LOCAL_RATE_LIMIT } from '../../ports/notifier.js'
import { createTokenBucket, MESSAGES_PER_MINUTE } from './rate-limiter.js'

export type TelegramConfig = {
  token: string
  chatId: string
  fetchImpl?: typeof fetch
  /** 테스트에서 시간을 고정하기 위한 주입점. 어댑터이므로 순수성 제약은 없다. */
  now?: () => Date
}

/** 짧은 순간의 몰림은 흡수하되, 평균은 MESSAGES_PER_MINUTE로 수렴시킨다. */
const BUCKET_CAPACITY = 5

/** 15건/분 = 4초당 토큰 1개. 토큰이 없으면 이만큼 뒤에 재시도한다. */
const REFILL_WAIT_MS = 4_000

type TelegramResponse = {
  ok: boolean
  description?: string
  parameters?: { retry_after?: number }
}

export function createTelegramNotifier(cfg: TelegramConfig): Notifier {
  const doFetch = cfg.fetchImpl ?? fetch
  const now = cfg.now ?? (() => new Date())
  const bucket = createTokenBucket({
    capacity: BUCKET_CAPACITY,
    refillPerMinute: MESSAGES_PER_MINUTE,
  })
  const url = `https://api.telegram.org/bot${cfg.token}/sendMessage`

  return {
    async send(markdownV2: string): Promise<SendResult> {
      // 429를 맞기 전에 우리가 먼저 조인다.
      // 실패로 반환하면 dispatch의 기존 재시도 경로가 그대로 처리한다.
      if (!bucket.tryTake(now())) {
        return { ok: false, retryAfterMs: REFILL_WAIT_MS, error: LOCAL_RATE_LIMIT }
      }

      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: cfg.chatId,
            text: markdownV2,
            parse_mode: 'MarkdownV2',
            disable_web_page_preview: true,
          }),
        })

        const body = (await res.json()) as TelegramResponse
        if (res.ok && body.ok) return { ok: true }

        const retryAfter = body.parameters?.retry_after
        return {
          ok: false,
          retryAfterMs: typeof retryAfter === 'number' ? retryAfter * 1_000 : null,
          // 토큰이 담긴 url은 절대 포함하지 않는다
          error: body.description ?? `HTTP ${res.status}`,
        }
      } catch (e) {
        // fetch나 json() 실패는 재시도가능한 오류로 취급한다.
        // 토큰이 에러 메시지에 나타나지 않도록 유형별 안전한 메시지를 사용한다.
        const errorMsg = e instanceof TypeError
          ? `network error: ${e.message.split('\n')[0]}`
          : `error: ${e instanceof Error ? e.constructor.name : 'unknown'}`
        return {
          ok: false,
          retryAfterMs: null,
          error: errorMsg,
        }
      }
    },
  }
}
