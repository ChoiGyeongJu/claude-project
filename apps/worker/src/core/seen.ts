/**
 * 이미 처리한 externalId 집합. 상한을 두고 오래된 것부터 버린다.
 *
 * 왜 하이워터 마크(지금까지 본 최대 id)가 아닌가 — `rcept_no` 는 **접수 시각에**
 * 부여되지만 공시 공개는 심사를 거친다. 10:00 접수(작은 번호)가 10:10 에 공개되고
 * 10:05 접수(큰 번호)가 10:06 에 공개되면, 큰 번호가 먼저 도착해 마크를 끌어올리고
 * 뒤늦게 온 작은 번호는 영영 건너뛰어진다 — 기록조차 남지 않아 그런 공시가
 * 있었다는 사실 자체를 알 수 없다. **알림을 잃지 않는 것이 이 시스템의 첫 번째
 * 약속**인데, 조용한 영구 누락은 아무도 눈치채지 못하는 방식으로 그 약속을 깬다.
 *
 * 집합 방식은 순서를 아예 가정하지 않는다. 늦게 온 공시는 그냥 "아직 안 본 것"이라
 * 정상 처리된다. 그러면서도 재조회 억제 효과는 마크와 같다 — 목록 API 가 매번
 * 돌려주는 같은 100건은 전부 집합 안에 있으므로 DB 를 건드리지 않는다.
 */
export type SeenSet = {
  has(externalId: string): boolean
  /** 이미 있으면 아무것도 하지 않는다 — 재삽입으로 나이가 젊어지지 않는다. */
  add(externalId: string): void
  readonly size: number
}

/**
 * 목록 API 는 한 번에 최대 100건을 돌려준다. 500이면 폴링 5회분 이력이라
 * 재조회 억제에 충분하고, 문자열 500개는 메모리에서 무시할 수 있는 크기다.
 */
export const SEEN_CAPACITY = 500

/**
 * `initial` 은 **오래된 것부터** 넣어야 한다. 삽입 순서가 곧 나이이고 축출은
 * 가장 오래된 쪽부터 일어나므로, 최신순으로 넣으면 가장 최근 id 가 먼저 버려진다.
 */
export function createSeenSet(
  initial: Iterable<string> = [], capacity: number = SEEN_CAPACITY,
): SeenSet {
  const ids = new Set<string>()

  function add(externalId: string): void {
    // 이미 있으면 건드리지 않는다. delete 후 재삽입하면 Set 의 순서상 맨 뒤로
    // 가서 "최근 재조회된 것"이 영원히 살아남고 진짜 새 id 가 대신 축출된다.
    if (ids.has(externalId)) return
    ids.add(externalId)
    while (ids.size > capacity) {
      // Set 은 삽입 순서를 유지하므로 첫 원소가 가장 오래된 것이다.
      const oldest = ids.values().next().value
      if (oldest === undefined) break
      ids.delete(oldest)
    }
  }

  for (const id of initial) add(id)

  return {
    has: (externalId) => ids.has(externalId),
    add,
    get size() { return ids.size },
  }
}
