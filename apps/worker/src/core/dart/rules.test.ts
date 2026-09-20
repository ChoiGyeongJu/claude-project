import { describe, it, expect } from 'vitest'
import type { NormalizedEvent } from '@app/shared'
import { evaluateDart } from './rules.js'

const SEEN = new Date('2026-09-19T06:30:00.000Z')

function ev(title: string, opts: Partial<NormalizedEvent['subject']> = {}): NormalizedEvent {
  return {
    sourceId: 'dart',
    externalId: '20260919000001',
    occurredAt: SEEN,
    firstSeenAt: SEEN,
    title,
    url: 'https://example.test',
    subject: { name: '샘플', ticker: '005930', market: 'Y', ...opts },
    raw: {},
  }
}

describe('게이트 1 — 비상장 제외', () => {
  it('ticker가 없으면 drop', () => {
    const v = evaluateDart(ev('무상증자결정', { ticker: undefined }))
    expect(v).toEqual({ action: 'drop', reason: 'no-stock-code' })
  })
})

describe('게이트 2 — 시장 제외', () => {
  it('market이 Y/K가 아니면 drop', () => {
    const v = evaluateDart(ev('무상증자결정', { market: undefined }))
    expect(v).toEqual({ action: 'drop', reason: 'market-not-target' })
  })
})

describe('게이트 3 — 정기보고서 제외', () => {
  it.each(['사업보고서 (2025.12)', '반기보고서 (2025.06)', '분기보고서 (2025.03)'])(
    '%s 는 drop', (title) => {
      expect(evaluateDart(ev(title))).toEqual({ action: 'drop', reason: 'periodic-report' })
    })
})

describe('게이트 4 — 정정 접두어', () => {
  it('[기재정정]은 drop', () => {
    expect(evaluateDart(ev('[기재정정]무상증자결정')))
      .toEqual({ action: 'drop', reason: 'minor-correction' })
  })

  it('[발행조건확정]은 high로 통과', () => {
    const v = evaluateDart(ev('[발행조건확정]유상증자결정'))
    expect(v).toMatchObject({ action: 'pass', tier: 'high', rule: 'prefix:발행조건확정' })
  })

  it('[정정명령부과]는 critical로 통과', () => {
    const v = evaluateDart(ev('[정정명령부과]사업보고서'))
    expect(v).toMatchObject({ action: 'pass', tier: 'critical', rule: 'prefix:정정명령부과' })
  })
})

describe('게이트 5 — 노이즈 제외', () => {
  it('임원·주요주주 소유상황보고서는 drop', () => {
    expect(evaluateDart(ev('임원·주요주주특정증권등소유상황보고서')))
      .toEqual({ action: 'drop', reason: 'noise' })
  })

  it('IR개최는 drop', () => {
    expect(evaluateDart(ev('기업설명회(IR)개최(안내공시)')))
      .toEqual({ action: 'drop', reason: 'noise' })
  })
})

describe('게이트 6 — 키워드 티어링', () => {
  it.each([
    '단일판매·공급계약체결',
    '무상증자결정',
    '자기주식취득결정',
    '최대주주변경',
    '횡령·배임혐의발생',
  ])('%s 는 critical', (title) => {
    const v = evaluateDart(ev(title))
    expect(v).toMatchObject({ action: 'pass', tier: 'critical' })
  })

  it.each([
    '매출액또는손익구조30%(대규모법인은15%)이상변동',
    '타법인주식및출자증권취득결정',
    '현금·현물배당결정',
  ])('%s 는 high', (title) => {
    const v = evaluateDart(ev(title))
    expect(v).toMatchObject({ action: 'pass', tier: 'high' })
  })

  it('매칭된 키워드를 rule에 남긴다', () => {
    const v = evaluateDart(ev('무상증자결정'))
    expect(v).toMatchObject({ rule: 'keyword:무상증자결정' })
  })
})

/**
 * 화이트리스트에 취득 계열만 있고 처분·소각 계열이 통째로 빠져 있었다.
 * 자사주 소각은 유통주식수를 영구히 줄이는, 시장에서 가장 강한 촉매 중 하나인데
 * no-keyword-match 로 조용히 버려지고 있었다 — 버려진 건은 발송에 나타나지 않으므로
 * 다이제스트의 미매칭 목록을 보지 않는 한 영원히 보이지 않는다(스펙 §7.4).
 */
