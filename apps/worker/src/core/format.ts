import type { NormalizedEvent, Tier } from '@app/shared'

export const DISCLAIMER = '_정보 제공 목적이며 투자 권유가 아닙니다_'

const TIER_ICON: Record<Tier, string> = {
  critical: '🔴',
  high: '🟠',
  normal: '⚪',
}

/** 텔레그램 MarkdownV2 예약문자 전체. 하나라도 빠지면 메시지가 깨진다. */
const RESERVED = /[_*[\]()~`>#+\-=|{}.!\\]/g

export function escapeMarkdownV2(s: string): string {
  return s.replace(RESERVED, (c) => `\\${c}`)
}

function subjectLine(e: NormalizedEvent): string {
  const name = escapeMarkdownV2(e.subject?.name ?? '알 수 없음')
  const ticker = e.subject?.ticker
  return ticker ? `*${name}* \\(${escapeMarkdownV2(ticker)}\\)` : `*${name}*`
}

export function formatEvent(e: NormalizedEvent, tier: Tier, summary?: string): string {
  const lines = [
    `${TIER_ICON[tier]} ${subjectLine(e)}`,
    escapeMarkdownV2(e.title),
  ]
  if (summary) lines.push('', escapeMarkdownV2(summary))
  lines.push('', escapeMarkdownV2(e.url), '', DISCLAIMER)
  return lines.join('\n')
}

export function formatMerged(
  items: ReadonlyArray<{ event: NormalizedEvent; tier: Tier }>,
): string {
  const head = `📢 공시 ${items.length}건`
  const body = items.map(({ event, tier }) =>
    `${TIER_ICON[tier]} ${subjectLine(event)} — ${escapeMarkdownV2(event.title)}\n${escapeMarkdownV2(event.url)}`,
  )
  return [head, '', ...body, '', DISCLAIMER].join('\n')
}
