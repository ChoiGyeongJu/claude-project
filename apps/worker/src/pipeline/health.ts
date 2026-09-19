/** ping() 은 절대 throw 하지 않는다. 반환값은 "모니터링 서비스가 확인했는가". */
export type Heartbeat = { ping(): Promise<boolean> }

export type HeartbeatConfig = {
  url: string | null
  fetchImpl?: typeof fetch
}

/**
 * 외부 감시 서비스에 생존 신호를 보낸다.
 * 반드시 워커 외부의 서비스를 가리켜야 한다 — 같은 VM에 두면 VM이 죽을 때 감시도 같이 죽는다.
 */
export function createHeartbeat(cfg: HeartbeatConfig): Heartbeat {
  const doFetch = cfg.fetchImpl ?? fetch
  return {
    async ping(): Promise<boolean> {
      if (!cfg.url) return true // 설정하지 않은 경우는 실패가 아니다
      try {
        const res = await doFetch(cfg.url)
        // 상태 코드를 반드시 본다. URL 오타나 계정 만료는 4xx/5xx 로 오는데
        // 이를 성공으로 취급하면 "감시가 깨진 상태"가 영원히 보이지 않는다.
        return res.ok
      } catch {
        // 감시 서비스 장애가 워커를 멈추게 해서는 안 된다
        return false
      }
    },
  }
}
