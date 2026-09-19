import { describe, it, expect } from 'vitest'
import { formatDigest, type DigestData } from './digest.js'

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
