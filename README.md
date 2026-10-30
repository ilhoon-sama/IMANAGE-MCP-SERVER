# iManage On-Premise Work Server V2 MCP 서버

이전에 구축한 MS SQL MCP 서버와 동일한 구조(`server.js` + `apis.js` + `crypto-helper.js`)로 설계된 **iManage On-Premise Work V2 REST API 전용 중앙 운영형 MCP 서버**입니다.

---

## ✨ 주요 특징

1. **사용자 ID별 문서 권한(ACL) 완벽 분리 (공용 관리자 계정 미사용)**
   - iManage는 사용자 ID(사번)별로 열람/다운로드 가능한 사건(Workspace)과 문서 권한이 다릅니다.
   - 사내 SSO(통합인증) 계정(예: `ihjung`)의 경우에도 iManage 사용자 디렉토리(`/users/{id}`) 및 소속 그룹(`/users/{id}/groups`)을 실시간 검증하여 **사용자 개인별 ACL 보안 세션(`service_account_acl`)** 으로 동작합니다.
   - 권한 없는 비공개(`private`) 문서나 타인의 `PRIVATE` 라이브러리 문서는 검색 결과에서 자동 제외되며 다운로드가 차단(`403`)됩니다.
2. **문서 본문 추출 + iManage 바로가기 링크 + 지정 폴더 다운로드 (`download_and_extract_document`)**
   - **AI 본문 텍스트 자동 추출**: `PDF`, `DOCX`, `HWPX`, `XLSX`, `PPTX`, `TXT`, `CSV`, `MD`, `HTML` 등의 문서에서 텍스트를 추출하여 AI가 즉시 요약·검토·비교할 수 있습니다.
   - **iManage 링크 자동 제공**: 모든 문서/워크스페이스/폴더 조회 결과에 `_links`가 자동으로 포함됩니다:
     - `imanage_web_url`: iManage Work 10 웹에서 문서 바로 열기 (`https://dm.shinkim.com/work/web/r/libraries/...`)
     - `imanage_preview_url`: iManage 웹 미리보기 화면 열기
     - `imanage_nrl_uri`: 데스크톱 iManage Work (`iwl:dms=...`) 바로 실행
     - `mcp_download_url`: 브라우저 원클릭 파일 다운로드 링크
   - **지정 폴더 다운로드**: `.env`의 `IMANAGE_DOWNLOAD_DIR` 하위 사용자별 폴더(`downloads/{사번}/`)에 원본 파일을 안전하게 저장합니다.
3. **사내 5대 라이브러리 기본 탑재**
   - `MATTER` (기본값), `PRECEDENT`, `SERVICE`, `TRAINING`, `PRIVATE` 라이브러리를 모두 지원하며, 문서 ID(`PRECEDENT!1234.1` 등)에 라이브러리가 포함된 경우 자동으로 라이브러리를 인식합니다.

---

## 🌐 Google Data Store (Gemini Enterprise / Vertex AI Agent Builder) 등록 정리

Google Cloud의 **Gemini Enterprise (구 Agentspace) / Vertex AI Agent Builder > Data Stores (데이터 스토어) > Custom MCP Server**에 등록할 때 필요한 설정값 정리입니다.

### 1단계: 서버를 외부 접속 가능한 HTTPS 주소로 기동

1. **HTTP 중앙 서버 모드로 실행**:
   ```powershell
   npm run start:http
   ```
   *(또는 Docker 상시 운영 시: `docker compose up -d --build`)*
2. **외부 HTTPS 터널 또는 사내 리버스 프록시 연결**:
   - Google Cloud에서 사내 MCP 서버(포트 `3001`)로 접근할 수 있도록 Cloudflare Tunnel, ngrok, 또는 사내 방화벽/리버스 프록시 도메인을 연결합니다.
   - 예시:
     ```powershell
     ngrok http 3001
     # 또는
     cloudflared tunnel --url http://localhost:3001
     ```
   - 발급된 외부 HTTPS 주소(예: `https://imanage-mcp.yourcompany.com`)를 `.env`의 `MCP_PUBLIC_BASE_URL`에도 반영하면 웹 로그인/다운로드 링크가 해당 도메인으로 자동 생성됩니다.

---

### 2단계: Google Data Store 등록 입력값 (2가지 인증 방식 모두 지원)

Google Cloud Console > **Agent Builder (또는 Gemini Enterprise)** > **Data Stores** > **Create Data Store** > **Custom MCP Server** 선택 후 아래 값들을 입력합니다.

#### 방법 A. URL 토큰 방식 (가장 간편한 등록 방식 - 별도 OAuth 설정 불필요)
URL 경로 자체에 보안 토큰(`MCP_SECRET_TOKEN`)을 포함하여 즉시 연결하는 방식입니다.

