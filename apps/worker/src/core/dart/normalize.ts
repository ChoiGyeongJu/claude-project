import type { Market, NormalizedEvent } from '@app/shared'
import type { DartListItem } from './schema.js'

const VIEWER_URL = 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo='
const KST_OFFSET_MS = 9 * 60 * 60 * 1000

/** "20260919" → KST 자정에 해당하는 Date. 형식이 다르면 null. */
export function parseRceptDate(rceptDt: string): Date | null {
  if (!/^\d{8}$/.test(rceptDt)) return null
  const y = Number(rceptDt.slice(0, 4))
  const m = Number(rceptDt.slice(4, 6))
  const d = Number(rceptDt.slice(6, 8))
  return new Date(Date.UTC(y, m - 1, d) - KST_OFFSET_MS)
}

function toMarket(corpCls: string): Market | undefined {
  return corpCls === 'Y' || corpCls === 'K' ? corpCls : undefined
}

export function normalizeDartItem(item: DartListItem, firstSeenAt: Date): NormalizedEvent {
  const ticker = item.stock_code.trim()
  return {
    sourceId: 'dart',
    externalId: item.rcept_no,
    occurredAt: parseRceptDate(item.rcept_dt),
    firstSeenAt,
    title: item.report_nm.trim(),
    url: `${VIEWER_URL}${item.rcept_no}`,
    subject: {
      name: item.corp_name,
      ...(ticker ? { ticker } : {}),
      ...(toMarket(item.corp_cls) ? { market: toMarket(item.corp_cls) } : {}),
    },
    raw: item,
  }
}
