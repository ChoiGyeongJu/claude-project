import { describe, it, expect } from 'vitest'
import type { NormalizedEvent } from '@app/shared'
import { escapeMarkdownV2, formatEvent, formatMerged, DISCLAIMER } from './format.js'

const e: NormalizedEvent = {
  sourceId: 'dart',
  externalId: '20260919000123',
  occurredAt: new Date('2026-09-18T15:00:00Z'),
  firstSeenAt: new Date('2026-09-19T06:30:00Z'),
  title: '단일판매·공급계약체결',
  url: 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260919000123',
  subject: { name: '샘플_전자', ticker: '005930', market: 'Y' },
  raw: {},
}

describe('escapeMarkdownV2', () => {
  it('MarkdownV2 예약문자를 전부 이스케이프한다', () => {
    expect(escapeMarkdownV2('a_b*c[d]e(f)g~h`i>j#k+l-m=n|o{p}q.r!s'))
      .toBe('a\\_b\\*c\\[d\\]e\\(f\\)g\\~h\\`i\\>j\\#k\\+l\\-m\\=n\\|o\\{p\\}q\\.r\\!s')
  })

  it('회사명의 밑줄을 깨뜨리지 않는다', () => {
    expect(escapeMarkdownV2('샘플_전자')).toBe('샘플\\_전자')
  })

  it('백슬래시 자신도 이스케이프된다', () => {
    expect(escapeMarkdownV2('\\')).toBe('\\\\')
  })
})

describe('formatEvent', () => {
  it('종목명·티커·제목·링크·고지를 담는다', () => {
    const msg = formatEvent(e, 'critical')
    expect(msg).toContain('샘플\\_전자')
    expect(msg).toContain('005930')
    expect(msg).toContain('단일판매')
    expect(msg).toContain(escapeMarkdownV2(e.url))
    expect(msg).toContain(DISCLAIMER)
  })

  it('요약이 있으면 포함한다', () => {
    expect(formatEvent(e, 'high', '계약금액 500억원')).toContain('계약금액 500억원')
  })

  it('고지 문구는 항상 붙는다', () => {
    expect(formatEvent(e, 'normal')).toContain('투자 권유가 아닙니다')
  })
})

describe('formatMerged', () => {
  it('여러 건을 한 메시지로 묶는다', () => {
    const msg = formatMerged([
      { event: e, tier: 'high' },
      { event: { ...e, externalId: '2', title: '무상증자결정' }, tier: 'high' },
    ])
    expect(msg).toContain('공시 2건')
    expect(msg).toContain('단일판매')
    expect(msg).toContain('무상증자결정')
    expect(msg).toContain(DISCLAIMER)
  })
})

describe('escape invariant — 예약문자 누락 감지', () => {
  it('예약문자를 포함한 모든 입력을 올바르게 이스케이프한다 (formatEvent)', () => {
    const msg = formatEvent(e, 'critical')

    // Company name and ticker must appear escaped (company name has _)
    const escapedName = escapeMarkdownV2(e.subject!.name)
    const escapedTicker = escapeMarkdownV2(e.subject!.ticker!)
    expect(msg).toContain(escapedName)
    expect(msg).toContain(escapedTicker)

    // URL must appear fully escaped (contains . = ? etc.)
    const escapedUrl = escapeMarkdownV2(e.url)
    expect(msg).toContain(escapedUrl)

    // Critical: verify unescaped reserved characters from URL don't appear
    // If someone removes escapeMarkdownV2(e.url), these patterns will leak through
    expect(msg).not.toContain('dart.fss.or.kr')
    expect(msg).not.toContain('rcpNo=')
    expect(msg).not.toContain('main.do')
  })

  it('병합 메시지에서 모든 URL을 이스케이프한다 (formatMerged)', () => {
    const e2: NormalizedEvent = {
      ...e,
      externalId: '20260919000456',
      url: 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260919000456',
      title: '무상증자결정',
    }

    const msg = formatMerged([
      { event: e, tier: 'high' },
      { event: e2, tier: 'critical' },
    ])

    // Both URLs must appear escaped
    const escapedUrl1 = escapeMarkdownV2(e.url)
    const escapedUrl2 = escapeMarkdownV2(e2.url)
    expect(msg).toContain(escapedUrl1)
    expect(msg).toContain(escapedUrl2)

    // Critical: verify unescaped reserved characters don't appear from either event
    // If someone removes escapeMarkdownV2(event.url) in formatMerged, these leak through
    expect(msg).not.toContain('rcpNo=20260919000123')
    expect(msg).not.toContain('rcpNo=20260919000456')
    expect(msg).not.toContain('main.do?')
  })
})
