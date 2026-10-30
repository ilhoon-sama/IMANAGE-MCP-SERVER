import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import http from "http";
import crypto from "crypto";
import { z } from "zod";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { APIS } from "./apis.js";
import {
  resolveAndProtectEnvSecret,
  encryptSecret,
  decryptSecret,
} from "./crypto-helper.js";
import {
  requestContextStorage,
  SUPPORTED_LIBRARIES,
  DEFAULT_LIBRARY,
  loginWithPassword,
  loginWithToken,
  logoutUser,
  resolveUserAuthContext,
  fetchDiscovery,
  executeImanageApi,
  downloadAndProcessDocument,
  getWebLoginUrl,
  getSsoAuthorizeUrl,
} from "./imanage-client.js";

// 현재 파일 위치 기준으로 .env 로드
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.join(__dirname, ".env");
dotenv.config({ path: envPath });

// .env에 평문 시크릿/비밀번호가 입력되어 있으면 즉시 AES-256-GCM 암호문(enc:...)으로 교체하고 메모리에서만 복호화
process.env.IMANAGE_CLIENT_SECRET_RESOLVED = resolveAndProtectEnvSecret(
  envPath,
  "IMANAGE_CLIENT_SECRET"
);
process.env.IMANAGE_PASSWORD_RESOLVED = resolveAndProtectEnvSecret(
  envPath,
  "IMANAGE_PASSWORD"
);

// OAuth2 Authorization Code 임시 저장소 (ChatGPT / Gemini Enterprise / Google Data Store OAuth 연동용)
const oauthCodeStore = new Map();

/**
 * Google Data Store / Gemini Enterprise / ChatGPT OAuth 2.0 연동용 암호화 사용자 토큰 발급 및 복호화
 */
function createMcpOAuthToken(userId, prefix = "mcp_usr_") {
  const payload = JSON.stringify({
    userId: String(userId).trim(),
    iat: Date.now(),
  });
  const encrypted = encryptSecret(payload);
  return `${prefix}${Buffer.from(encrypted, "utf8").toString("base64url")}`;
}

function parseMcpOAuthToken(token, prefix = "mcp_usr_") {
  if (!token || !token.startsWith(prefix)) return null;
  try {
    const encoded = token.slice(prefix.length);
    const encrypted = Buffer.from(encoded, "base64url").toString("utf8");
    const decrypted = decryptSecret(encrypted);
    const parsed = JSON.parse(decrypted);
    return parsed?.userId ? String(parsed.userId).trim() : null;
  } catch {
    return null;
  }
}

/**
 * apis.js의 파라미터 설정을 Zod 스키마로 변환
 * (모든 도구에 사용자 권한 분리용 authUserId 파라미터를 자동 추가)
 */
function buildZodSchema(paramsConfig = {}) {
  const shape = {
    authUserId: z
      .string()
      .optional()
      .describe(
        "요청하는 사용자의 iManage 사번/ID (사용자별 문서 권한 분리를 위해 사용. 비워두면 기본 세션 사용)"
      ),
  };

  for (const [key, cfg] of Object.entries(paramsConfig)) {
    let field;
    switch (cfg.type) {
      case "number":
        field = z.number();
        break;
      case "boolean":
        field = z.boolean();
        break;
      case "string":
      default:
        field = z.string();
        break;
    }

    if (cfg.description) {
      field = field.describe(cfg.description);
    }

    if (!cfg.required) {
      field = field.optional();
    }

    shape[key] = field;
  }
  return shape;
}

/**
 * MCP 서버 인스턴스 생성 및 도구(Tools) 등록
 */
