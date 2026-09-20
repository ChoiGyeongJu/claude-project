import type { NormalizedEvent } from '@app/shared'
import type { EventSource } from '../../ports/source.js'
import { normalizeDartItem } from '../../core/dart/normalize.js'
import { parseDartResponse } from '../../core/dart/schema.js'

const ENDPOINT = 'https://opendart.fss.or.kr/api/list.json'

/**
 * Node 의 fetch 에는 기본 타임아웃이 없다. 이 값을 주지 않으면 연결이 매달릴 때
 * 루프 전체가 무한정 멈추고, heartbeat 이 영영 안 뛰어 외부 감시가 "VM 사망"으로
 * 오판한다 — 워커는 살아 있는데 고칠 수 없는 상태가 된다.
 */
const REQUEST_TIMEOUT_MS = 10_000

export class DartApiError extends Error {
  readonly status: string

  constructor(status: string, message: string) {
    super(`DART ${status}: ${message}`)
    this.name = 'DartApiError'
    this.status = status
  }
}

export type DartSourceConfig = {
  apiKey: string
  fetchImpl?: typeof fetch
}

export function createDartSource(cfg: DartSourceConfig): EventSource {
  const doFetch = cfg.fetchImpl ?? fetch

  return {
    id: 'dart',

    async fetchLatest(now: Date): Promise<NormalizedEvent[]> {
      const url = new URL(ENDPOINT)
      url.searchParams.set('crtfc_key', cfg.apiKey)
      url.searchParams.set('page_count', '100')
      url.searchParams.set('sort', 'date')
      url.searchParams.set('sort_mth', 'desc')

      const res = await doFetch(url.toString(), {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`DART HTTP ${res.status}`)

      const parsed = parseDartResponse(await res.json())

      if (parsed.status === '013') return []            // 데이터 없음 — 정상
      if (parsed.status !== '000') {
        throw new DartApiError(parsed.status, parsed.message)
      }

      return (parsed.list ?? []).map((item) => normalizeDartItem(item, now))
    },
  }
}