| 항목 (Google Data Store 설정란) | 입력할 값 | 비고 |
| :--- | :--- | :--- |
| **Data Store Name (표시 이름)** | `iManage On-Prem 문서관리` | 자유 입력 |
| **Connector Type** | `Custom MCP Server (Streamable HTTP)` | 원격 MCP 서버 |
| **MCP Server URL (Endpoint)** | `https://<외부도메인>/mcp/imanage-mcp-secret-token` | `.env`의 `MCP_SECRET_TOKEN` 포함 |
| **Authentication (인증 방식)** | `None` (또는 `Bearer Token` 선택 시 `imanage-mcp-secret-token`) | URL에 토큰이 포함되어 있어 바로 인증됨 |

* **사용자 권한 동작 방식**:
  * 사용자가 Gemini 채팅창에서 *"내 사번은 ihjung이야, 최근 문서 찾아줘"* 라고 말하거나 `imanage_login` 도구가 호출되면, 즉시 `ihjung` 사번 및 그룹 권한(ACL)으로 세션이 생성되어 권한 있는 문서만 조회됩니다.
  * 특정 사용자 전용 데이터 스토어로 고정 등록할 경우 URL 끝에 `/user/<사번>`을 붙일 수도 있습니다:
    `https://<외부도메인>/mcp/imanage-mcp-secret-token/user/ihjung`

---

#### 방법 B. OAuth 2.0 사용자별 로그인 연동 방식 (엔터프라이즈 표준)
Google Data Store에서 각 임직원에게 최초 1회 로그인 팝업을 띄우고, 이후 모든 도구 호출 시 해당 사용자의 사번 권한 토큰(`Bearer mcp_usr_...`)을 자동으로 전달하는 방식입니다.

| 항목 (Google Data Store 설정란) | 입력할 값 | 비고 |
| :--- | :--- | :--- |
| **Data Store Name (표시 이름)** | `iManage On-Prem 문서관리` | 자유 입력 |
| **MCP Server URL (Endpoint)** | `https://<외부도메인>/mcp` | 표준 `/mcp` 엔드포인트 |
| **Authentication Type** | `OAuth 2.0 (Authorization Code)` | 사용자별 OAuth 2.0 |
| **Authorization URL** | `https://<외부도메인>/oauth2/authorize` | 브라우저 사번/SSO 로그인 화면 |
| **Token URL** | `https://<외부도메인>/oauth2/token` | 암호화된 사용자 Bearer 토큰 자동 발급 |
| **Client ID** | `factagora-access` | `.env`의 `IMANAGE_CLIENT_ID` |
| **Client Secret** | `imanage-mcp-secret-token` | 임의 값 또는 `.env`의 시크릿 |
| **Scopes (범위)** | `read` (또는 비워둠) | 선택사항 |

* **사용자 권한 동작 방식**:
  * 사용자가 Gemini에서 최초 질문 시 Google이 `https://<외부도메인>/oauth2/authorize` 팝업을 엽니다.
  * 사용자는 팝업에서 **본인 사번(예: `ihjung`)만 입력하고 버튼 클릭** (사내 SSO 계정은 비밀번호 생략 가능)하면 인증이 완료됩니다.
  * 이후 채팅창에서 사번을 말하지 않아도 Google Data Store가 자동으로 해당 사용자의 암호화 토큰을 헤더에 실어 보내므로 **100% 본인 권한(ACL)으로 자동 조회**됩니다.

---

### 3단계: 출처 링크 매핑 (Citation Mappings - 선택사항)

Google Data Store 설정에서 응답 내 문서 출처 링크(Citation) 필드를 지정할 경우 아래 필드를 매핑할 수 있습니다:
- **Title 필드**: `name`
- **URL / URI 필드**: `web_url` (또는 `_links.imanage_web_url`)
- **ID 필드**: `id`

---

### 4단계: AI 에이전트 시스템 프롬프트 (Agent Instructions) 권장 문구

Gemini Enterprise 에이전트 설정의 **Instructions (지시사항)** 에 아래 내용을 복사해 넣어두시면 AI가 도구를 훨씬 정확하게 사용합니다:

```text
1. 사내 iManage 문서를 검색할 때는 기본적으로 'MATTER' 라이브러리를 사용하며, 판례/양식은 'PRECEDENT', 서비스는 'SERVICE', 교육자료는 'TRAINING', 개인문서는 'PRIVATE' 라이브러리를 지정하세요.
2. 사용자의 사번(authUserId)이 확인되지 않아 인증 안내가 반환되면, 사용자에게 사번(예: ihjung)을 물어보거나 안내된 웹 로그인 링크를 안내하세요.
3. 문서나 사건(Workspace) 조회 결과를 답변할 때는 응답의 '_links.imanage_web_url' (iManage 웹 열기 링크)과 '_links.mcp_download_url' (다운로드 링크)을 마크다운 링크로 함께 제공하세요.
4. 사용자가 특정 문서의 내용을 요약·분석·검토해 달라고 요청하면 'download_and_extract_document' 도구를 호출하여 추출된 본문 텍스트(extractedText)를 바탕으로 답변하세요.
```
