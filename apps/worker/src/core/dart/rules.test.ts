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
    // '주주명부폐쇄기간또는기준일설정'은 이번 튜닝 패스에서 NOISE_PATTERNS로 옮겨졌다
    // (Finding 5 참고) — 이 게이트를 대표하는 픽스처를 감사보고서제출(실측 12건, 여전히
    // 어떤 목록에도 없음)로 교체한다.
    expect(evaluateDart(ev('감사보고서제출')))
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

/**
 * 두 번째 튜닝 패스. no-keyword-match 4,136건 중 약 3,200건이 정형 서류였고, 그
 * 밑에 진짜 신규 시그널(기타시장안내의 실질심사, 조회공시요구 절반, CB 이동 등)이
 * 묻혀 있었다. 아래 픽스처도 filings.json(20영업일 · 15,477건)에서 그대로 가져왔다.
 */
describe('게이트 5 — 노이즈 확장: 다이제스트 신호 정리 (Finding 5)', () => {
  it.each([
    ['주식등의대량보유상황보고서(일반)', '5% 룰 — 의도적으로 범위 밖 (실측 882건)'],
    ['대규모기업집단현황공시[분기별공시(개별회사용)]', '분기별 대규모기업집단 현황공시 (실측 384건)'],
    ['투자설명서(일괄신고)', '등록 서류 (실측 333건)'],
    ['일괄신고추가서류', '등록 서류 (실측 316건)'],
    ['증권발행실적보고서', '발행결정 후속 서류 (실측 312건)'],
    ['증권발행결과(자율공시)', '발행결정 후속 서류 (실측 76건)'],
    ['최대주주등소유주식변동신고서', '실측 236건'],
    ['주주명부폐쇄기간또는기준일설정', '실측 121건'],
    ['주주총회소집결의(임시주주총회)', '실측 112건'],
    ['임시주주총회결과', '실측 97건'],
    ['의결권대리행사권유참고서류', '실측 65건'],
    ['임원ㆍ주요주주특정증권등거래계획보고서', 'U+318D 표기 (실측 59건)'],
    ['독립이사의선임ㆍ해임또는중도퇴임에관한신고', '실측 49건'],
    ['신탁계약에의한취득상황보고서', '실측 37건'],
    ['자기주식취득결과보고서', '취득결정 후속 서류 (실측 31건)'],
    ['신탁계약해지결과보고서', '해지결정 후속 서류 (실측 30건)'],
    ['자기주식처분결과보고서', '처분결정 후속 서류 (실측 15건)'],
    ['소액공모공시서류(지분증권)', '실측 20건'],
    ['소액공모실적보고서', '실측 15건'],
  ])('%s 는 drop(noise) — %s', (title) => {
    expect(evaluateDart(ev(title))).toEqual({ action: 'drop', reason: 'noise' })
  })

  /**
   * 노이즈는 부분일치라서 화이트리스트 키워드를 우연히 삼킬 수 있다. rules.ts에서
   * 키워드 티어링(게이트 6)을 노이즈(게이트 5)보다 먼저 실행하도록 순서를 바꿔서
   * 막았다 — 아래 두 사례를 실측 데이터에서 직접 찾아 검증했다.
   */
  it('노이즈보다 화이트리스트 키워드가 우선한다 — 최대주주등소유주식변동신고서(최대주주변경시) (실측 3건)는 critical로 살아남는다', () => {
    const v = evaluateDart(ev('최대주주등소유주식변동신고서(최대주주변경시)'))
    expect(v).toMatchObject({ action: 'pass', tier: 'critical', rule: 'keyword:최대주주변경' })
  })

  it('노이즈보다 화이트리스트 키워드가 우선한다 — 회사합병결정이 섞인 임시주주총회소집결의 철회 (실측 2건)는 critical로 살아남는다', () => {
    const v = evaluateDart(ev('기타주요경영사항(자회사의 주요경영사항)              (회사합병 결정 및 임시주주총회 소집결의 철회)'))
    expect(v).toMatchObject({ action: 'pass', tier: 'critical', rule: 'keyword:회사합병결정' })
  })
})