describe('게이트 6 — 처분·소각 계열', () => {
  it.each([
    '자기주식처분결정',
    // '자기주식소각결정'은 filings.json 실측 0건이었다 — DART 실제 표기는
    // '자기' 없이 '주식소각결정'(실측 44건)이다. 아래 '가운뎃점 정규화·죽은
    // 키워드 교체 검증' 구역에 실데이터 원문 픽스처로 별도 커버한다.
    '주식소각결정',
    '타법인주식및출자증권처분결정',
    '자기주식취득신탁계약해지결정',
  ])('%s 는 critical', (title) => {
    expect(evaluateDart(ev(title))).toMatchObject({
      action: 'pass', tier: 'critical', rule: `keyword:${title}`,
    })
  })

  it.each([
    ['자기주식취득결정', '자기주식처분결정'],
    ['자기주식취득신탁계약체결결정', '자기주식취득신탁계약해지결정'],
    ['타법인주식및출자증권취득결정', '타법인주식및출자증권처분결정'],
  ])(
    '%s 과 %s 를 서로 다른 키워드로 구분한다 — 부분 문자열로 섞이면 안 된다',
    (acquire, dispose) => {
      expect(evaluateDart(ev(dispose))).toMatchObject({ rule: `keyword:${dispose}` })
      expect(evaluateDart(ev(acquire)).action).toBe('pass')
    },
  )

  it('해지결정이 취득결정 키워드에 먼저 걸리지 않는다 — 배열 순서 회귀', () => {
    // '자기주식취득신탁계약해지결정'.includes('자기주식취득결정') 가 false 여야
    // 배열 앞쪽 항목이 이 제목을 가로채지 않는다.
    expect('자기주식취득신탁계약해지결정'.includes('자기주식취득결정')).toBe(false)
    expect(evaluateDart(ev('자기주식취득신탁계약해지결정')))
      .toMatchObject({ rule: 'keyword:자기주식취득신탁계약해지결정' })
  })
})

describe('게이트 7 — 화이트리스트 미매칭', () => {
  it('목록에 없는 공시는 drop하고 사유를 남긴다', () => {
    expect(evaluateDart(ev('주주명부폐쇄기간또는기준일설정')))
      .toEqual({ action: 'drop', reason: 'no-keyword-match' })
  })
})

describe('추가: 인식되지 않는 접두어 제거 후 정기보고서 판정', () => {
  it('[변경]사업보고서 는 unrecognized prefix를 제거하고 periodic-report로 drop', () => {
    expect(evaluateDart(ev('[변경]사업보고서')))
      .toEqual({ action: 'drop', reason: 'periodic-report' })
  })
})

/**
 * 아래 모든 제목 픽스처는 손으로 옮겨 적지 않고, 캐시된 실제 DART 응답
 * (filings.json, 20영업일 · 15,477건)에서 그대로 가져왔다. 기존 버그가
 * 숨어 있었던 이유가 바로 "코드와 테스트가 같은 손타이핑 오타에 합의"했기
 * 때문이었으므로, 이 파일에서만큼은 픽스처를 다시 손으로 치지 않는다.
 */
describe('게이트 6 — 가운뎃점 정규화 (Finding 1)', () => {
  it('DART가 압도적으로 많이 쓰는 U+318D(ㆍ) 표기 — 단일판매ㆍ공급계약체결(실측 410건)이 critical로 잡힌다', () => {
    // filings.json: { report_nm: '단일판매ㆍ공급계약체결              ', ... } (에스비비테크, 389500)
    // 가운뎃점 정규화 이전에는 코드의 키워드가 U+00B7이라 이 문자열이 no-keyword-match로 조용히 버려졌다.
    const v = evaluateDart(ev('단일판매ㆍ공급계약체결'))
    expect(v).toMatchObject({ action: 'pass', tier: 'critical', rule: 'keyword:단일판매·공급계약체결' })
  })

  it('U+00B7(·)과 U+318D(ㆍ) 두 표기가 같은 키워드로 수렴한다 — 횡령·배임 사례는 실측 데이터에 둘 다 있다', () => {
    // filings.json에 둘 다 실존: U+00B7 2건, U+318D 7건. DART는 표기를 통일해서 쓰지 않으므로
    // 단순 문자 치환이 아니라 canonicalizeTitle 정규화가 반드시 필요하다.
    const u00b7 = evaluateDart(ev('조회공시요구(풍문또는보도)              (현직 임원의 횡령·배임혐의설)'))
    const u318d = evaluateDart(ev('횡령ㆍ배임혐의발생'))
    expect(u00b7).toMatchObject({ action: 'pass', tier: 'critical', rule: 'keyword:횡령·배임' })
    expect(u318d).toMatchObject({ action: 'pass', tier: 'critical', rule: 'keyword:횡령·배임' })
  })

  it('노이즈 패턴도 같은 정규화를 거친다 — 임원ㆍ주요주주 소유상황보고서(U+318D, 실측 1,264건)', () => {
    // filings.json: '임원ㆍ주요주주특정증권등소유상황보고서' — 코드의 NOISE_PATTERNS는 U+00B7로 적혀 있었다.
    expect(evaluateDart(ev('임원ㆍ주요주주특정증권등소유상황보고서')))
      .toEqual({ action: 'drop', reason: 'noise' })
  })
})

describe('게이트 6 — 죽은 키워드 교체 (Finding 2)', () => {
  it("'자기주식소각결정'(실측 0건) 대신 DART 실제 표기 '주식소각결정'(실측 44건)을 쓴다", () => {
    // filings.json: '주식소각결정              ' — '자기' 접두 없는 표기만 존재한다.
    expect(evaluateDart(ev('주식소각결정')))
      .toMatchObject({ action: 'pass', tier: 'critical', rule: 'keyword:주식소각결정' })
  })

  it("노이즈 '정기주주총회소집공고'(실측 0건) 대신 DART 실제 표기 '주주총회소집공고'(실측 146건)를 쓴다", () => {
    // filings.json: '주주총회소집공고' — '정기' 접두 없는 표기만 존재한다.
    expect(evaluateDart(ev('주주총회소집공고')))
      .toEqual({ action: 'drop', reason: 'noise' })
  })
})

