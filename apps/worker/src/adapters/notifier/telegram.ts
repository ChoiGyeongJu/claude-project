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

/** fetch 는 기본 타임아웃이 없다. 없으면 발송이 매달려 루프 전체가 멈춘다. */
const REQUEST_TIMEOUT_MS = 15_000

type TelegramResponse = {
  ok: boolean
  description?: string
  parameters?: { retry_after?: number }
}

/**
 * 에러 메시지에서 토큰을 제거하는 방어선. 레이어 2 방어.
 * 보안 제약:
 * - 토큰은 최소 8자 이상이어야 하며, 그보다 짧으면 교체하지 않음
 * - 전체 토큰만 매칭되며, 부분 매칭(bot id나 secret 반쪽)은 감지되지 않음
 * - 이는 레이어 1(메시지 비노출)과 조합으로 작동하는 설계 트레이드오프
 */
function redactToken(msg: string, token: string): string {
  if (token.length < 8) return msg
  return msg.replaceAll(token, '***')
}

export function createTelegramNotifier(cfg: TelegramConfig): Notifier {
  const doFetch = cfg.fetchImpl ?? fetch
  const now = cfg.now ?? (() => new Date())
  const bucket = createTokenBucket({
    capacity: BUCKET_CAPACITY,
    refillPerMinute: MESSAGES_PER_MINUTE,
  })
  const url = `https://api.telegram.org/bot${cfg.token}/sendMessage`

  /** 모든 실패를 이 함수로 반환하여 redaction을 강제한다. */
  const fail = (error: string, retryAfterMs: number | null): SendResult =>
    ({ ok: false, retryAfterMs, error: redactToken(error, cfg.token) })

  return {
    async send(markdownV2: string): Promise<SendResult> {
      // 429를 맞기 전에 우리가 먼저 조인다.
      // 실패로 반환하면 dispatch의 기존 재시도 경로가 그대로 처리한다.
      if (!bucket.tryTake(now())) {
        return fail(LOCAL_RATE_LIMIT, REFILL_WAIT_MS)
      }

      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
        const errorMsg = body.description ?? `HTTP ${res.status}`
        return fail(
          errorMsg,
          typeof retryAfter === 'number' ? retryAfter * 1_000 : null,
        )
      } catch (e) {
        // fetch나 json() 실패는 재시도가능한 오류로 취급한다.
        // 레이어 1: 에러 메시지를 전혀 보지 않고 유형만 사용한다.
        // 레이어 2: fail()로 모든 반환값을 토큰으로 redact한다.
        const errorMsg = e instanceof TypeError
          ? 'network error'
          : `error: ${e instanceof Error ? e.constructor.name : 'unknown'}`
        return fail(errorMsg, null)
      }
    },
  }
}
