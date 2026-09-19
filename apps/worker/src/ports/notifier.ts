export type SendResult =
  | { ok: true }
  | { ok: false; retryAfterMs: number | null; error: string }

export type Notifier = {
  send(markdownV2: string): Promise<SendResult>
}

/**
 * 우리가 스스로 조절해서 보내지 않은 경우의 error 값.
 * 텔레그램의 실제 실패와 구분해야 한다 — 이건 재시도 횟수를 소비하면 안 된다.
 */
export const LOCAL_RATE_LIMIT = 'local-rate-limit'
