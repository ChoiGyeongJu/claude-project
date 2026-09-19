import { describe, it, expect } from 'vitest'
import { formatDigest, type DigestData } from './digest.js'
import { MAX_MERGED_CHARS } from './policy.js'

const data: DigestData = {
  kstDate: '2026-09-19',
  sent: { critical: 4, high: 12, normal: 8 },
  dead: 1,
  apiCalls: 8_432,
  missedCandidates: [
    { title: '주주명부폐쇄기간또는기준일설정', corpName: '샘플_전자', ticker: '005930' },
    { title: '특허권취득', corpName: '샘플바이오', ticker: '123456' },
  ],
  errorCounts: { 'dart-timeout': 3, 'telegram-429': 1 },
  missedTotal: 2,
}

describe('formatDigest', () => {
  it('티어별 발송 건수를 담는다', () => {
    const s = formatDigest(data)
    expect(s).toContain('critical 4')
    expect(s).toContain('high 12')
    expect(s).toContain('normal 8')
  })

  it('API 사용량을 한도와 함께 보여준다', () => {
    expect(formatDigest(data)).toContain('8432 / 20000')
  })

  it('과필터링 후보를 나열한다 — 룰 튜닝의 유일한 단서', () => {
    const s = formatDigest(data)
    expect(s).toContain('미매칭 2건')
    expect(s).toContain('주주명부폐쇄기간또는기준일설정')
  })

  it('회사명의 마크다운 예약문자를 이스케이프한다', () => {
    expect(formatDigest(data)).toContain('샘플\\_전자')
  })

  it('에러 집계를 담는다', () => {
    const s = formatDigest(data)
    expect(s).toContain('dart\\-timeout')
    expect(s).toContain('3')
  })

  it('미매칭이 없으면 그 사실을 표시한다', () => {
    const s = formatDigest({ ...data, missedCandidates: [], missedTotal: 0 })
    expect(s).toContain('미매칭 0건')
  })

  it('미매칭 총계가 표시 건수보다 많으면(상한 잘림) 총계와 잘림 사실을 함께 보여준다', () => {
    // missedCandidates는 상위 50건까지만 담기지만(어댑터의 .limit(50)), 실제로는
    // 그보다 많이 드롭됐을 수 있다 — missedTotal이 진짜 심각도, length는 표시 개수일 뿐이다.
    const s = formatDigest({ ...data, missedTotal: 300 })
    expect(s).toContain('미매칭 300건')
    expect(s).toContain('상위 2건 표시')
  })

  it('미매칭 총계가 표시 건수와 같으면(잘리지 않음) 잘림 표시 없이 총계만 보여준다', () => {
    const s = formatDigest({ ...data, missedTotal: 2 })
    expect(s).toContain('미매칭 2건')
    expect(s).not.toContain('상위')
  })
})

/**
 * I3 회귀 — 텔레그램 sendMessage 본문 한도는 4096자이고 넘으면 메시지가 통째로
 * 거부된다. 하필 과필터링이 가장 심한 날 다이제스트가 가장 길어지므로, 신호가
 * 가장 필요한 날에 정확히 죽는다.
 */
describe('formatDigest — 길이 상한', () => {
  /** 어댑터 상한(50건)까지 꽉 채우고 제목도 긴, 최악에 가까운 날. */
  const heavy: DigestData = {
    ...data,
    missedCandidates: Array.from({ length: 50 }, (_, i) => ({
      title: `${i} 매우긴공시제목을가진회사의공시명입니다`.repeat(6),
      corpName: `회사이름이아주긴주식회사${i}`,
      ticker: '000000',
    })),
    missedTotal: 400,
  }

  it('상한을 넘지 않는다', () => {
    expect(formatDigest(heavy).length).toBeLessThanOrEqual(MAX_MERGED_CHARS)
  })

  it('상한이 텔레그램 4096자보다 작다 — 여유가 실제로 있는지 고정한다', () => {
    expect(MAX_MERGED_CHARS).toBeLessThan(4_096)
  })

  it('잘라도 총계는 줄이지 않는다 — 표시 개수는 잘려도 심각도는 잘리면 안 된다', () => {
    const s = formatDigest(heavy)
    expect(s).toContain('미매칭 400건')
    expect(s).toContain('상위')
  })

  it('몇 건을 표시했는지 실제 표시 건수와 일치시킨다', () => {
    const s = formatDigest(heavy)
    const shown = Number(/상위 (\d+)건 표시/.exec(s)?.[1])
    expect(Number.isNaN(shown)).toBe(false)
    expect(shown).toBeLessThan(50) // 실제로 잘렸다
    expect(s.split('\n').filter((l) => l.startsWith('  • '))).toHaveLength(shown)
  })

  it('헤더만으로도 상한을 넘는 극단에서는 목록을 통째로 생략한다', () => {
    const s = formatDigest({
      ...heavy,
      missedCandidates: [{ title: 'x'.repeat(MAX_MERGED_CHARS * 2), corpName: 'c', ticker: null }],
      missedTotal: 1,
    })
    expect(s.length).toBeLessThanOrEqual(MAX_MERGED_CHARS)
    expect(s).toContain('길이 제한으로 목록 생략')
    expect(s).toContain('미매칭 1건')
  })

  it('짧은 날은 예전과 똑같이 전부 표시한다 — 상한이 평상시를 건드리면 안 된다', () => {
    const s = formatDigest(data)
    expect(s.split('\n').filter((l) => l.startsWith('  • '))).toHaveLength(2)
    expect(s).not.toContain('상위')
  })
})
