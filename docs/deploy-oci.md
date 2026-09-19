# OCI 배포 절차

## 1. 계정 준비

**PAYG(종량제)로 업그레이드한다.** Always Free 계정의 유휴 인스턴스는 회수 대상이며,
저부하 폴링 워커는 정확히 그 프로필에 해당한다. PAYG 전환 후에도 Always Free 한도
안에서만 쓰면 청구액은 $0이다.

## 2. 인스턴스

- 이미지: Ubuntu 22.04 LTS
- Shape: `VM.Standard.E2.1.Micro` (Always Free, 1GB)
  - ARM(Ampere A1)은 용량 부족이 상습적이므로 기다리지 않는다. 나중에 잡히면 이전한다.
- 인바운드 포트: **SSH(22)만 연다.** 워커는 전부 아웃바운드라 다른 포트가 필요 없다.

## 3. 데이터베이스 준비 (Supabase)

1. Supabase 프로젝트를 **서울 리전(ap-northeast-2)**으로 생성한다. 국외이전 이슈를
   피하고 DART/텔레그램 호출과의 왕복 지연도 줄어든다.
2. 프로젝트의 Database 설정에서 연결 문자열을 받아 `DATABASE_URL`로 쓴다.
3. **마이그레이션을 먼저 적용한다 — 컨테이너를 처음 띄우기 전에, 반드시.** 워커는
   시작할 때 스키마를 자동 생성하지 않는다. 저장소(레포)가 있는 아무 머신에서나
   (배포 대상 VM일 필요 없다) 아래를 실행한다:

   ```bash
   DATABASE_URL="<supabase 연결 문자열>" \
     pnpm --filter @app/worker exec drizzle-kit migrate
   ```

   `apps/worker/drizzle/0000_*.sql`이 적용되어 `events`, `outbox`, `api_usage` 테이블이
   생긴다. 이걸 건너뛰면 컨테이너는 정상적으로 뜨지만 첫 사이클에서 바로
   `relation "events" does not exist` 류의 DB 에러로 실패한다.

## 4. 환경 변수 (`worker.env`)

`docker run --env-file`로 넘길 파일에 아래 키를 모두 채운다. 하나라도 빠지거나
형식이 안 맞으면 워커는 시작 직후 설정 검증에서 죽는다(정상 동작 — crash-only 설계).

| 키 | 설명 |
|---|---|
| `DATABASE_URL` | 3번에서 마이그레이션에 쓴 것과 **동일한** Supabase 연결 문자열 |
| `DART_API_KEY` | OpenDART 인증키. **정확히 40자여야 한다** — 스키마가 길이를 강제하며, 아니면 워커가 시작하자마자 알아보기 힘든 검증 에러를 내고 죽는다 |
| `TELEGRAM_BOT_TOKEN` | @BotFather에서 발급한 봇 토큰 |
| `TELEGRAM_CHAT_ID` | 공시 알림을 보낼 구독자 채널/챗의 ID |
| `TELEGRAM_OPERATOR_CHAT_ID` | 선택 항목. 설정하면 **일일 다이제스트와 연속 실패 알림만** 이 채널로 간다. 없으면 둘 다 위의 구독자 채널로 간다 — 비공개 단계에서는 구독자가 운영자뿐이라 무방하지만, **공개 전환 전에 반드시 설정해야 한다**. 다이제스트에는 버려진 공시 목록과 내부 카운터가 그대로 들어간다 |
| `LLM_API_KEY` | 요약에 쓰는 LLM API 키. 현재 요약은 꺼져 있지만(본문 조회가 붙는 Task 18까지) 설정 스키마상 **여전히 필수**다 |
| `HEARTBEAT_URL` | 선택 항목 — 6번 참고 |

(`LLM_MODEL`, `LLM_ENDPOINT`는 기본값이 있어 생략 가능하다. 바꿀 때만 채운다.)

## 5. Docker 설치와 실행

```bash
sudo apt-get update && sudo apt-get install -y docker.io
sudo usermod -aG docker "$USER" && newgrp docker

docker run -d --name dart-worker \
  --restart always \
  --stop-timeout 45 \
  --env-file /home/ubuntu/worker.env \
  dart-worker
```

`--restart always`가 crash-only 설계의 한쪽 축이다. 프로세스가 죽으면 Docker가 되살린다.

**`--stop-timeout 45`는 절대 지우지 않는다.** 워커는 SIGTERM을 받으면 진행 중인
사이클을 끝까지 마치고 종료하는데, 텔레그램 호출 타임아웃만 15초, LLM 호출
타임아웃은 30초라 한 사이클이 Docker 기본 유예(10초)보다 길게 걸리는 일이 실제로
있다 — 유예가 끝나 SIGKILL이 사이클 중간에 떨어지면, 텔레그램이 이미 수신한 알림이
`markSent` 처리 전에 죽어 재시작 시 같은 알림이 중복 발송될 수 있다. Docker Compose를
쓴다면 동일한 이유로 서비스에 `stop_grace_period: 45s`를 넣는다.

## 6. 외부 감시 (시작에는 선택, 무인 운영에는 필수)

`HEARTBEAT_URL`은 설정 스키마상 선택 값이라 없어도 워커는 정상적으로 시작한다.
하지만 이 배포는 **운영자가 실시간으로 대응할 수 없다는 전제**로 하는 것이므로,
하트비트 없이는 프로세스가 조용히 죽거나(OOM, VM 회수 등) 멈춰도 아무도 모른 채
방치된다. 실제 운영에서는 사실상 필수로 취급한다.

Healthchecks.io 류에서 ping URL을 발급받아 `HEARTBEAT_URL`에 넣는다.
**반드시 OCI 외부 서비스여야 한다** — 같은 VM에 두면 VM이 죽을 때 감시도 같이 죽는다.

주기는 폴링 주기보다 넉넉히 잡는다 (예: grace period 10분).

## 7. 로그 확인

```bash
docker logs -f --tail 100 dart-worker
```

## 8. 컨테이너는 떠 있는데 알림이 안 올 때

1. **로그에서 `cycle failed`를 찾는다.**
   ```bash
   docker logs --tail 200 dart-worker | grep "cycle failed"
   ```
   `relation ... does not exist` 류가 보이면 3번의 마이그레이션이 적용되지 않은 것이다.
2. **마이그레이션이 실제로 적용됐는지 Supabase 테이블 목록에서 `events`, `outbox`,
   `api_usage`가 보이는지로 확인한다.**
3. **텔레그램 봇이 채널의 관리자(admin)로 추가돼 있는지 확인한다.** 봇을 멤버로만
   추가하면 발송이 조용히 실패한다.
4. **장 시간 외에는 조용한 것이 정상일 수 있다.** 폴링 주기는 평일 장중(KST
   08:00–18:59) 2.5초, 그 외 평일 30초, 주말 5분으로 설계돼 있다 — 장 마감 후나
   주말에 알림이 뜸한 것은 버그가 아니다.
