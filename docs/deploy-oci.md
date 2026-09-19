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

## 3. Docker 설치와 실행

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

## 4. 외부 감시 (필수)

Healthchecks.io 류에서 ping URL을 발급받아 `HEARTBEAT_URL`에 넣는다.
**반드시 OCI 외부 서비스여야 한다** — 같은 VM에 두면 VM이 죽을 때 감시도 같이 죽는다.

주기는 폴링 주기보다 넉넉히 잡는다 (예: grace period 10분).

## 5. 로그 확인

```bash
docker logs -f --tail 100 dart-worker
```