function createMcpServer() {
  const server = new McpServer({
    name: "imanage-onprem-mcp",
    version: "1.0.0",
  });

  // ==========================================================================
  // 1. 사용자 인증 및 연결 진단 도구 (보안: 사용자 ID별 권한 분리)
  // ==========================================================================
  server.tool(
    "imanage_login",
    "사용자 개인의 iManage 계정(userId)으로 로그인합니다. 사내 SSO(통합인증) 계정이라 OAuth 비밀번호 로그인이 비활성화된 경우에도 iManage 사용자 디렉토리에서 실제 사번 및 소속 그룹을 검증하여 개인별 문서 권한(ACL) 적용 세션을 활성화합니다.",
    {
      userId: z
        .string()
        .describe("로그인할 사용자의 iManage ID / 사번 (예: ihjung)"),
      password: z
        .string()
        .optional()
        .describe(
          "iManage 비밀번호 (사내 SSO 계정인 경우 비워두어도 사번 검증을 통해 개인 권한 세션이 활성화됩니다)"
        ),
      xAuthToken: z
        .string()
        .optional()
        .describe(
          "브라우저에서 발급받은 iManage X-Auth-Token (선택사항: 직접 토큰으로 로그인할 때 입력)"
        ),
    },
    async ({ userId, password, xAuthToken }) => {
      try {
        const loginUrl = getWebLoginUrl(userId);
        const ssoUrl = getSsoAuthorizeUrl(userId);

        let sessionInfo;
        if (xAuthToken && xAuthToken.trim()) {
          sessionInfo = await loginWithToken(xAuthToken.trim(), userId);
        } else {
          sessionInfo = await loginWithPassword(userId, password || "", {
            allowServiceAccountFallback: true,
          });
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "LOGGED_IN",
                  message: `사용자 '${sessionInfo.userId}' 계정의 iManage 인증이 완료되었습니다. 이제 본인 권한(ACL) 범위 내의 문서와 사건(Workspace)을 안전하게 조회할 수 있습니다.`,
                  session: sessionInfo,
                  webPortalUrl: loginUrl,
                  ssoLoginUrl: ssoUrl,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const loginUrl = getWebLoginUrl(userId);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `iManage 로그인 오류: ${error.message}\n- 웹 로그인 포털: ${loginUrl}`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    "imanage_logout",
    "특정 사용자(userId)의 iManage 로그인 세션을 서버 메모리에서 즉시 삭제(로그아웃)합니다.",
    {
      userId: z.string().describe("로그아웃할 사용자의 iManage ID / 사번"),
    },
    async ({ userId }) => {
      const removed = logoutUser(userId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: removed ? "LOGGED_OUT" : "NO_ACTIVE_SESSION",
                userId,
                message: removed
                  ? `사용자 '${userId}'의 iManage 세션이 안전하게 종료되었습니다.`
                  : `사용자 '${userId}'의 활성 세션이 없습니다.`,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "test_imanage_connection",
    "iManage Work Server V2 연결 상태, 현재 인증된 사용자 정보(userId, customerId), 그리고 사내 라이브러리 목록(MATTER/PRECEDENT/SERVICE/TRAINING/PRIVATE)을 확인합니다.",
    {
      authUserId: z
        .string()
        .optional()
        .describe("연결 및 세션을 확인할 사용자 iManage ID"),
    },
    async ({ authUserId }) => {
      try {
        const auth = await resolveUserAuthContext(authUserId);
        const discovery = await fetchDiscovery(auth.accessToken);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "CONNECTED",
                  actingUser: {
                    userId: auth.userId,
                    customerId: auth.customerId,
                    authMode: auth.authMode,
                    authSource: auth.authSource,
                    userProfile:
                      auth.authMode === "service_account_acl" &&
                      auth.userProfile &&
                      Object.keys(auth.userProfile).length > 0
                        ? auth.userProfile
                        : discovery.userProfile,
                  },
                  libraries: {
                    defaultLibrary: DEFAULT_LIBRARY,
                    supportedLibraries: SUPPORTED_LIBRARIES,
                  },
                  serverVersions: discovery.versions,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `iManage 연결 확인 실패: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  // ==========================================================================
  // 2. 문서 다운로드 + AI용 텍스트 추출 + 지정 폴더 저장 + iManage 링크 제공 통합 도구
  // ==========================================================================
  server.tool(
    "download_and_extract_document",
    "iManage에서 특정 문서(documentId)를 다운로드하여 (1) 지정된 폴더에 원본 파일을 저장하고, (2) AI가 내용을 읽고 요약·분석할 수 있도록 본문 텍스트(PDF, DOCX, HWPX, XLSX, PPTX, TXT 등)를 자동 추출하며, (3) iManage 웹 바로가기 링크 및 다운로드 링크를 함께 반환합니다. 사용자의 권한(ACL)에 따라 열람 가능한 문서만 다운로드됩니다.",
    {
      authUserId: z
        .string()
        .optional()
        .describe("요청하는 사용자의 iManage 사번/ID"),
      libraryName: z
        .string()
        .optional()
        .describe(
          "라이브러리명 (MATTER / PRECEDENT / SERVICE / TRAINING / PRIVATE, 기본값: MATTER)"
        ),
      documentId: z
        .string()
        .describe("다운로드 및 텍스트를 추출할 문서 ID (예: 'MATTER!12345.1')"),
      saveToDisk: z
        .boolean()
        .optional()
        .describe("서버의 지정된 다운로드 폴더에 파일로 저장할지 여부 (기본값: true)"),
      customDownloadDir: z
        .string()
        .optional()
        .describe(
          "파일을 저장할 지정 폴더 경로 (생략 시 .env의 IMANAGE_DOWNLOAD_DIR 사용)"
        ),
      extractText: z
        .boolean()
        .optional()
        .describe("AI가 문서를 분석할 수 있도록 본문 텍스트를 추출할지 여부 (기본값: true)"),
      maxTextLength: z
        .number()
        .optional()
        .describe("추출할 최대 텍스트 글자 수 (기본값: 30000)"),
    },
    async ({
      authUserId,
      libraryName,
      documentId,
      saveToDisk,
      customDownloadDir,
      extractText,
      maxTextLength,
    }) => {
      try {
        const result = await downloadAndProcessDocument({
          authUserId,
          libraryName: libraryName || DEFAULT_LIBRARY,
          documentId,
          saveToDisk: saveToDisk !== false,
          customDownloadDir: customDownloadDir || undefined,
          extractText: extractText !== false,
          maxTextLength: maxTextLength || 30000,
        });

        const { buffer, ...responsePayload } = result;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(responsePayload, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `[download_and_extract_document] 오류: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  // ==========================================================================
  // 3. apis.js에 정의된 iManage V2 API 자동 등록 (READ 기본 활성화, WRITE는 옵션)
  // ==========================================================================
  const allowWrite = process.env.ALLOW_WRITE === "true";

  for (const apiDef of APIS) {
    if (apiDef.type !== "read" && !allowWrite) continue;

    const zodSchema = buildZodSchema(apiDef.params);

    server.tool(
      apiDef.name,
      `[${apiDef.type.toUpperCase()}] ${apiDef.description}`,
      zodSchema,
      async (args) => {
        try {
          const pathParams = {};
          const queryParams = {};
          const bodyParams = {};

          for (const [paramName, paramCfg] of Object.entries(
            apiDef.params || {}
          )) {
            const rawVal = args?.[paramName];
            const finalVal =
              rawVal !== undefined && rawVal !== null && rawVal !== ""
                ? rawVal
                : paramCfg.default !== undefined
                ? paramCfg.default
                : undefined;

            if (finalVal === undefined) continue;

            if (paramCfg.in === "path") {
              pathParams[paramName] = finalVal;
            } else if (paramCfg.in === "query") {
              queryParams[paramName] = finalVal;
            } else if (paramCfg.in === "body") {
              bodyParams[paramName] = finalVal;
            }
          }

          // documentId나 workspaceId, folderId에 "PRECEDENT!123.1"처럼 라이브러리 접두사가 포함된 경우
          // 사용자가 libraryName을 생략했더라도 ID에서 라이브러리를 자동 추론하여 편의성 향상
          const anyEntityId =
            pathParams.documentId ||
            pathParams.workspaceId ||
            pathParams.folderId ||
            "";
          if (
            typeof anyEntityId === "string" &&
            anyEntityId.includes("!") &&
            (!args?.libraryName || args.libraryName === DEFAULT_LIBRARY)
          ) {
            const inferredLib = anyEntityId.split("!")[0].toUpperCase();
            if (SUPPORTED_LIBRARIES.includes(inferredLib)) {
              pathParams.libraryName = inferredLib;
            }
          }

          const response = await executeImanageApi({
            method: apiDef.method,
            pathTemplate: apiDef.path,
            pathParams,
            queryParams,
            body:
              Object.keys(bodyParams).length > 0 ? bodyParams : undefined,
            authUserId: args?.authUserId,
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(response, null, 2),
              },
            ],
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `[${apiDef.name}] 실행 오류: ${error.message}`,
              },
            ],
          };
        }
      }
    );
  }

  return server;
}

/**
 * HTTP Body(URL-encoded 또는 JSON) 읽기 헬퍼
 */
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * HTML 특수문자 이스케이프 (XSS 방지)
 */
function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 웹 브라우저 기반 iManage 개인 로그인 페이지 렌더링 (/auth/login)
 */
function renderLoginHtml({
  userId = "",
  errorMsg = "",
  successInfo = null,
  oauthParams = null,
}) {
  const ssoQuery = new URLSearchParams();
  if (userId) ssoQuery.set("userId", userId);
  if (oauthParams?.redirect_uri) {
    ssoQuery.set("redirect_uri", oauthParams.redirect_uri);
  }
  if (oauthParams?.state) {
    ssoQuery.set("state", oauthParams.state);
  }
  const ssoHref = `/auth/sso${ssoQuery.toString() ? `?${ssoQuery.toString()}` : ""}`;
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>iManage MCP 개인 계정 인증</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Malgun Gothic", sans-serif; background: #f4f6f9; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
    .card { background: #fff; padding: 32px; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.08); width: 100%; max-width: 440px; }
    h2 { margin-top: 0; color: #1a202c; font-size: 20px; }
    p.desc { color: #4a5568; font-size: 13.5px; line-height: 1.5; margin-bottom: 20px; }
    label { display: block; font-size: 13px; font-weight: 600; color: #2d3748; margin-bottom: 6px; }
    .hint { font-size: 12px; color: #718096; font-weight: 400; }
    input[type="text"], input[type="password"] { width: 100%; padding: 10px 12px; margin-bottom: 16px; border: 1px solid #cbd5e0; border-radius: 6px; box-sizing: border-box; font-size: 14px; }
    button { width: 100%; padding: 12px; background: #2563eb; color: white; border: none; border-radius: 6px; font-size: 15px; font-weight: 600; cursor: pointer; margin-bottom: 10px; }
    button:hover { background: #1d4ed8; }
    .btn-sso { display: block; text-align: center; text-decoration: none; width: 100%; padding: 11px; background: #f8fafc; color: #1e293b; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 13.5px; font-weight: 600; box-sizing: border-box; margin-top: 6px; }
    .btn-sso:hover { background: #e2e8f0; }
    .alert-err { background: #fef2f2; color: #b91c1c; padding: 12px; border-radius: 6px; font-size: 13px; margin-bottom: 16px; border: 1px solid #fecaca; white-space: pre-wrap; }
    .alert-ok { background: #f0fdf4; color: #15803d; padding: 16px; border-radius: 6px; font-size: 14px; line-height: 1.6; border: 1px solid #bbf7d0; }
    .badge { display: inline-block; background: #e0e7ff; color: #1e40af; padding: 2px 8px; border-radius: 4px; font-size: 12px; margin-right: 4px; margin-top: 4px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>🔒 iManage On-Prem 개인 계정 인증</h2>
    <p class="desc">
      iManage 문서는 사용자 ID별로 접근 권한(ACL)이 다릅니다.<br/>
      본인의 iManage 사번(ID)으로 인증하면 본인 권한 범위 내의 문서와 사건만 안전하게 조회됩니다.
    </p>
    ${errorMsg ? `<div class="alert-err">${escapeHtml(errorMsg)}</div>` : ""}
    ${
      successInfo
        ? `<div class="alert-ok">
            <strong>✅ 인증 완료!</strong><br/>
            사용자 ID: <b>${escapeHtml(successInfo.userId)}</b> (Customer ID: ${escapeHtml(successInfo.customerId)})<br/>
            인증 모드: ${escapeHtml(successInfo.authMode || "personal_oauth")}<br/>
            만료 시각: ${escapeHtml(successInfo.expiresAt)}<br/><br/>
            사용 가능 라이브러리:<br/>
            ${SUPPORTED_LIBRARIES.map((lib) => `<span class="badge">${escapeHtml(lib)}</span>`).join("")}
            <br/><br/>
            이제 이 창을 닫고 <b>MCP Inspector / Gemini Enterprise / ChatGPT</b> 화면으로 돌아가서 작업을 계속 진행해 주세요.
          </div>`
        : `<form method="POST" action="${oauthParams ? "/oauth2/authorize" : "/auth/login"}">
            ${
              oauthParams
                ? `<input type="hidden" name="redirect_uri" value="${escapeHtml(oauthParams.redirect_uri)}" />
                   <input type="hidden" name="state" value="${escapeHtml(oauthParams.state)}" />
                   <input type="hidden" name="client_id" value="${escapeHtml(oauthParams.client_id)}" />`
                : ""
            }
            <label for="userId">iManage 사용자 ID (사번)</label>
            <input type="text" id="userId" name="userId" value="${escapeHtml(userId)}" required autofocus placeholder="예: ihjung" />
            <label for="password">iManage 비밀번호 <span class="hint">(사내 SSO 통합인증 계정은 비워두셔도 됩니다)</span></label>
            <input type="password" id="password" name="password" placeholder="SSO 계정은 입력 생략 가능" />
            <label for="xAuthToken">또는 X-Auth-Token 직접 입력 <span class="hint">(선택사항)</span></label>
            <input type="text" id="xAuthToken" name="xAuthToken" placeholder="브라우저 X-Auth-Token이 있는 경우 입력" />
            <button type="submit">iManage 개인 권한 인증 시작</button>
            <a class="btn-sso" href="${escapeHtml(ssoHref)}">🌐 사내 iManage SSO(웹 통합인증) 화면으로 이동</a>
          </form>`
    }
  </div>
</body>
</html>`;
}

/**
 * HTTP 서버 생성 및 실행 (중앙 서버 모드 및 stdio 보조 웹 포털/다운로드 서버 겸용)
 */
function startHttpServer({ isPrimaryHttpMode = false } = {}) {
  const port = parseInt(process.env.MCP_HTTP_PORT || "3001", 10);
  const secretToken = (process.env.MCP_SECRET_TOKEN || "").trim();
  const expectedPath = secretToken ? `/mcp/${secretToken}` : "/mcp";

  const httpServer = http.createServer(async (req, res) => {
    const startMs = Date.now();
    const forwardedHost = (
      req.headers["x-forwarded-host"] ||
      req.headers["x-original-host"] ||
      req.headers.host ||
      `localhost:${port}`
    )
      .toString()
      .split(",")[0]
      .trim();
    const forwardedProto = (
      req.headers["x-forwarded-proto"] ||
      (forwardedHost.includes(".devtunnels.ms") ? "https" : "http")
    )
      .toString()
      .split(",")[0]
      .trim();
    const mcpBaseUrl = `${forwardedProto}://${forwardedHost}`;
    const url = new URL(req.url || "/", mcpBaseUrl);
    const normalizedPath =
      url.pathname.replace(/\/+/g, "/").replace(/\/$/, "") || "/";

    // CORS 헤더 지원 (ChatGPT / Gemini Enterprise / VS Code Dev Tunnels / 브라우저 클라이언트 호환)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, DELETE, OPTIONS"
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Accept, Authorization, X-Auth-Token, X-iManage-Token, X-User-Id, mcp-session-id, X-Tunnel-Skip-AntiPhishing-Page"
    );

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (isPrimaryHttpMode) {
      res.on("finish", () => {
        console.error(
          `[HTTP] ${req.method} ${normalizedPath} -> ${res.statusCode} (${
            Date.now() - startMs
          }ms)`
        );
      });
    }

    // ----------------------------------------------------------------------
    // 1. 상태 확인 엔드포인트 (/health)
    // ----------------------------------------------------------------------
    if (normalizedPath === "/health") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          status: "ok",
          server: "imanage-onprem-mcp",
          defaultLibrary: DEFAULT_LIBRARY,
          supportedLibraries: SUPPORTED_LIBRARIES,
        })
      );
      return;
    }

    // ----------------------------------------------------------------------
    // 2. 개인별 웹 로그인 포털 (/auth/login) - 채팅창에 비밀번호 입력 없이 로그인
    // ----------------------------------------------------------------------
    if (normalizedPath === "/auth/login") {
      if (req.method === "GET") {
        const initialUserId = url.searchParams.get("userId") || "";
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderLoginHtml({ userId: initialUserId }));
        return;
      }
      if (req.method === "POST") {
        let inputUserId = "";
        try {
          const rawBody = await readRequestBody(req);
          const params = new URLSearchParams(rawBody);
          inputUserId = (params.get("userId") || "").trim();
          const password = params.get("password") || "";
          const xAuthToken = (params.get("xAuthToken") || "").trim();

          let sessionInfo;
          if (xAuthToken) {
            sessionInfo = await loginWithToken(xAuthToken, inputUserId);
          } else {
            sessionInfo = await loginWithPassword(inputUserId, password, {
              allowServiceAccountFallback: true,
            });
          }

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            renderLoginHtml({ userId: inputUserId, successInfo: sessionInfo })
          );
        } catch (err) {
          res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            renderLoginHtml({
              userId: inputUserId,
              errorMsg: err.message,
            })
          );
        }
        return;
      }
    }

    // ----------------------------------------------------------------------
    // 2-B. 사내 iManage SSO 브라우저 통합인증 리다이렉트 (/auth/sso & /auth/sso/callback)
    // ----------------------------------------------------------------------
    if (normalizedPath === "/auth/sso" && req.method === "GET") {
      const hintUserId = url.searchParams.get("userId") || "";
      const googleRedirectUri = url.searchParams.get("redirect_uri") || "";
      const googleState = url.searchParams.get("state") || "";
      const basePrefix = (process.env.IMANAGE_URL_PREFIX || "").replace(
        /\/+$/,
        ""
      );
      const authUrlPrefix = (
        process.env.IMANAGE_AUTH_URL_PREFIX || `${basePrefix}/auth`
      ).replace(/\/+$/, "");
      const clientId = (process.env.IMANAGE_CLIENT_ID || "").trim();
      const callbackUri = `${mcpBaseUrl}/auth/sso/callback`;

      let ssoStateKey = hintUserId;
      if (googleRedirectUri) {
        ssoStateKey = `sso_${crypto.randomBytes(16).toString("hex")}`;
        oauthCodeStore.set(ssoStateKey, {
          hintUserId,
          googleRedirectUri,
          googleState,
          expiresAt: Date.now() + 10 * 60 * 1000,
        });
      }

      const targetAuthUrl = new URL(`${authUrlPrefix}/oauth2/authorize`);
      targetAuthUrl.searchParams.set("response_type", "code");
      targetAuthUrl.searchParams.set("client_id", clientId);
      targetAuthUrl.searchParams.set("redirect_uri", callbackUri);
      if (ssoStateKey) {
        targetAuthUrl.searchParams.set("state", ssoStateKey);
      }

      res.writeHead(302, { Location: targetAuthUrl.toString() });
      res.end();
      return;
    }

    if (normalizedPath === "/auth/sso/callback" && req.method === "GET") {
      const code = url.searchParams.get("code") || "";
      const rawState = url.searchParams.get("state") || "";
      const ssoSession = rawState.startsWith("sso_")
        ? oauthCodeStore.get(rawState)
        : null;
      if (ssoSession) {
        oauthCodeStore.delete(rawState);
      }
      const stateUserId = ssoSession ? ssoSession.hintUserId : rawState;

      try {
        if (!code) {
          throw new Error("iManage SSO 인증 코드(code)가 전달되지 않았습니다.");
        }
        const basePrefix = (process.env.IMANAGE_URL_PREFIX || "").replace(
          /\/+$/,
          ""
        );
        const authUrlPrefix = (
          process.env.IMANAGE_AUTH_URL_PREFIX || `${basePrefix}/auth`
        ).replace(/\/+$/, "");
        const callbackUri = `${mcpBaseUrl}/auth/sso/callback`;

        const formData = new URLSearchParams();
        formData.append("grant_type", "authorization_code");
        formData.append("code", code);
        formData.append("client_id", (process.env.IMANAGE_CLIENT_ID || "").trim());
        formData.append(
          "client_secret",
          process.env.IMANAGE_CLIENT_SECRET_RESOLVED || ""
        );
        formData.append("redirect_uri", callbackUri);

        const tokenRes = await fetch(`${authUrlPrefix}/oauth2/token`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: formData.toString(),
        });
        const tokenJson = await tokenRes.json();
        if (!tokenRes.ok || !tokenJson.access_token) {
          throw new Error(
            tokenJson.error_description ||
              tokenJson.error?.message ||
              `SSO 토큰 교환 실패 (HTTP ${tokenRes.status})`
          );
        }

        const sessionInfo = await loginWithToken(
          tokenJson.access_token,
          stateUserId
        );

        // Google Data Store OAuth 2.0 흐름에서 SSO를 호출한 경우 Google의 redirect_uri로 즉시 복귀
        if (ssoSession?.googleRedirectUri) {
          const oauthCode = crypto.randomBytes(24).toString("hex");
          oauthCodeStore.set(oauthCode, {
            userId: sessionInfo.userId,
            expiresAt: Date.now() + 5 * 60 * 1000,
          });
          const redirectUrl = new URL(ssoSession.googleRedirectUri);
          redirectUrl.searchParams.set("code", oauthCode);
          if (ssoSession.googleState) {
            redirectUrl.searchParams.set("state", ssoSession.googleState);
          }
          res.writeHead(302, { Location: redirectUrl.toString() });
          res.end();
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          renderLoginHtml({
            userId: sessionInfo.userId,
            successInfo: sessionInfo,
          })
        );
      } catch (err) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          renderLoginHtml({
            userId: stateUserId,
            errorMsg: `SSO 연동 오류: ${err.message}`,
          })
        );
      }
      return;
    }

    // ----------------------------------------------------------------------
    // 3. OAuth 2.0 연동 엔드포인트 (/oauth2/authorize, /oauth2/token)
    //    ChatGPT Custom GPT / Gemini Enterprise에서 OAuth 방식으로 사용자별 로그인 시 지원
    // ----------------------------------------------------------------------
    if (normalizedPath === "/oauth2/authorize") {
      if (req.method === "GET") {
        const oauthParams = {
          redirect_uri: url.searchParams.get("redirect_uri") || "",
          state: url.searchParams.get("state") || "",
          client_id: url.searchParams.get("client_id") || "",
        };
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderLoginHtml({ oauthParams }));
        return;
      }
      if (req.method === "POST") {
        let oauthParams = {};
        try {
          const rawBody = await readRequestBody(req);
          const params = new URLSearchParams(rawBody);
          const userId = (params.get("userId") || "").trim();
          const password = params.get("password") || "";
          const xAuthToken = (params.get("xAuthToken") || "").trim();
          const redirectUri = params.get("redirect_uri") || "";
          const state = params.get("state") || "";
          const clientId = params.get("client_id") || "";
          oauthParams = {
            redirect_uri: redirectUri,
            state,
            client_id: clientId,
          };

          let sessionInfo;
          if (xAuthToken) {
            sessionInfo = await loginWithToken(xAuthToken, userId);
          } else {
            sessionInfo = await loginWithPassword(userId, password, {
              allowServiceAccountFallback: true,
            });
          }
          const resolvedUserId = sessionInfo?.userId || userId;
          const code = crypto.randomBytes(24).toString("hex");
          oauthCodeStore.set(code, {
            userId: resolvedUserId,
            expiresAt: Date.now() + 5 * 60 * 1000,
          });

          const redirectUrl = new URL(redirectUri);
          redirectUrl.searchParams.set("code", code);
          if (state) redirectUrl.searchParams.set("state", state);

          res.writeHead(302, { Location: redirectUrl.toString() });
          res.end();
        } catch (err) {
          res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderLoginHtml({ oauthParams, errorMsg: err.message }));
        }
        return;
      }
    }

    if (normalizedPath === "/oauth2/token" && req.method === "POST") {
      try {
        const rawBody = await readRequestBody(req);
        const params = new URLSearchParams(rawBody);
        const grantType = params.get("grant_type") || "password";
        const ttlSec =
          Math.max(
            parseFloat(process.env.IMANAGE_SESSION_TTL_HOURS || "12"),
            1
          ) * 3600;

        if (grantType === "authorization_code") {
          const code = params.get("code") || "";
          const stored = oauthCodeStore.get(code);
          oauthCodeStore.delete(code);
          if (!stored || stored.expiresAt < Date.now()) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: "invalid_grant",
                error_description:
                  "Authorization code is invalid or has expired.",
              })
            );
            return;
          }

          const accessToken = createMcpOAuthToken(stored.userId, "mcp_usr_");
          const refreshToken = createMcpOAuthToken(stored.userId, "mcp_rt_");

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              access_token: accessToken,
              token_type: "Bearer",
              expires_in: Math.floor(ttlSec),
              refresh_token: refreshToken,
              user_id: stored.userId,
            })
          );
          return;
        }

        if (grantType === "refresh_token") {
          const incomingRefresh = params.get("refresh_token") || "";
          const refreshedUserId = parseMcpOAuthToken(
            incomingRefresh,
            "mcp_rt_"
          );
          if (refreshedUserId) {
            await loginWithPassword(refreshedUserId, "", {
              allowServiceAccountFallback: true,
            });
            const accessToken = createMcpOAuthToken(
              refreshedUserId,
              "mcp_usr_"
            );
            const refreshToken = createMcpOAuthToken(
              refreshedUserId,
              "mcp_rt_"
            );
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                access_token: accessToken,
                token_type: "Bearer",
                expires_in: Math.floor(ttlSec),
                refresh_token: refreshToken,
                user_id: refreshedUserId,
              })
            );
            return;
          }
        }

        // 일반 password grant 요청 시에도 SSO 폴백 포함한 사용자 토큰 발급 지원
        const reqUsername = (params.get("username") || "").trim();
        const reqPassword = params.get("password") || "";
        if (reqUsername) {
          const sessionInfo = await loginWithPassword(
            reqUsername,
            reqPassword,
            { allowServiceAccountFallback: true }
          );
          const resolvedUserId = sessionInfo?.userId || reqUsername;
          const accessToken = createMcpOAuthToken(resolvedUserId, "mcp_usr_");
          const refreshToken = createMcpOAuthToken(resolvedUserId, "mcp_rt_");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              access_token: accessToken,
              token_type: "Bearer",
              expires_in: Math.floor(ttlSec),
              refresh_token: refreshToken,
              user_id: resolvedUserId,
            })
          );
          return;
        }

        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "invalid_request",
            error_description: "Unsupported grant_type or missing credentials.",
          })
        );
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: "server_error", message: err.message })
        );
      }
      return;
    }

    // ----------------------------------------------------------------------
    // 4. 문서 직접 다운로드 엔드포인트 (/download/:library/:documentId)
    // ----------------------------------------------------------------------
    const downloadMatch = normalizedPath.match(
      /^\/download\/([^/]+)\/([^/]+)$/
    );
    if (downloadMatch && req.method === "GET") {
      const libraryName = decodeURIComponent(downloadMatch[1]);
      const documentId = decodeURIComponent(downloadMatch[2]);
      const queryUserId =
        url.searchParams.get("userId") || req.headers["x-user-id"] || "";
      const headerImanageToken =
        req.headers["x-auth-token"] || req.headers["x-imanage-token"] || "";

      await requestContextStorage.run(
        {
          isHttpMode: true,
          mcpBaseUrl,
          headerUserId: queryUserId,
          headerImanageToken,
        },
        async () => {
          try {
            const dlResult = await downloadAndProcessDocument({
              libraryName,
              documentId,
              saveToDisk: true,
              extractText: false,
              authUserId: queryUserId,
            });

            res.writeHead(200, {
              "Content-Type":
                dlResult.document.contentType || "application/octet-stream",
              "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(
                dlResult.document.fileName
              )}`,
              "Content-Length": dlResult.buffer.length,
            });
            res.end(dlResult.buffer);
          } catch (err) {
            if (err.code === "AUTH_REQUIRED" && err.loginUrl) {
              res.writeHead(302, { Location: err.loginUrl });
              res.end();
              return;
            }
            res.writeHead(403, {
              "Content-Type": "text/plain; charset=utf-8",
            });
            res.end(`다운로드 오류: ${err.message}`);
          }
        }
      );
      return;
    }

    // ----------------------------------------------------------------------
    // 5. MCP Streamable HTTP 엔드포인트 (/mcp 또는 /mcp/:secret 또는 /mcp/:secret/user/:userId)
    // ----------------------------------------------------------------------
    const authHeader = req.headers["authorization"] || "";
    const bearerToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : "";

    // 경로 패턴 매칭: /mcp, /mcp/<secret>, /mcp/<secret>/user/<userId>, /mcp/user/<userId>
    let isAuthorizedMcp = false;
    let pathUserId = "";

    if (secretToken) {
      if (normalizedPath === expectedPath) {
        isAuthorizedMcp = true;
      } else if (normalizedPath.startsWith(`${expectedPath}/user/`)) {
        isAuthorizedMcp = true;
        pathUserId = decodeURIComponent(
          normalizedPath.slice(`${expectedPath}/user/`.length)
        );
      } else if (normalizedPath === "/mcp" && bearerToken === secretToken) {
        isAuthorizedMcp = true;
      } else if (
        normalizedPath === "/mcp" &&
        bearerToken &&
        bearerToken !== secretToken
      ) {
        // OAuth2를 통해 발급된 사용자 개인 iManage Bearer 토큰으로 접근하는 경우 허용
        isAuthorizedMcp = true;
      }
    } else {
      if (normalizedPath === "/mcp") {
        isAuthorizedMcp = true;
      } else if (normalizedPath.startsWith("/mcp/user/")) {
        isAuthorizedMcp = true;
        pathUserId = decodeURIComponent(
          normalizedPath.slice("/mcp/user/".length)
        );
      }
    }

    if (isAuthorizedMcp) {
      // 클라우드 커넥터(Gemini Enterprise / ChatGPT 등)가 Accept 헤더에 text/event-stream을 누락하더라도 406 오류가 나지 않도록 보정
      if (req.method === "POST") {
        const accept = req.headers["accept"] || "";
        if (
          !accept.includes("application/json") ||
          !accept.includes("text/event-stream")
        ) {
          req.headers["accept"] = "application/json, text/event-stream";
        }
      }

      // OAuth2 Bearer 토큰이 mcp_usr_ 형식인 경우 암호화된 사용자 ID 복호화
      const oauthBearerUserId = parseMcpOAuthToken(bearerToken, "mcp_usr_");

      // 사용자별 토큰 및 ID 추출 (헤더 / 경로 / OAuth Bearer / 쿼리스트링)
      const headerImanageToken =
        req.headers["x-auth-token"] ||
        req.headers["x-imanage-token"] ||
        (bearerToken &&
        bearerToken !== secretToken &&
        !oauthBearerUserId
          ? bearerToken
          : "");
      const headerUserId =
        pathUserId ||
        oauthBearerUserId ||
        req.headers["x-user-id"] ||
        req.headers["x-imanage-user"] ||
        url.searchParams.get("userId") ||
        "";

      // 웹 브라우저 주소창에서 직접 GET 접속한 경우(Accept: text/html),
      // JSON-RPC 406 에러 대신 해당 사용자 ID가 자동 입력된 iManage 로그인/상태 확인 포털 화면을 표시
      const acceptHeader = (req.headers["accept"] || "").toLowerCase();
      if (
        req.method === "GET" &&
        acceptHeader.includes("text/html") &&
        !acceptHeader.includes("text/event-stream")
      ) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderLoginHtml({ userId: String(headerUserId).trim() }));
        return;
      }

      await requestContextStorage.run(
        {
          isHttpMode: true,
          mcpBaseUrl,
          headerImanageToken: String(headerImanageToken).trim(),
          headerUserId: String(headerUserId).trim(),
        },
        async () => {
          const mcpServer = createMcpServer();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
          });
          res.on("close", () => {
            transport.close();
            mcpServer.close();
          });
          await mcpServer.connect(transport);
          await transport.handleRequest(req, res);
        }
      );
    } else {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden: Invalid or missing MCP secret token.");
    }
  });

  httpServer.on("error", (err) => {
    if (err.code === "EADDRINUSE" && !isPrimaryHttpMode) {
      // stdio 모드(예: MCP Inspector)에서 이미 3001 포트가 열려 있으면 충돌 없이 기존 포트 사용
      return;
    }
    console.error(`[HTTP Server Error] ${err.message}`);
  });

  // 듀얼 스택(:: + 0.0.0.0) 바인딩으로 Windows localhost(::1) 21초 폴백 지연 방지
  httpServer.listen(port, () => {
    if (isPrimaryHttpMode) {
      console.error(`==========================================================`);
      console.error(`iManage On-Prem MCP Server (Streamable HTTP) 시작됨!`);
      console.error(`- MCP 엔드포인트 : http://localhost:${port}${expectedPath}`);
      console.error(`- 사용자별 URL   : http://localhost:${port}${expectedPath}/user/{사번}`);
      console.error(`- 웹 로그인 포털 : http://localhost:${port}/auth/login`);
      console.error(`- 지원 라이브러리: ${SUPPORTED_LIBRARIES.join(", ")} (기본: ${DEFAULT_LIBRARY})`);
      console.error(`==========================================================`);
    } else {
      console.error(
        `[Helper Web Portal] http://localhost:${port}/auth/login 활성화됨`
      );
    }
  });

  if (!isPrimaryHttpMode) {
    httpServer.unref();
  }

  return httpServer;
}

// ============================================================================
// 서버 시작 (기본: stdio + 보조 웹 포털 동시 실행 / --http 옵션 시: 중앙 HTTP 서버 모드)
// ============================================================================
async function main() {
  const isHttpMode = process.argv.includes("--http");

  if (isHttpMode) {
    startHttpServer({ isPrimaryHttpMode: true });
  } else {
    // stdio 모드(MCP Inspector 등)에서도 http://localhost:3001/auth/login 및 /download 링크가 즉시 작동하도록 보조 웹 서버를 함께 기동
    startHttpServer({ isPrimaryHttpMode: false });

    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("iManage On-Prem MCP Server running on stdio");
  }
}

main().catch((err) => {
  console.error("Fatal error starting iManage MCP server:", err);
  process.exit(1);
});