describe('게이트 6 — 신규 키워드 (Finding 3)', () => {
  it('소송등의제기ㆍ신청(실측 51건, 원문에 접두 없는 것만 통과)은 high', () => {
    // filings.json: '소송등의제기ㆍ신청(경영권분쟁소송)              '
    const v = evaluateDart(ev('소송등의제기ㆍ신청(경영권분쟁소송)'))
    expect(v).toMatchObject({ action: 'pass', tier: 'high', rule: 'keyword:소송등의제기' })
  })

  it('소송등의판결ㆍ결정(실측 42건)은 high', () => {
    // filings.json: '소송등의판결ㆍ결정              '
    const v = evaluateDart(ev('소송등의판결ㆍ결정'))
    expect(v).toMatchObject({ action: 'pass', tier: 'high', rule: 'keyword:소송등의판결' })
  })

  it('풍문또는보도에대한해명(실측 34건)은 high', () => {
    // filings.json: '풍문또는보도에대한해명              '
    const v = evaluateDart(ev('풍문또는보도에대한해명'))
    expect(v).toMatchObject({ action: 'pass', tier: 'high', rule: 'keyword:풍문또는보도에대한해명' })
  })

  it('전환가액의조정(실측 58건)은 새로 생긴 normal 티어로 들어간다', () => {
    // filings.json: '전환가액의조정              '
    const v = evaluateDart(ev('전환가액의조정'))
    expect(v).toMatchObject({ action: 'pass', tier: 'normal', rule: 'keyword:전환가액의조정' })
  })

  it("타인에대한채무보증결정(실측 132건)은 의도적으로 어떤 목록에도 넣지 않는다 — 본문 없이는 중요도 판단 불가", () => {
    // 목록만으로는 통상적 자회사 채무보증과 시장을 흔들 대규모 보증을 구분할 수 없다.
    expect(evaluateDart(ev('타인에대한채무보증결정')))
      .toEqual({ action: 'drop', reason: 'no-keyword-match' })
  })
})

describe('게이트 6 — 거래정지: 기계적 사유 vs 실제 이상 신호 (Finding 4)', () => {
  it.each([
    ['주권매매거래정지해제              (액면병합 주권 변경상장)', '액면병합 변경상장 (실측 36건)'],
    ['주권매매거래정지              (주식의 병합, 분할 등 전자등록 변경, 말소)', '주식의 병합·분할 등 전자등록 변경 (실측 21건)'],
  ])('%s 는 사무적 매매정지이므로 normal로 낮춘다 — %s', (title) => {
    const v = evaluateDart(ev(title))
    expect(v).toMatchObject({ action: 'pass', tier: 'normal', rule: 'keyword:거래정지' })
  })

  it.each([
    // 두 제목 모두 괄호 안에 '상장폐지'라는 문자열을 담고 있어서, CRITICAL_KEYWORDS
    // 배열에서 '거래정지'보다 먼저 오는 '상장폐지' 키워드에 먼저 걸린다 — 어느 쪽이든
    // tier는 critical로 유지되고, 마커 유무를 따지는 거래정지 특례는 아예 타지 않는다.
    // (실제 evaluateDart 실행 결과로 검증: rule은 'keyword:상장폐지'.)
    ['주권매매거래정지              (상장폐지 사유발생)', '상장폐지 사유발생 (실측 7건)', 'keyword:상장폐지'],
    // 과제에서 특히 강조한 사례: 정리매매 개시에 따른 거래정지는 진짜 이벤트다.
    ['주권매매거래정지해제              (상장폐지에 따른 정리매매 개시)', '정리매매 개시 (실측 6건) — 이 사례가 핵심', 'keyword:상장폐지'],
  ])('%s 는 실제 이상 신호이므로 critical을 유지한다 — %s', (title, _label, expectedRule) => {
    const v = evaluateDart(ev(title))
    expect(v).toMatchObject({ action: 'pass', tier: 'critical', rule: expectedRule })
  })

  it("거래정지' 자체가 매칭 키워드로 남는 실제 이상 신호도 critical을 유지한다 — 상장폐지 문구가 없는 '중요내용공시' 사례 (실측 6건)", () => {
    // filings.json: '매매거래정지및정지해제(중요내용공시)              ' — 마커(액면병합/주식의
    // 병합/분할/전자등록/변경상장) 중 어느 것도 없으므로 거래정지 특례가 critical을 유지시킨다.
    const v = evaluateDart(ev('매매거래정지및정지해제(중요내용공시)'))
    expect(v).toMatchObject({ action: 'pass', tier: 'critical', rule: 'keyword:거래정지' })
  })
})