describe('게이트 6 — 신규 키워드 (Finding 6)', () => {
  it('실질심사(실측 21건, no-keyword-match)는 critical — 상장적격성 실질심사는 상장폐지로 이어질 수 있는 심사 절차다', () => {
    // filings.json: '기타시장안내(실질심사대상여부결정을위한조사기간연장안내)              '
    const v = evaluateDart(ev('기타시장안내(실질심사대상여부결정을위한조사기간연장안내)'))
    expect(v).toMatchObject({ action: 'pass', tier: 'critical', rule: 'keyword:실질심사' })
  })

  it("거래정지와 실질심사가 함께 나오는 제목은 거래정지 특례 라벨을 유지한다 — CRITICAL_KEYWORDS 배열에서 '실질심사'를 '거래정지' 뒤에 둔 이유", () => {
    // filings.json: '주권매매거래정지기간변경              (상장적격성실질심사대상(사유발생))'
    const v = evaluateDart(ev('주권매매거래정지기간변경              (상장적격성실질심사대상(사유발생))'))
    expect(v).toMatchObject({ action: 'pass', tier: 'critical', rule: 'keyword:거래정지' })
  })

  it.each([
    ['조회공시요구(현저한시황변동)에대한답변(중요정보없음)', '실측 4건'],
    ['조회공시요구(현저한시황변동)', '요구 그 자체 — 실측 3건'],
    ['조회공시요구(풍문또는보도)에대한답변(미확정)', '기존 좁은 키워드가 커버하던 사례 — 실측 10건'],
  ])('%s 는 넓어진 조회공시요구 키워드로 high 통과한다 — %s', (title) => {
    const v = evaluateDart(ev(title))
    expect(v).toMatchObject({ action: 'pass', tier: 'high', rule: 'keyword:조회공시요구' })
  })

  it('횡령·배임처럼 더 구체적인 critical 키워드가 섞인 조회공시요구는 여전히 critical이 이긴다', () => {
    // filings.json: '조회공시요구(풍문또는보도)(현직임원의횡령·배임혐의설)              '
    const v = evaluateDart(ev('조회공시요구(풍문또는보도)(현직임원의횡령·배임혐의설)'))
    expect(v).toMatchObject({ action: 'pass', tier: 'critical', rule: 'keyword:횡령·배임' })
  })

  it.each([
    ['주요사항보고서(자기전환사채만기전취득결정)', '자사 CB 만기전 취득 — 실측 34건'],
    ['전환사채(해외전환사채포함)발행후만기전사채취득', '해외전환사채 포함 만기전 취득 — 실측 31건'],
    ['주요사항보고서(자기전환사채매도결정)', 'CB 재매각 — 실측 10건'],
  ])('%s 는 normal — %s', (title) => {
    const v = evaluateDart(ev(title))
    expect(v).toMatchObject({ action: 'pass', tier: 'normal' })
  })

  it('CB 이동 키워드가 주요사항보고서(전환사채권발행결정)를 삼키지 않는다 — 여전히 critical', () => {
    const v = evaluateDart(ev('주요사항보고서(전환사채권발행결정)'))
    expect(v).toMatchObject({ action: 'pass', tier: 'critical', rule: 'keyword:전환사채권발행결정' })
  })

  it.each([
    ['대표이사변경', '실측 31건'],
    ['금전대여결정', '실측 25건'],
    ['투자판단관련주요경영사항', '회사 스스로 중요하다고 표시한 공시 — 실측 87건'],
  ])('%s 는 normal — %s', (title) => {
    const v = evaluateDart(ev(title))
    expect(v).toMatchObject({ action: 'pass', tier: 'normal', rule: `keyword:${title}` })
  })

  it('회사분할결정(실측 3건)은 회사합병결정과 대칭인 취득·처분 비대칭 패턴 — critical', () => {
    // filings.json: '주요사항보고서(회사분할결정)'
    const v = evaluateDart(ev('주요사항보고서(회사분할결정)'))
    expect(v).toMatchObject({ action: 'pass', tier: 'critical', rule: 'keyword:회사분할결정' })
  })

  it('기타경영사항(자율공시)(실측 26건)은 의도적으로 어떤 목록에도 넣지 않는다 — 본문 없이는 잡다해서 판단 불가', () => {
    expect(evaluateDart(ev('기타경영사항(자율공시)')))
      .toEqual({ action: 'drop', reason: 'no-keyword-match' })
  })
})

/**
 * '분할' 단독 마커는 지나치게 넓은 부분일치였다. 실데이터에 실제로 나타나는 온전한
 * 표현 '주식의 병합, 분할'로 좁혔다 — 기계적 판정 건수는 좁히기 전후로 동일했다
 * (실측 전수 검증: 63건, 변화 없음). 아래는 그 경계를 다시 확인하는 회귀 테스트다.
 */
describe('게이트 6 — 거래정지 마커 좁히기: 분할 → 주식의 병합, 분할 (Finding 7)', () => {
  it('기계적 사유는 여전히 normal로 낮아진다 — 주식의 병합, 분할 등 전자등록 변경 (실측 21건)', () => {
    const v = evaluateDart(ev('주권매매거래정지              (주식의 병합, 분할 등 전자등록 변경, 말소)'))
    expect(v).toMatchObject({ action: 'pass', tier: 'normal', rule: 'keyword:거래정지' })
  })

  it('실제 이상 신호는 마커 좁히기와 무관하게 critical을 유지한다 — SPAC 합병 예비심사청구대상으로 인한 거래정지 (실측 2건)', () => {
    // filings.json: '주권매매거래정지              (SPAC 합병(예비심사청구대상))              '
    const v = evaluateDart(ev('주권매매거래정지              (SPAC 합병(예비심사청구대상))'))
    expect(v).toMatchObject({ action: 'pass', tier: 'critical', rule: 'keyword:거래정지' })
  })
})
