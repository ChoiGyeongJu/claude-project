import type { NormalizedEvent } from '@app/shared'

export type Summarizer = {
  /** 실패하면 null. 요약 실패가 발송을 막아서는 안 된다. */
  summarize(event: NormalizedEvent): Promise<string | null>
}
