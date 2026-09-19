export type SendResult =
  | { ok: true }
  | { ok: false; retryAfterMs: number | null; error: string }

export type Notifier = {
  send(markdownV2: string): Promise<SendResult>
}
