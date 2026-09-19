import type { NormalizedEvent } from '@app/shared'
import type { EventSource } from '../../ports/source.js'
import { normalizeDartItem } from '../../core/dart/normalize.js'
import { parseDartResponse } from '../../core/dart/schema.js'

const ENDPOINT = 'https://opendart.fss.or.kr/api/list.json'

export class DartApiError extends Error {
  constructor(readonly status: string, message: string) {
    super(`DART ${status}: ${message}`)
    this.name = 'DartApiError'
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

      const res = await doFetch(url.toString())
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
