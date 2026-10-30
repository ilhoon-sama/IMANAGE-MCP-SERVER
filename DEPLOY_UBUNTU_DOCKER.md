# Ubuntu Linux + Docker Engine 기반 멀티 MCP 운영 구축 가이드

본 문서는 **Ubuntu Linux LTS 서버 + Docker Engine (`docker compose`)** 환경에서 `iManage MCP 서버` 및 향후 추가될 여러 사내 MCP 서버를 **단일 SSL(`https://`) 게이트웨이(Nginx)** 아래에서 안정적으로 통합 운영하는 절차서입니다.

---

## 1. 구성 파일 목록

프로젝트 루트에 아래 Docker 운영용 파일들이 준비되어 있습니다.

| 파일 경로 | 설명 |
| :--- | :--- |
| `Dockerfile` | `node:20-alpine` 기반 경량 컨테이너 빌드 정의 (`/health` 자동 헬스체크 포함) |
| `.dockerignore` | 불필요한 로컬 파일(`node_modules`, `downloads` 등) 이미지 포함 제외 |
| `docker-compose.yml` | `imanage-mcp` 컨테이너 + `nginx-ssl-proxy` 컨테이너 통합 실행 설정 |
| `docker/nginx/default.conf` | HTTPS(443) 인증서 적용 및 MCP SSE 스트리밍(`proxy_buffering off`) 리버스 프록시 설정 |
| `docker/certs/` | SSL 인증서(`fullchain.pem`, `privkey.pem`)를 넣어두는 폴더 |

---

## 2. Ubuntu 서버에 Docker Engine 설치 (최초 1회)

Ubuntu 서버(22.04 LTS 또는 24.04 LTS 권장)에 접속한 뒤 아래 명령어로 공식 Docker Engine과 Compose 플러그인을 설치합니다.

```bash
# 1. 공식 Docker 설치 스크립트 실행
curl -fsSL https://get.docker.com | sudo sh

# 2. 현재 계정에 docker 실행 권한 부여 (재로그인 후 적용)
sudo usermod -aG docker $USER

# 3. 서버 재부팅 시 Docker 데몬 자동 시작 활성화
sudo systemctl enable --now docker
```

---

## 3. 사내 SSL 인증서(`.pfx`)를 Nginx용(`pem`)으로 변환

Windows IIS에서 사용하던 사내 인증서(`*.shinkim.com.pfx`)가 있다면, Ubuntu 서버에 기본 내장된 `openssl` 명령어 2줄로 Nginx용 인증서 파일 2개(`fullchain.pem`, `privkey.pem`)로 바로 변환할 수 있습니다.

```bash
# 프로젝트 폴더 내 인증서 디렉터리 생성
mkdir -p ./docker/certs

# 1) .pfx 파일에서 인증서 체인(fullchain.pem) 추출
openssl pkcs12 -in shinkim_wildcard.pfx -clcerts -nokeys -out ./docker/certs/fullchain.pem
openssl pkcs12 -in shinkim_wildcard.pfx -cacerts -nokeys -chain >> ./docker/certs/fullchain.pem

# 2) .pfx 파일에서 암호 없는 개인키(privkey.pem) 추출
openssl pkcs12 -in shinkim_wildcard.pfx -nocerts -nodes -out ./docker/certs/privkey.pem

# 권한 보호
chmod 600 ./docker/certs/privkey.pem
```

> **참고**: 만약 아직 정식 인증서가 없어서 내부 테스트용 자체 서명(Self-Signed) 인증서를 임시로 만들려면 아래 한 줄만 실행하면 됩니다:
> ```bash
> mkdir -p ./docker/certs && openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
>   -keyout ./docker/certs/privkey.pem -out ./docker/certs/fullchain.pem \
>   -subj "/CN=imanage-mcp.shinkim.com"
> ```

---

## 4. `.env` 파일 확인 및 주의사항

Ubuntu 서버로 코드를 옮길 때, 기존 Windows PC에서 암호화된 `.env`의 `enc:...` 값은 Windows PC의 고유 키로 암호화된 상태이므로, **Ubuntu 서버의 `.env`에는 최초 1회 평문 시크릿/비밀번호를 입력**해 주세요. 컨테이너가 최초 기동되면서 `./data/.imanage-mcp-secret.key`를 자동 생성하고 `.env` 파일 안의 평문을 다시 `enc:...` 암호문으로 자동 변환합니다.

```env
IMANAGE_URL_PREFIX=https://dm.shinkim.com
IMANAGE_AUTH_URL_PREFIX=https://dm.shinkim.com/auth
IMANAGE_CLIENT_ID=MCP-SERVER
IMANAGE_CLIENT_SECRET=실제_클라이언트_시크릿_평문_입력
IMANAGE_USERNAME=factagora
IMANAGE_PASSWORD=실제_비밀번호_평문_입력
MCP_HTTP_PORT=3001
MCP_SECRET_TOKEN=imanage-mcp-secret-token
MCP_PUBLIC_BASE_URL=https://imanage-mcp.shinkim.com
ALLOW_ENV_DEFAULT_USER=false
```

---

## 5. 컨테이너 빌드 및 실행 (`docker compose`)

```bash
# 1. 컨테이너 이미지 빌드 및 백그라운드 실행
docker compose up -d --build

# 2. 실행 상태 및 헬스체크 확인
docker compose ps

# 3. 실시간 로그 확인
docker compose logs -f imanage-mcp

# 4. 로컬 상태 체크
curl -k https://localhost/health
```

- `restart: always`가 설정되어 있어, **Ubuntu 서버가 재부팅되더라도 원격 로그인 없이 부팅 즉시 모든 MCP 컨테이너가 자동으로 켜집니다.**

---

## 6. 향후 두 번째, 세 번째 MCP 서버를 추가하는 방법

새로운 MCP 서버(예: `LPS-DB-MCP-SERVER`)를 개발하셨다면:
1. [`docker-compose.yml`](./docker-compose.yml) 하단의 `lps-db-mcp` 주석을 해제하여 서비스를 추가합니다.
2. [`docker/nginx/default.conf`](./docker/nginx/default.conf) 하단의 `server` 블록 주석을 해제하여 서브도메인(예: `lps-mcp.shinkim.com`) 또는 하위 경로(`/lps/`)로 연결합니다.
3. 아래 명령어를 실행하면 기존 `iManage MCP`는 중단 없이 유지되면서 신규 MCP만 추가로 기동됩니다:
   ```bash
   docker compose up -d --build
   ```

