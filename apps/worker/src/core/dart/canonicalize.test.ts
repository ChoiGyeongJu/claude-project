import { describe, it, expect } from 'vitest'
import { canonicalizeTitle } from './canonicalize.js'
import { CRITICAL_KEYWORDS } from './keywords.js'

// keywords.ts에 이미 정규화되어 있는 실제 키워드를 그대로 참조한다 — 기대값을
// 다시 손으로 옮겨 적으면 원래 버그와 같은 실수(코드와 테스트가 같은 오타에
// 합의)를 반복할 위험이 있다.
const EMBEZZLEMENT_KEYWORD = CRITICAL_KEYWORDS.find((k) => k.includes('배임'))!

describe('canonicalizeTitle', () => {
  it('실제 DART 데이터의 두 가운뎃점 표기(U+318D "ㆍ", U+00B7 "·")를 같은 문자로 통일한다', () => {
    // 아래 두 문자열은 filings.json(캐시된 실 DART 응답, 15,477건)에서 그대로 가져왔다.
    // U+318D: '횡령ㆍ배임혐의발생              ' (실측 7건 중 하나)
    // U+00B7: '조회공시요구(풍문또는보도)              (현직 임원의 횡령·배임혐의설)' (실측 2건 중 하나)
    const araeaTitle = '횡령ㆍ배임혐의발생'
    const middleDotTitle = '조회공시요구(풍문또는보도)              (현직 임원의 횡령·배임혐의설)'

    expect(canonicalizeTitle(araeaTitle).includes(EMBEZZLEMENT_KEYWORD)).toBe(true)
    expect(canonicalizeTitle(middleDotTitle).includes(EMBEZZLEMENT_KEYWORD)).toBe(true)
  })

  it('순서 함정 — 가운뎃점 치환은 반드시 NFKC 정규화보다 먼저 실행되어야 한다', () => {
    // U+318D(ㆍ, HANGUL LETTER ARAEA)는 NFKC 정규화에서 U+119E(HANGUL JUNGSEONG ARAEA,
    // 한글 모음 자모)로 호환 매핑된다. filings.json에서 실제로 관측되는 두 표기(U+00B7,
    // U+318D)만 넣은 좁은 정규식으로 재현하면: 정규화를 먼저 실행할 경우 문자가 이미
    // U+119E로 바뀐 뒤라 정규식이 더는 그 문자를 찾지 못해 치환이 씹힌다.
    const araea = 'ㆍ'
    const middleDot = '·'
    const observedDotsOnly = /[·ㆍ]/g // filings.json에서 실제로 관측된 두 표기만

    const nfkcFirst = araea.normalize('NFKC').replace(observedDotsOnly, middleDot)
    expect(nfkcFirst).not.toBe(middleDot) // 잘못된 순서: 치환 대상 문자가 이미 사라져 매칭되지 않는다

    const replaceFirst = araea.replace(observedDotsOnly, middleDot).normalize('NFKC')
    expect(replaceFirst).toBe(middleDot) // 올바른 순서 (canonicalizeTitle과 동일)

    // 참고(실측 검증 중 발견, 과제 설명과 다른 점): 실제로 배포되는 MIDDLE_DOTS
    // 정규식은 NFKC의 타깃인 U+119E(ᆞ)까지 방어적으로 이미 포함하고 있어서, 이
    // 정규식을 그대로 쓰는 한 순서를 바꿔도 이 특정 케이스는 우연히 안전하다.
    // 그래도 정규식에서 그 문자가 빠지는 순간 조용히 다시 깨지는 함정이므로,
    // canonicalizeTitle의 구현 순서(치환 → 정규화)는 과제 지시대로 바꾸지 않는다.
    expect(canonicalizeTitle(araea)).toBe(middleDot)
  })

  it('공백을 모두 제거한다 — DART 응답에 섞여 오는 정렬용 패딩 공백 대응', () => {
    // filings.json 실제 레코드 그대로: { report_nm: '주식소각결정              ', ... }
    expect(canonicalizeTitle('주식소각결정              ')).toBe('주식소각결정')

    // 괄호 안 내부에도 공백이 섞인 실제 제목:
    // '주권매매거래정지              (주식의 병합, 분할 등 전자등록 변경, 말소)'
    const halted = '주권매매거래정지              (주식의 병합, 분할 등 전자등록 변경, 말소)'
    expect(canonicalizeTitle(halted)).not.toMatch(/\s/)
    expect(canonicalizeTitle(halted)).toBe('주권매매거래정지(주식의병합,분할등전자등록변경,말소)')
  })

  it('이미 정규화된 문자열에는 항등원처럼 동작한다', () => {
    const already = canonicalizeTitle('무상증자결정')
    expect(canonicalizeTitle(already)).toBe(already)
  })
})
