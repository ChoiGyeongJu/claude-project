import type { NormalizedEvent } from '@app/shared'

export type EventSource = {
  readonly id: string
  /** 최신 이벤트를 가져온다. 호출 1회 = API 호출 1회. */
  fetchLatest(now: Date): Promise<NormalizedEvent[]>
}
