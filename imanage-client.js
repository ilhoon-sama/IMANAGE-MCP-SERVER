import { AsyncLocalStorage } from "async_hooks";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import https from "https";
import { encryptSecret, decryptSecret } from "./crypto-helper.js";

// HTTP 요청별 컨텍스트 격리 (동시 접속하는 여러 사용자의 토큰/ID가 절대 섞이지 않도록 보장)
export const requestContextStorage = new AsyncLocalStorage();

// 사내 iManage 라이브러리 목록 및 기본값
export const SUPPORTED_LIBRARIES = (
  process.env.IMANAGE_LIBRARIES || "MATTER,PRECEDENT,SERVICE,TRAINING,PRIVATE"
)
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

export const DEFAULT_LIBRARY = (
  process.env.IMANAGE_DEFAULT_LIBRARY || "MATTER"
).trim().toUpperCase();

// 사용자별 세션 저장소: Map<normalizedUserId, SessionRecord>
// SessionRecord 내 accessToken, refreshToken은 메모리에서도 AES-256-GCM 암호화 상태로 보관
const userSessions = new Map();

// Access Token 역방향 인덱스 (OAuth Bearer 토큰으로 바로 호출 시 캐싱용)
const tokenDiscoveryCache = new Map();

// 문서/워크스페이스 ACL(Security) 조회 캐시 (5분 TTL)
const itemSecurityCache = new Map();

// 서비스 계정(.env) 내부 세션 캐시
let serviceAccountSession = null;

/**
 * 사내 On-Premise 자체 서명 인증서(Self-Signed SSL) 허용 설정
 */
if (process.env.IMANAGE_REJECT_UNAUTHORIZED === "false") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

function getImanageConfig() {
  const urlPrefix = (process.env.IMANAGE_URL_PREFIX || "").replace(/\/+$/, "");
  // iManage On-Premise에서는 보통 urlPrefix가 https://host 이고, authUrlPrefix는 https://host/auth 입니다.
  // IMANAGE_AUTH_URL_PREFIX가 비어 있으면 기본적으로 `${urlPrefix}/auth`를 우선 사용합니다.
  const rawAuthPrefix = (process.env.IMANAGE_AUTH_URL_PREFIX || "").replace(
    /\/+$/,
    ""
  );
  const authUrlPrefix = rawAuthPrefix || `${urlPrefix}/auth`;
  return {
    urlPrefix,
    authUrlPrefix,
    clientId: (process.env.IMANAGE_CLIENT_ID || "").trim(),
    clientSecret: process.env.IMANAGE_CLIENT_SECRET_RESOLVED || "",
    defaultCustomerId: (process.env.IMANAGE_CUSTOMER_ID || "").trim(),
    sessionTtlMs:
      parseInt(process.env.IMANAGE_SESSION_TTL_HOURS || "12", 10) *
      60 *
      60 *
      1000,
  };
}

/**
 * OAuth2 토큰 엔드포인트 호출 헬퍼 (/auth/oauth2/token 우선 시도 후 실패 시 /oauth2/token 폴백)
 */
async function postOAuthToken(formData) {
  const cfg = getImanageConfig();
  const candidates = [
    `${cfg.authUrlPrefix}/oauth2/token`,
    `${cfg.urlPrefix}/auth/oauth2/token`,
    `${cfg.urlPrefix}/oauth2/token`,
  ];
  // 중복 제거
  const uniqueUrls = [...new Set(candidates)];

  let lastResponse = null;
  let lastRawText = "";

  for (const tokenUrl of uniqueUrls) {
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: formData.toString(),
    });
    const rawText = await response.text();
    lastResponse = response;
    lastRawText = rawText;

    // Method not allowed(405)나 URL 오류인 경우에만 다음 후보 URL 시도
    if (
      response.status !== 404 &&
      response.status !== 405 &&
      !rawText.includes("The method is not allowed")
    ) {
      return { response, rawText, tokenUrl };
    }
  }

  return { response: lastResponse, rawText: lastRawText, tokenUrl: uniqueUrls[0] };
}

/**
 * 사용자 ID 정규화
 */
export function normalizeUserId(userId) {
  return String(userId || "").trim().toLowerCase();
}

/**
 * 현재 요청의 MCP 서버 외부 접속 URL 반환 (웹 로그인 링크 및 다운로드 링크 생성용)
 * VS Code Port Forwarding(*.devtunnels.ms) 등 외부 터널로 접속 시 자동으로 터널의 HTTPS 도메인을 우선 사용합니다.
 */
export function getMcpPublicBaseUrl() {
  const ctx = requestContextStorage.getStore();
  const envBase = (process.env.MCP_PUBLIC_BASE_URL || "")
    .trim()
    .replace(/\/+$/, "");

  // 요청 컨텍스트에 실제 외부 도메인(예: *.devtunnels.ms)이 들어온 경우 localhost 설정보다 우선 적용
  if (
    ctx?.mcpBaseUrl &&
    (!envBase ||
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(envBase))
  ) {
    return ctx.mcpBaseUrl.replace(/\/+$/, "");
  }
  if (envBase) {
    return envBase;
  }
  if (ctx?.mcpBaseUrl) {
    return ctx.mcpBaseUrl.replace(/\/+$/, "");
  }
  const port = process.env.MCP_HTTP_PORT || "3001";
  return `http://localhost:${port}`;
}

/**
 * 사용자 웹 로그인 URL 생성 (채팅창에 비밀번호를 입력하지 않고 브라우저에서 안전하게 로그인)
 */
export function getWebLoginUrl(userId = "") {
  const base = getMcpPublicBaseUrl();
  const query = userId ? `?userId=${encodeURIComponent(userId)}` : "";
  return `${base}/auth/login${query}`;
}

/**
 * iManage SSO OAuth2 Authorization URL 생성 (브라우저 통합인증 리다이렉트용)
 */
export function getSsoAuthorizeUrl(userId = "") {
  const base = getMcpPublicBaseUrl();
  const query = userId ? `?userId=${encodeURIComponent(userId)}` : "";
  return `${base}/auth/sso${query}`;
}

/**
 * 내부 헬퍼: 단일 username으로 OAuth2 Password Grant 요청
 */
async function requestPasswordGrantToken(username, password) {
  const cfg = getImanageConfig();
  const formData = new URLSearchParams();
  formData.append("username", username.trim());
  formData.append("password", password);
  formData.append("grant_type", "password");
  formData.append("client_id", cfg.clientId);
  formData.append("client_secret", cfg.clientSecret);

  const { response, rawText } = await postOAuthToken(formData);
  let tokenData = {};
  try {
    tokenData = JSON.parse(rawText);
  } catch {
    throw new Error(
      `iManage OAuth2 응답 파싱 실패 (HTTP ${response.status}): ${rawText.slice(0, 300)}`
    );
  }

  return { response, rawText, tokenData };
}

/**
 * 내부 헬퍼: .env에 설정된 API 연동 서비스 계정(예: factagora) 토큰 획득 및 자동 갱신
 */
async function getServiceAccountSession() {
  const envUser = (process.env.IMANAGE_USERNAME || "").trim();
  const envPass = process.env.IMANAGE_PASSWORD_RESOLVED || "";
  if (!envUser || !envPass) {
    throw new Error(
      ".env 파일에 API 연동 서비스 계정(IMANAGE_USERNAME / IMANAGE_PASSWORD)이 설정되어 있지 않습니다."
    );
  }

  if (serviceAccountSession && Date.now() < serviceAccountSession.expiresAt) {
    return {
      accessToken: decryptSecret(serviceAccountSession.encryptedAccessToken),
      customerId: serviceAccountSession.customerId,
      serviceUserId: serviceAccountSession.userId,
    };
  }

  const { response, rawText, tokenData } = await requestPasswordGrantToken(
    envUser,
    envPass
  );
  if (!response.ok || !tokenData.access_token) {
    throw new Error(
      `API 서비스 계정(${envUser}) 인증 실패 (HTTP ${response.status}): ${rawText.slice(0, 200)}`
    );
  }

  const discovery = await fetchDiscovery(tokenData.access_token);
  const expiresInSec = parseInt(tokenData.expires_in || "3600", 10);

  serviceAccountSession = {
    userId: discovery.userId || envUser,
    customerId: discovery.customerId || "1",
    encryptedAccessToken: encryptSecret(tokenData.access_token),
    encryptedRefreshToken: tokenData.refresh_token
      ? encryptSecret(tokenData.refresh_token)
      : "",
    expiresAt: Date.now() + Math.max(expiresInSec - 60, 60) * 1000,
  };

  return {
    accessToken: tokenData.access_token,
    customerId: serviceAccountSession.customerId,
    serviceUserId: serviceAccountSession.userId,
  };
}

/**
 * iManage 서버에서 특정 사용자(targetUserId, 예: ihjung)의 실제 존재 여부, 프로필, 소속 그룹(ACL Group Trustees)을 조회/검증합니다.
 */
export async function verifyImanageUserAndGroups(targetUserId) {
  const cfg = getImanageConfig();
  const svc = await getServiceAccountSession();
  const cleanId = targetUserId.trim().replace(/^.*\\/, "").replace(/@.*$/, "");
  const normalizedTarget = normalizeUserId(cleanId);

  let matchedUser = null;

  // 1차 시도: /users/{userId} 단건 프로필 직접 조회
  try {
    const directUrl = `${cfg.urlPrefix}/api/v2/customers/${encodeURIComponent(
      svc.customerId
    )}/libraries/${encodeURIComponent(DEFAULT_LIBRARY)}/users/${encodeURIComponent(
      cleanId
    )}`;
    const directRes = await fetch(directUrl, {
      method: "GET",
      headers: {
        "X-Auth-Token": svc.accessToken,
        Accept: "application/json",
      },
    });
    if (directRes.ok) {
      const directJson = await directRes.json();
      const userObj = directJson.data || directJson;
      if (userObj && (userObj.id || userObj.user_id)) {
        matchedUser = userObj;
      }
    }
  } catch {
    // 단건 조회 미지원 시 목록 검색으로 폴백
  }

  // 2차 시도: /users?query={userId} 검색
  if (!matchedUser) {
    const searchUrls = [
      `${cfg.urlPrefix}/api/v2/customers/${encodeURIComponent(
        svc.customerId
      )}/libraries/${encodeURIComponent(
        DEFAULT_LIBRARY
      )}/users?query=${encodeURIComponent(cleanId)}&limit=50`,
      `${cfg.urlPrefix}/api/v2/customers/${encodeURIComponent(
        svc.customerId
      )}/libraries/${encodeURIComponent(
        DEFAULT_LIBRARY
      )}/users?id=${encodeURIComponent(cleanId)}&limit=50`,
    ];

    for (const sUrl of searchUrls) {
      try {
        const sRes = await fetch(sUrl, {
          method: "GET",
          headers: {
            "X-Auth-Token": svc.accessToken,
            Accept: "application/json",
          },
        });
        if (!sRes.ok) continue;
        const sJson = await sRes.json();
        const list = Array.isArray(sJson.data)
          ? sJson.data
          : Array.isArray(sJson.data?.results)
          ? sJson.data.results
          : [];
        const exact = list.find((u) => {
          const uid = normalizeUserId(u.id || u.user_id || u.username);
          const emailPrefix = normalizeUserId((u.email || "").split("@")[0]);
          return uid === normalizedTarget || emailPrefix === normalizedTarget;
        });
        if (exact) {
          matchedUser = exact;
          break;
        }
      } catch {
        // 무시 후 다음 URL 시도
      }
    }
  }

  if (!matchedUser) {
    throw new Error(
      `iManage 사용자 목록에서 사번/ID '${targetUserId}'를 찾을 수 없습니다. 정확한 사번(ID)인지 확인해 주세요.`
    );
  }

  if (matchedUser.allow_logon === false) {
    throw new Error(
      `사용자 '${targetUserId}' 계정은 현재 iManage 로그인이 비활성화(allow_logon=false)된 상태입니다.`
    );
  }

  const verifiedUserId = matchedUser.id || matchedUser.user_id || cleanId;

  // 3차: 사용자의 소속 그룹(Group Trustees) 목록 조회 (문서/워크스페이스 ACL 검증에 사용)
  const userGroups = new Set();
  if (Array.isArray(matchedUser.groups)) {
    for (const g of matchedUser.groups) {
      const gid = g.id || g.group_id || g.name || g;
      if (gid) userGroups.add(normalizeUserId(gid));
    }
  }

  try {
    const groupsUrl = `${cfg.urlPrefix}/api/v2/customers/${encodeURIComponent(
      svc.customerId
    )}/libraries/${encodeURIComponent(
      DEFAULT_LIBRARY
    )}/users/${encodeURIComponent(verifiedUserId)}/groups`;
    const gRes = await fetch(groupsUrl, {
      method: "GET",
      headers: {
        "X-Auth-Token": svc.accessToken,
        Accept: "application/json",
      },
    });
    if (gRes.ok) {
      const gJson = await gRes.json();
      const gList = Array.isArray(gJson.data)
        ? gJson.data
        : Array.isArray(gJson.data?.results)
        ? gJson.data.results
        : [];
      for (const g of gList) {
        const gid = g.id || g.group_id || g.name;
        if (gid) userGroups.add(normalizeUserId(gid));
      }
    }
  } catch {
    // 그룹 엔드포인트 미지원 시 기본 프로필 그룹만 사용
  }

  return {
    verifiedUserId,
    customerId: String(matchedUser.customer_id ?? svc.customerId ?? "1"),
    userProfile: matchedUser,
    userGroups: [...userGroups],
    serviceAccessToken: svc.accessToken,
  };
}

/**
 * 1-A. X-Auth-Token 직접 입력으로 개인 세션 로그인 (브라우저/SSO 토큰 연동용)
 */
export async function loginWithToken(xAuthToken, hintUserId = "") {
  const cfg = getImanageConfig();
  const cleanToken = (xAuthToken || "").trim();
  if (!cleanToken) {
    throw new Error("유효한 iManage X-Auth-Token 값을 입력해 주세요.");
  }

  const discovery = await fetchDiscovery(cleanToken);
  const verifiedUserId = discovery.userId || hintUserId.trim() || "token_user";
  const normalizedInputId = normalizeUserId(hintUserId || verifiedUserId);
  const normalizedVerifiedId = normalizeUserId(verifiedUserId);

  const sessionRecord = {
    userId: verifiedUserId,
    loginId: hintUserId.trim() || verifiedUserId,
    authMode: "personal_token",
    encryptedAccessToken: encryptSecret(cleanToken),
    encryptedRefreshToken: "",
    customerId: discovery.customerId || cfg.defaultCustomerId || "1",
    userProfile: discovery.userProfile || {},
    userGroups: [],
    libraries: discovery.libraries || SUPPORTED_LIBRARIES,
    expiresAt: Date.now() + cfg.sessionTtlMs,
    sessionExpiresAt: Date.now() + cfg.sessionTtlMs,
    lastUsedAt: Date.now(),
  };

  userSessions.set(normalizedInputId, sessionRecord);
  if (normalizedVerifiedId && normalizedVerifiedId !== normalizedInputId) {
    userSessions.set(normalizedVerifiedId, sessionRecord);
  }

  return {
    userId: sessionRecord.userId,
    loginId: sessionRecord.loginId,
    authMode: sessionRecord.authMode,
    customerId: sessionRecord.customerId,
    libraries: SUPPORTED_LIBRARIES,
    defaultLibrary: DEFAULT_LIBRARY,
    userProfile: sessionRecord.userProfile,
    expiresAt: new Date(sessionRecord.expiresAt).toISOString(),
  };
}

/**
 * 1-B. 사내 SSO 사용자용 서비스 계정 기반 개인 권한(ACL) 검증 세션 활성화
 *      - 사내 임직원 계정(예: ihjung)이 SSO(통합인증) 전용이라 OAuth2 password grant가 차단된 경우,
 *        iManage 사용자 디렉토리에서 실제 사용자(ihjung)와 소속 그룹을 검증한 뒤,
 *        해당 사용자의 ACL(권한) 범위 내 문서만 열람·다운로드하도록 보안 격리 세션을 생성합니다.
 */
export async function loginWithServiceAccountAcl(targetUserId) {
  const cfg = getImanageConfig();
  const verified = await verifyImanageUserAndGroups(targetUserId);

  const normalizedInputId = normalizeUserId(targetUserId);
  const normalizedVerifiedId = normalizeUserId(verified.verifiedUserId);

  const sessionRecord = {
    userId: verified.verifiedUserId,
    loginId: targetUserId.trim(),
    authMode: "service_account_acl",
    encryptedAccessToken: encryptSecret(verified.serviceAccessToken),
    encryptedRefreshToken: "",
    customerId: verified.customerId || cfg.defaultCustomerId || "1",
    userProfile: verified.userProfile || {},
    userGroups: verified.userGroups || [],
    libraries: SUPPORTED_LIBRARIES,
    expiresAt: Date.now() + 50 * 60 * 1000,
    sessionExpiresAt: Date.now() + cfg.sessionTtlMs,
    lastUsedAt: Date.now(),
  };

  userSessions.set(normalizedInputId, sessionRecord);
  if (normalizedVerifiedId && normalizedVerifiedId !== normalizedInputId) {
    userSessions.set(normalizedVerifiedId, sessionRecord);
  }

  return {
    userId: sessionRecord.userId,
    loginId: sessionRecord.loginId,
    authMode: "service_account_acl (사내 SSO 계정 확인 및 사용자별 문서 ACL 보안 적용)",
    customerId: sessionRecord.customerId,
    libraries: SUPPORTED_LIBRARIES,
    defaultLibrary: DEFAULT_LIBRARY,
    userProfile: sessionRecord.userProfile,
    userGroupsCount: sessionRecord.userGroups.length,
    expiresAt: new Date(sessionRecord.sessionExpiresAt).toISOString(),
  };
}

/**
 * 1-C. 통합 로그인 함수 (OAuth2 Password Grant 우선 시도 -> SSO 계정인 경우 사용자 디렉토리 검증 + ACL 보안 모드로 자동 전환)
 */
export async function loginWithPassword(
  username,
  password = "",
  { allowServiceAccountFallback = true } = {}
) {
  const cfg = getImanageConfig();
  if (!cfg.authUrlPrefix) {
    throw new Error(
      ".env 파일에 IMANAGE_URL_PREFIX (또는 IMANAGE_AUTH_URL_PREFIX)가 설정되지 않았습니다."
    );
  }
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error(
      ".env 파일에 IMANAGE_CLIENT_ID 및 IMANAGE_CLIENT_SECRET이 설정되지 않았습니다."
    );
  }

  const cleanUsername = (username || "").trim();
  if (!cleanUsername) {
    throw new Error("로그인할 사용자의 iManage 사번/ID(userId)를 입력해 주세요.");
  }

  // 비밀번호가 생략되었고 서비스 계정 ACL 모드가 허용된 경우 -> 즉시 iManage 사용자 검증 및 ACL 세션 생성
  if (!password && allowServiceAccountFallback) {
    return await loginWithServiceAccountAcl(cleanUsername);
  }

  // OAuth2 Password Grant 시도 (기본 ID, AD 도메인, 이메일 형식 순차 시도)
  const baseId = cleanUsername.replace(/^.*\\/, "").replace(/@.*$/, "");
  const candidateUsernames = [
    ...new Set([
      cleanUsername,
      `shinkim\\${baseId}`,
      `SHINKIM\\${baseId}`,
      `${baseId}@shinkim.com`,
    ]),
  ];

  let lastResponse = null;
  let lastTokenData = {};
  let lastRawText = "";
  let succeededTokenData = null;

  for (const candidateUser of candidateUsernames) {
    const { response, rawText, tokenData } = await requestPasswordGrantToken(
      candidateUser,
      password
    );
    lastResponse = response;
    lastRawText = rawText;
    lastTokenData = tokenData;

    if (response.ok && tokenData.access_token) {
      succeededTokenData = tokenData;
      break;
    }
  }

  // OAuth2 직접 로그인이 401(SSO 전용 계정 등)로 실패했을 때,
  // 사내 API 서비스 계정(.env)이 설정되어 있으면 실제 iManage 사용자 여부를 검증하여 개인별 ACL 보안 세션으로 연결
  if (!succeededTokenData) {
    const envUser = (process.env.IMANAGE_USERNAME || "").trim();
    const isCallingServiceUserItself =
      normalizeUserId(cleanUsername) === normalizeUserId(envUser);

    if (allowServiceAccountFallback && envUser && !isCallingServiceUserItself) {
      try {
        return await loginWithServiceAccountAcl(cleanUsername);
      } catch (aclErr) {
        // 사용자 ID 자체가 존재하지 않는 경우 명확한 에러 메시지 반환
        const oauthErrMsg =
          lastTokenData.error_description ||
          lastTokenData.error?.detailed_error_message ||
          lastTokenData.error?.code_description ||
          lastTokenData.error?.message ||
          lastRawText;
        throw new Error(
          `iManage 로그인 실패: (1) OAuth 직접 인증 오류: ${oauthErrMsg} / (2) 사내 사용자 검증 오류: ${aclErr.message}`
        );
      }
    }

    const errMsg =
      lastTokenData.error_description ||
      lastTokenData.error?.detailed_error_message ||
      lastTokenData.error?.code_description ||
      lastTokenData.error?.message ||
      lastRawText;
    throw new Error(
      `iManage 로그인 실패 (HTTP ${lastResponse?.status || 401}): ${errMsg}`
    );
  }

  const accessToken = succeededTokenData.access_token;
  const refreshToken = succeededTokenData.refresh_token || "";
  const expiresInSec = parseInt(succeededTokenData.expires_in || "3600", 10);

  // Discovery API (/api) 호출하여 customerId 및 실제 사용자 정보 획득
  const discovery = await fetchDiscovery(accessToken);

  const verifiedUserId = discovery.userId || cleanUsername;
  const normalizedInputId = normalizeUserId(cleanUsername);
  const normalizedVerifiedId = normalizeUserId(verifiedUserId);

  const sessionRecord = {
    userId: verifiedUserId,
    loginId: cleanUsername,
    authMode: "personal_oauth",
    encryptedAccessToken: encryptSecret(accessToken),
    encryptedRefreshToken: refreshToken ? encryptSecret(refreshToken) : "",
    customerId: discovery.customerId || cfg.defaultCustomerId || "1",
    userProfile: discovery.userProfile || {},
    userGroups: [],
    libraries: discovery.libraries || SUPPORTED_LIBRARIES,
    expiresAt: Date.now() + Math.max(expiresInSec - 60, 60) * 1000,
    sessionExpiresAt: Date.now() + cfg.sessionTtlMs,
    lastUsedAt: Date.now(),
  };

  userSessions.set(normalizedInputId, sessionRecord);
  if (normalizedVerifiedId && normalizedVerifiedId !== normalizedInputId) {
    userSessions.set(normalizedVerifiedId, sessionRecord);
  }

  return {
    userId: sessionRecord.userId,
    loginId: sessionRecord.loginId,
    authMode: sessionRecord.authMode,
    customerId: sessionRecord.customerId,
    libraries: SUPPORTED_LIBRARIES,
    defaultLibrary: DEFAULT_LIBRARY,
    userProfile: sessionRecord.userProfile,
    expiresAt: new Date(sessionRecord.expiresAt).toISOString(),
  };
}

/**
 * 2. Refresh Token 또는 서비스 계정으로 Access Token 자동 갱신 ({{authUrlPrefix}}/oauth2/token)
 */
export async function refreshUserSession(sessionRecord) {
  if (sessionRecord.authMode === "service_account_acl") {
    const svc = await getServiceAccountSession();
    sessionRecord.encryptedAccessToken = encryptSecret(svc.accessToken);
    sessionRecord.expiresAt = Date.now() + 50 * 60 * 1000;
    sessionRecord.lastUsedAt = Date.now();
    return svc.accessToken;
  }

  const cfg = getImanageConfig();
  const refreshToken = decryptSecret(sessionRecord.encryptedRefreshToken);
  if (!refreshToken) {
    throw new Error(
      `사용자(${sessionRecord.userId})의 Refresh Token이 없어 재로그인이 필요합니다.`
    );
  }

  const formData = new URLSearchParams();
  formData.append("grant_type", "refresh_token");
  formData.append("refresh_token", refreshToken);
  formData.append("client_id", cfg.clientId);
  formData.append("client_secret", cfg.clientSecret);

  const { response, rawText } = await postOAuthToken(formData);
  let tokenData;
  try {
    tokenData = JSON.parse(rawText);
  } catch {
    throw new Error(`Refresh Token 응답 파싱 실패 (HTTP ${response.status})`);
  }

  if (!response.ok || !tokenData.access_token) {
    userSessions.delete(normalizeUserId(sessionRecord.userId));
    userSessions.delete(normalizeUserId(sessionRecord.loginId));
    throw new Error(
      `세션 갱신 실패 (HTTP ${response.status}): 다시 로그인해 주세요.`
    );
  }

  const expiresInSec = parseInt(tokenData.expires_in || "3600", 10);
  sessionRecord.encryptedAccessToken = encryptSecret(tokenData.access_token);
  if (tokenData.refresh_token) {
    sessionRecord.encryptedRefreshToken = encryptSecret(tokenData.refresh_token);
  }
  sessionRecord.expiresAt = Date.now() + Math.max(expiresInSec - 60, 60) * 1000;
  sessionRecord.lastUsedAt = Date.now();
  return decryptSecret(sessionRecord.encryptedAccessToken);
}

/**
 * 3. Get Discovery ({{urlPrefix}}/api) 호출
 *    - Postman Collection의 `jsonData.data.user.customer_id` 추출 로직 구현
 */
export async function fetchDiscovery(accessToken) {
  const cfg = getImanageConfig();
  if (!cfg.urlPrefix) {
    throw new Error(".env 파일에 IMANAGE_URL_PREFIX가 설정되지 않았습니다.");
  }

  const cached = tokenDiscoveryCache.get(accessToken);
  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }

  const res = await fetch(`${cfg.urlPrefix}/api`, {
    method: "GET",
    headers: {
      "X-Auth-Token": accessToken,
      Accept: "application/json",
    },
  });

  const rawText = await res.text();
  let jsonData = {};
  try {
    jsonData = JSON.parse(rawText);
  } catch {
    throw new Error(
      `Discovery(/api) 응답 파싱 실패 (HTTP ${res.status}): ${rawText.slice(0, 200)}`
    );
  }

  if (!res.ok) {
    throw new Error(
      `Discovery(/api) 호출 실패 (HTTP ${res.status}): ${
        jsonData.error?.message || rawText.slice(0, 200)
      }`
    );
  }

  const data = jsonData.data || jsonData;
  const userObj = data.user || {};
  const customerId = String(
    userObj.customer_id ??
      data.customer_id ??
      cfg.defaultCustomerId ??
      "1"
  );
  const userId =
    userObj.id ||
    userObj.user_id ||
    userObj.username ||
    data.work?.user?.id ||
    "";

  const discoveryInfo = {
    customerId,
    userId,
    userProfile: userObj,
    versions: data.versions || [],
    workInfo: data.work || {},
    raw: data,
    expiresAt: Date.now() + 10 * 60 * 1000,
  };

  tokenDiscoveryCache.set(accessToken, discoveryInfo);
  return discoveryInfo;
}

/**
 * 로그아웃 (특정 사용자의 메모리 세션 즉시 파기)
 */
export function logoutUser(userId) {
  const key = normalizeUserId(userId);
  const session = userSessions.get(key);
  if (session) {
    userSessions.delete(normalizeUserId(session.userId));
    userSessions.delete(normalizeUserId(session.loginId));
    return true;
  }
  return false;
}

/**
 * 현재 요청에 대한 사용자 인증 세션 해석 (관리자 계정 공용 사용 차단, 사용자별 권한 분리 핵심)
 *
 * 우선순위:
 * 1) HTTP 헤더(X-Auth-Token / X-iManage-Token / OAuth Bearer Token)로 직접 전달된 사용자 토큰
 * 2) 도구 인자(authUserId) 또는 HTTP 헤더(X-User-Id)로 지정된 사용자의 로그인 세션
 *    (만약 세션이 아직 없더라도 사내 API 서비스 계정이 설정되어 있으면 iManage 사용자 디렉토리에서
 *     해당 사번의 실존 여부와 소속 그룹을 즉시 검증하여 개인별 ACL 적용 세션을 자동 구성합니다.)
 * 3) (로컬 단일 사용자 테스트용으로 ALLOW_ENV_DEFAULT_USER=true 설정 시에만) .env 기본 사용자
 */
export async function resolveUserAuthContext(explicitUserId) {
  const ctx = requestContextStorage.getStore() || {};

  // 1. 헤더로 직접 사용자 iManage 토큰이 전달된 경우 (ChatGPT OAuth / Gemini OAuth / SSO 프록시)
  if (ctx.headerImanageToken) {
    const discovery = await fetchDiscovery(ctx.headerImanageToken);
    return {
      accessToken: ctx.headerImanageToken,
      customerId: discovery.customerId,
      userId: discovery.userId || explicitUserId || ctx.headerUserId || "oauth_user",
      userProfile: discovery.userProfile,
      userGroups: [],
      authMode: "personal_token",
      authSource: "header_token",
    };
  }

  // 2. 사용자 ID 식별 (명시적 파라미터 -> HTTP 헤더/경로 userId)
  const targetUserId = (explicitUserId || ctx.headerUserId || "").trim();

  if (targetUserId) {
    const key = normalizeUserId(targetUserId);
    let session = userSessions.get(key);

    // 세션이 없거나 만료된 경우, 사내 서비스 계정이 설정되어 있으면 즉시 iManage 사용자 검증 및 ACL 세션 생성 시도
    if (!session || Date.now() > session.sessionExpiresAt) {
      const envUser = (process.env.IMANAGE_USERNAME || "").trim();
      const envPass = process.env.IMANAGE_PASSWORD_RESOLVED || "";
      if (envUser && envPass) {
        try {
          await loginWithServiceAccountAcl(targetUserId);
          session = userSessions.get(key);
        } catch (verifyErr) {
          const loginUrl = getWebLoginUrl(targetUserId);
          const err = new Error(
            `[사용자 인증 실패] '${targetUserId}' 사번 확인 중 오류: ${verifyErr.message}\n` +
              `- 웹 브라우저 로그인 주소: ${loginUrl}`
          );
          err.code = "AUTH_REQUIRED";
          err.loginUrl = loginUrl;
          throw err;
        }
      }
    }

    if (!session) {
      const loginUrl = getWebLoginUrl(targetUserId);
      const err = new Error(
        `[인증 필요] 사용자 '${targetUserId}'의 활성 iManage 세션이 없습니다.\n` +
          `문서 권한 보안을 위해 개인별 로그인이 필요합니다.\n` +
          `- 방법 1 (권장 - 브라우저 안전 로그인): ${loginUrl} 에 접속하여 로그인하세요.\n` +
          `- 방법 2 (도구 호출): 'imanage_login' 도구를 사용하여 로그인하세요.`
      );
      err.code = "AUTH_REQUIRED";
      err.loginUrl = loginUrl;
      throw err;
    }

    // Access Token 만료 임박 시 Refresh Token 또는 서비스 계정 토큰으로 자동 갱신
    let accessToken = decryptSecret(session.encryptedAccessToken);
    if (Date.now() > session.expiresAt) {
      accessToken = await refreshUserSession(session);
    } else {
      session.lastUsedAt = Date.now();
    }

    return {
      accessToken,
      customerId: session.customerId,
      userId: session.userId,
      loginId: session.loginId,
      userProfile: session.userProfile,
      userGroups: session.userGroups || [],
      authMode: session.authMode || "personal_oauth",
      authSource:
        session.authMode === "service_account_acl"
          ? "user_session_acl_enforced"
          : "user_session",
    };
  }

  // 3. 로컬 단일 PC 모드 또는 명시적으로 ALLOW_ENV_DEFAULT_USER=true 인 경우에만 .env 계정 허용
  const allowEnvDefault =
    process.env.ALLOW_ENV_DEFAULT_USER === "true" || !ctx.isHttpMode;
  const envUser = (process.env.IMANAGE_USERNAME || "").trim();
  const envPass = process.env.IMANAGE_PASSWORD_RESOLVED || "";

  if (allowEnvDefault && envUser && envPass) {
    const existing = userSessions.get(normalizeUserId(envUser));
    if (existing && Date.now() < existing.sessionExpiresAt) {
      let accessToken = decryptSecret(existing.encryptedAccessToken);
      if (Date.now() > existing.expiresAt) {
        accessToken = await refreshUserSession(existing);
      }
      return {
        accessToken,
        customerId: existing.customerId,
        userId: existing.userId,
        loginId: existing.loginId,
        userProfile: existing.userProfile,
        userGroups: existing.userGroups || [],
        authMode: existing.authMode || "personal_oauth",
        authSource: "env_default_user",
      };
    }

    await loginWithPassword(envUser, envPass, {
      allowServiceAccountFallback: false,
    });
    const created = userSessions.get(normalizeUserId(envUser));
    return {
      accessToken: decryptSecret(created.encryptedAccessToken),
      customerId: created.customerId,
      userId: created.userId,
      loginId: created.loginId,
      userProfile: created.userProfile,
      userGroups: created.userGroups || [],
      authMode: created.authMode || "personal_oauth",
      authSource: "env_default_user",
    };
  }

  // 중앙 서버 모드에서 userId도 없고 헤더 토큰도 없는 경우 안내 반환
  const loginUrl = getWebLoginUrl();
  throw new Error(
    `[사용자 ID 확인 필요] iManage는 사용자 ID별로 문서 접근 권한이 다릅니다.\n` +
      `보안을 위해 공용 관리자 계정을 사용하지 않으므로, 본인의 iManage 사번/ID(authUserId)를 알려주시고 로그인을 진행해 주세요.\n` +
      `- 웹 브라우저 로그인 주소: ${loginUrl}\n` +
      `- 또는 'imanage_login' 도구를 호출하세요.`
  );
}

/**
 * [보안 핵심] 서비스 계정 기반 ACL 모드(service_account_acl)에서
 * 특정 문서/워크스페이스/폴더에 대해 요청 사용자(auth.userId)의 열람 권한(ACL)이 있는지 검증합니다.
 */
async function checkItemAclForUser(item, libraryName, auth) {
  if (!item || typeof item !== "object") return true;
  if (auth.authMode !== "service_account_acl") return true;

  const targetUser = normalizeUserId(auth.userId);
  const userGroupSet = new Set(
    (auth.userGroups || []).map((g) => normalizeUserId(g))
  );

  const author = normalizeUserId(item.author || item.user_id || "");
  const operator = normalizeUserId(item.operator || "");
  const owner = normalizeUserId(item.owner || "");
  const isOwnerOrAuthor =
    (author && author === targetUser) ||
    (operator && operator === targetUser) ||
    (owner && owner === targetUser);

  const lib = (
    item.library ||
    item.database ||
    libraryName ||
    DEFAULT_LIBRARY
  )
    .toString()
    .toUpperCase();

  // 1. PRIVATE 라이브러리는 본인(작성자/수정자/소유자)의 문서만 접근 허용
  if (lib === "PRIVATE" && !isOwnerOrAuthor) {
    return false;
  }

  // 2. 본인이 작성자/수정자/소유자인 문서는 항상 접근 허용
  if (isOwnerOrAuthor) {
    return true;
  }

  // 3. 기본 보안 등급(default_security) 확인
  //    public / view 인 경우 사내 열람 허용, private / hidden 인 경우 Trustee(ACL) 상세 확인
  const defSec = String(item.default_security || "public").toLowerCase();
  if (defSec === "public" || defSec === "view" || defSec === "u" || defSec === "v") {
    return true;
  }

  // 4. 비공개(private) 문서/워크스페이스인 경우 /security API로 user_trustees 및 group_trustees 검증
  const itemId =
    item.id || item.document_id || item.workspace_id || item.folder_id;
  if (!itemId) return false;

  const wspType = String(item.wstype || item.type || "").toLowerCase();
  const entitySegment =
    wspType === "workspace" || item.workspace_id === itemId
      ? "workspaces"
      : wspType.includes("folder")
      ? "folders"
      : "documents";

  const cacheKey = `${lib}:${entitySegment}:${itemId}`;
  let secData = itemSecurityCache.get(cacheKey);

  if (!secData || secData.expiresAt < Date.now()) {
    try {
      const cfg = getImanageConfig();
      const secUrl = `${cfg.urlPrefix}/api/v2/customers/${encodeURIComponent(
        auth.customerId
      )}/libraries/${encodeURIComponent(lib)}/${entitySegment}/${encodeURIComponent(
        itemId
      )}/security`;
      const secRes = await fetch(secUrl, {
        method: "GET",
        headers: {
          "X-Auth-Token": auth.accessToken,
          Accept: "application/json",
        },
      });
      if (secRes.ok) {
        const secJson = await secRes.json();
        secData = {
          data: secJson.data || secJson,
          expiresAt: Date.now() + 5 * 60 * 1000,
        };
        itemSecurityCache.set(cacheKey, secData);
      }
    } catch {
      // 보안 조회 실패 시 보수적으로 차단
      return false;
    }
  }

  const acl = secData?.data;
  if (!acl) return false;

  // security 응답의 default_security가 public/view이면 허용
  const aclDefSec = String(acl.default_security || "").toLowerCase();
  if (aclDefSec === "public" || aclDefSec === "view") {
    return true;
  }

  const userTrustees = Array.isArray(acl.user_trustees)
    ? acl.user_trustees
    : Array.isArray(acl.users)
    ? acl.users
    : [];
  for (const ut of userTrustees) {
    const trusteeId = normalizeUserId(ut.id || ut.user_id || ut.name || ut);
    const accessLevel = String(ut.access_level || ut.access || "view").toLowerCase();
    if (
      trusteeId === targetUser &&
      accessLevel !== "none" &&
      accessLevel !== "no_access"
    ) {
      return true;
    }
  }

  const groupTrustees = Array.isArray(acl.group_trustees)
    ? acl.group_trustees
    : Array.isArray(acl.groups)
    ? acl.groups
    : [];
  for (const gt of groupTrustees) {
    const groupId = normalizeUserId(gt.id || gt.group_id || gt.name || gt);
    const accessLevel = String(gt.access_level || gt.access || "view").toLowerCase();
    if (
      userGroupSet.has(groupId) &&
      accessLevel !== "none" &&
      accessLevel !== "no_access"
    ) {
      return true;
    }
  }

  return false;
}

/**
 * API 응답 데이터에 대해 요청 사용자(auth.userId)의 ACL 권한 필터링 적용
 */
async function enforceUserAclOnPayload(payload, libraryName, auth, resolvedPath) {
  if (!payload || typeof payload !== "object") return payload;
  if (auth.authMode !== "service_account_acl") return payload;

  // 사용자 목록(/users), 캡션(/captions), 커스텀 코드(/custom) 등 비문서 메타데이터는 필터링 제외
  if (/\/(users|captions|custom1|custom2|customs|trustees)(\/|$)/i.test(resolvedPath)) {
    return payload;
  }

  const filterList = async (items) => {
    const allowed = [];
    for (const item of items) {
      const ok = await checkItemAclForUser(item, libraryName, auth);
      if (ok) allowed.push(item);
    }
    return allowed;
  };

  if (Array.isArray(payload.data)) {
    const filtered = await filterList(payload.data);
    return {
      ...payload,
      data: filtered,
      _aclFilteredCount: payload.data.length - filtered.length,
    };
  }

  if (payload.data && typeof payload.data === "object") {
    if (Array.isArray(payload.data.results)) {
      const filtered = await filterList(payload.data.results);
      return {
        ...payload,
        data: {
          ...payload.data,
          results: filtered,
        },
        _aclFilteredCount: payload.data.results.length - filtered.length,
      };
    }

    // 단건 문서/워크스페이스 상세 조회인 경우
    if (
      payload.data.id ||
      payload.data.document_number ||
      payload.data.default_security
    ) {
      const ok = await checkItemAclForUser(payload.data, libraryName, auth);
      if (!ok) {
        throw new Error(
          `[접근 권한 없음 - HTTP 403] 사용자 '${auth.userId}' 계정은 해당 비공개(Private) 문서 또는 사건에 대한 열람 권한(ACL)이 없습니다.`
        );
      }
    }
  }

  return payload;
}

/**
 * iManage 문서 / 워크스페이스 / 폴더의 바로가기 링크(Web URL, Preview URL, NRL, MCP 다운로드 URL) 생성
 */
export function buildItemLinks(item, fallbackLibrary = DEFAULT_LIBRARY, authUserId = "") {
  if (!item || typeof item !== "object") return null;

  const cfg = getImanageConfig();
  const baseUrl = cfg.urlPrefix;
  const mcpBaseUrl = getMcpPublicBaseUrl();

  const itemId = item.id || item.document_id || item.workspace_id || item.folder_id;
  if (!itemId || typeof itemId !== "string") return null;

  // ID에서 라이브러리 추출 (예: "MATTER!1284.1" -> library: "MATTER")
  let library = item.library || item.database || fallbackLibrary;
  if (itemId.includes("!")) {
    library = itemId.split("!")[0].toUpperCase();
  }

  const wspType = String(item.wstype || item.type || "").toLowerCase();
  const docNumber = item.document_number || item.docnum;
  const version = item.version || 1;

  let dmsHost = "";
  try {
    dmsHost = new URL(baseUrl).hostname;
  } catch {
    dmsHost = baseUrl;
  }

  // 1. 문서(Document)인 경우
  if (
    wspType === "document" ||
    docNumber !== undefined ||
    item.file_edit_date !== undefined ||
    item.extension !== undefined ||
    /\!\d+\.\d+$/.test(itemId)
  ) {
    const userParam = authUserId ? `?userId=${encodeURIComponent(authUserId)}` : "";
    return {
      imanage_web_url: `${baseUrl}/work/web/r/libraries/${encodeURIComponent(library)}/documents/${encodeURIComponent(itemId)}`,
      imanage_preview_url: `${baseUrl}/work/web/r/libraries/${encodeURIComponent(library)}/documents/${encodeURIComponent(itemId)}?action=view`,
      imanage_nrl_uri: docNumber
        ? `iwl:dms=${dmsHost}&lib=${library}&num=${docNumber}&ver=${version}`
        : undefined,
      mcp_download_url: `${mcpBaseUrl}/download/${encodeURIComponent(library)}/${encodeURIComponent(itemId)}${userParam}`,
    };
  }

  // 2. 워크스페이스(Workspace)인 경우
  if (wspType === "workspace" || item.workspace_id === itemId) {
    return {
      imanage_web_url: `${baseUrl}/work/web/r/libraries/${encodeURIComponent(library)}/workspaces/${encodeURIComponent(itemId)}`,
    };
  }

  // 3. 폴더(Folder / Tab / Search Folder)인 경우
  if (
    wspType.includes("folder") ||
    wspType === "tab" ||
    item.folder_type !== undefined
  ) {
    return {
      imanage_web_url: `${baseUrl}/work/web/r/libraries/${encodeURIComponent(library)}/folders/${encodeURIComponent(itemId)}`,
    };
  }

  return {
    imanage_web_url: `${baseUrl}/work/web/r/libraries/${encodeURIComponent(library)}/documents/${encodeURIComponent(itemId)}`,
  };
}

/**
 * 응답 데이터 내 문서/워크스페이스/폴더 객체에 iManage 링크(links) 자동 주입
 */
export function enrichResponseWithLinks(payload, libraryName, authUserId) {
  if (!payload || typeof payload !== "object") return payload;

  const enrichSingle = (obj) => {
    if (!obj || typeof obj !== "object") return obj;
    const links = buildItemLinks(obj, libraryName, authUserId);
    if (links) {
      return { ...obj, _links: links };
    }
    return obj;
  };

  if (Array.isArray(payload.data)) {
    return {
      ...payload,
      data: payload.data.map(enrichSingle),
    };
  }

  if (payload.data && typeof payload.data === "object") {
    if (Array.isArray(payload.data.results)) {
      return {
        ...payload,
        data: {
          ...payload.data,
          results: payload.data.results.map(enrichSingle),
        },
      };
    }
    return {
      ...payload,
      data: enrichSingle(payload.data),
    };
  }

  return payload;
}

/**
 * 날짜 입력값(YYYY-MM-DD 등)을 iManage ISO 8601(UTC) 포맷으로 정규화
 */
function normalizeDateParam(val, isEndOfDay = false) {
  if (!val) return undefined;
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return isEndOfDay ? `${s}T23:59:59Z` : `${s}T00:00:00Z`;
  }
  return s;
}

/**
 * 문서/워크스페이스/폴더 항목에서 최신성 비교용 타임스탬프(ms) 추출
 * 우선순위: edit_date -> file_edit_date -> last_used_date -> activity_date -> create_date -> file_create_date
 */
function getItemTimestampMs(item) {
  if (!item || typeof item !== "object") return 0;
  const rawDate =
    item.edit_date ||
    item.file_edit_date ||
    item.last_used_date ||
    item.activity_date ||
    item.create_date ||
    item.file_create_date ||
    item.date ||
    "";
  if (!rawDate) return 0;
  const ms = Date.parse(String(rawDate));
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * 문서/워크스페이스/폴더 항목에서 순번(Document Number / ID 번호) 추출 (최신 항목일수록 번호가 큼)
 */
function getItemDocNumber(item) {
  if (!item || typeof item !== "object") return 0;
  const explicitNum =
    item.document_number ?? item.docnum ?? item.workspace_number;
  if (explicitNum !== undefined && explicitNum !== null) {
    const n = Number(explicitNum);
    if (!Number.isNaN(n)) return n;
  }
  const idStr = String(
    item.id || item.document_id || item.workspace_id || item.folder_id || ""
  );
  const match = idStr.match(/!(\d+)(?:\.\d+)?$/);
  if (match) {
    return parseInt(match[1], 10) || 0;
  }
  return 0;
}

/**
 * 결과 배열이 오름차순(예전 문서 우선)으로 반환되었는지 판별
 */
function isAscendingOldestFirst(items) {
  if (!Array.isArray(items) || items.length < 2) return false;
  const first = items[0];
  const last = items[items.length - 1];
  const firstTs = getItemTimestampMs(first);
  const lastTs = getItemTimestampMs(last);
  if (firstTs > 0 && lastTs > 0 && firstTs !== lastTs) {
    return firstTs < lastTs;
  }
  const firstNum = getItemDocNumber(first);
  const lastNum = getItemDocNumber(last);
  return firstNum > 0 && lastNum > 0 && firstNum < lastNum;
}

/**
 * 문서/워크스페이스/폴더 목록을 정렬 기준(latest: 최신순[기본값], oldest: 오래된순, relevance: 원본유지)으로 정렬
 */
function sortItemsByOrder(items, sortOrder = "latest") {
  if (!Array.isArray(items) || items.length <= 1) return items;
  const mode = String(sortOrder || "latest").toLowerCase();
  if (mode === "relevance" || mode === "none") return items;

  const dir = mode === "oldest" || mode === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    const tsA = getItemTimestampMs(a);
    const tsB = getItemTimestampMs(b);
    if (tsA !== tsB) {
      return (tsA - tsB) * dir;
    }
    const numA = getItemDocNumber(a);
    const numB = getItemDocNumber(b);
    if (numA !== numB) {
      return (numA - numB) * dir;
    }
    return 0;
  });
}

/**
 * 날짜 범위 필터(from_edit_date, to_edit_date, from_create_date)를 응답 항목에 보강 적용
 */
function filterItemsByDateBounds(items, { fromEditMs, toEditMs, fromCreateMs }) {
  if (!Array.isArray(items)) return items;
  if (!fromEditMs && !toEditMs && !fromCreateMs) return items;

  return items.filter((item) => {
    if (!item || typeof item !== "object") return true;
    if (fromEditMs || toEditMs) {
      const editMs = getItemTimestampMs(item);
      if (editMs > 0) {
        if (fromEditMs && editMs < fromEditMs) return false;
        if (toEditMs && editMs > toEditMs) return false;
      }
    }
    if (fromCreateMs) {
      const rawCreate = item.create_date || item.file_create_date || item.edit_date;
      const createMs = rawCreate ? Date.parse(String(rawCreate)) : 0;
      if (createMs > 0 && !Number.isNaN(createMs) && createMs < fromCreateMs) {
        return false;
      }
    }
    return true;
  });
}

/**
 * 응답 payload에서 항목 배열(data 또는 data.results) 추출 및 교체 헬퍼
 */
function getPayloadItems(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (Array.isArray(payload.data)) return payload.data;
  if (payload.data && Array.isArray(payload.data.results)) {
    return payload.data.results;
  }
  return null;
}

function setPayloadItems(payload, items, extraMeta = {}) {
  if (!payload || typeof payload !== "object") return payload;
  if (Array.isArray(payload.data)) {
    return { ...payload, data: items, ...extraMeta };
  }
  if (payload.data && Array.isArray(payload.data.results)) {
    return {
      ...payload,
      data: { ...payload.data, results: items },
      ...extraMeta,
    };
  }
  return payload;
}

/**
 * ID 기준 중복 제거 병합
 */
function mergeUniqueItems(...itemLists) {
  const seen = new Set();
  const merged = [];
  for (const list of itemLists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const key =
        item.id ||
        item.document_id ||
        item.workspace_id ||
        item.folder_id ||
        JSON.stringify(item);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(item);
      }
    }
  }
  return merged;
}

/**
 * 범용 iManage V2 REST API 호출 함수 (최신 문서 우선 조회 및 정렬 기본 적용)
 */
export async function executeImanageApi({
  method = "GET",
  pathTemplate,
  pathParams = {},
  queryParams = {},
  body = undefined,
  authUserId = undefined,
}) {
  const cfg = getImanageConfig();
  const auth = await resolveUserAuthContext(authUserId);

  // 경로 템플릿 치환 ({{customerId}}, {{userId}}, {{libraryName}} 등)
  // 중요 보안 정책: {{userId}}는 타인의 ID로 위변조할 수 없도록 반드시 로그인된 본인의 auth.userId를 바인딩
  const mergedPathParams = {
    ...pathParams,
    customerId: auth.customerId,
    userId: auth.userId,
    libraryName: (pathParams.libraryName || DEFAULT_LIBRARY).toUpperCase(),
  };

  let resolvedPath = pathTemplate;
  for (const [k, v] of Object.entries(mergedPathParams)) {
    if (v !== undefined && v !== null) {
      resolvedPath = resolvedPath.replace(
        new RegExp(`\\{\\{${k}\\}\\}`, "g"),
        encodeURIComponent(String(v).trim())
      );
    }
  }

  // 치환되지 않은 필수 경로 변수가 남아있는지 확인
  const unreplaced = resolvedPath.match(/\{\{([^}]+)\}\}/g);
  if (unreplaced) {
    throw new Error(
      `필수 경로 파라미터가 누락되었습니다: ${unreplaced.join(", ")}`
    );
  }

  const isGet = method.toUpperCase() === "GET";
  const isRecentDocsEndpoint =
    isGet && /\/recent-documents$/i.test(resolvedPath);
  const isSearchCollectionEndpoint =
    isGet && /\/(documents|workspaces|folders)$/i.test(resolvedPath);
  const isSortableCollectionEndpoint =
    isGet &&
    /\/(documents|recent-documents|workspaces|folders|checked-out|children)$/i.test(
      resolvedPath
    );

  const effectiveQueryParams = { ...(queryParams || {}) };

  // 정렬 및 날짜 필터 확장 파라미터 추출 (기본값: 'latest' 최신 문서 기준)
  const sortOrder = String(
    effectiveQueryParams.sortOrder || "latest"
  ).toLowerCase();
  const recentDays =
    effectiveQueryParams.recentDays !== undefined &&
    effectiveQueryParams.recentDays !== ""
      ? Number(effectiveQueryParams.recentDays)
      : undefined;

  delete effectiveQueryParams.sortOrder;
  delete effectiveQueryParams.recentDays;

  if (
    recentDays &&
    !Number.isNaN(recentDays) &&
    recentDays > 0 &&
    !effectiveQueryParams.from_edit_date
  ) {
    const sinceIso =
      new Date(Date.now() - recentDays * 24 * 60 * 60 * 1000)
        .toISOString()
        .split(".")[0] + "Z";
    effectiveQueryParams.from_edit_date = sinceIso;
  }

  if (effectiveQueryParams.from_edit_date) {
    effectiveQueryParams.from_edit_date = normalizeDateParam(
      effectiveQueryParams.from_edit_date,
      false
    );
  }
  if (effectiveQueryParams.to_edit_date) {
    effectiveQueryParams.to_edit_date = normalizeDateParam(
      effectiveQueryParams.to_edit_date,
      true
    );
  }
  if (effectiveQueryParams.from_create_date) {
    effectiveQueryParams.from_create_date = normalizeDateParam(
      effectiveQueryParams.from_create_date,
      false
    );
  }

  const fromEditMs = effectiveQueryParams.from_edit_date
    ? Date.parse(effectiveQueryParams.from_edit_date)
    : 0;
  const toEditMs = effectiveQueryParams.to_edit_date
    ? Date.parse(effectiveQueryParams.to_edit_date)
    : 0;
  const fromCreateMs = effectiveQueryParams.from_create_date
    ? Date.parse(effectiveQueryParams.from_create_date)
    : 0;

  // PRIVATE 라이브러리에서 ACL 검증 모드로 문서 검색 시 본인(author) 문서만 조회되도록 강제
  if (
    auth.authMode === "service_account_acl" &&
    mergedPathParams.libraryName === "PRIVATE" &&
    /\/documents(\/search)?$/i.test(resolvedPath) &&
    !effectiveQueryParams.author
  ) {
    effectiveQueryParams.author = auth.userId;
  }

  const requestedLimit =
    effectiveQueryParams.limit !== undefined
      ? Number(effectiveQueryParams.limit) || 25
      : 25;
  const requestedOffset =
    effectiveQueryParams.offset !== undefined
      ? Number(effectiveQueryParams.offset) || 0
      : 0;

  // 최신순(latest) 조회 시 iManage 서버가 예전 문서번호(docnum 오름차순)부터 잘라서 반환하는 현상을 방지하기 위해
  // 서버 요청 시에는 더 넉넉한 건수(최대 300건)와 total=true를 함께 요청하여 최신 구간 조회 및 최신순 정렬 후 requestedLimit만큼 반환
  if (isSearchCollectionEndpoint && sortOrder === "latest") {
    const expandedLimit = Math.min(Math.max(requestedLimit * 8, 200), 300);
    effectiveQueryParams.limit = expandedLimit;
    if (effectiveQueryParams.total === undefined) {
      effectiveQueryParams.total = "true";
    }
  }

  const headers = {
    "X-Auth-Token": auth.accessToken,
    Accept: "application/json",
  };

  // 단일 HTTP 요청 실행 헬퍼 (401 토큰 자동 갱신 포함)
  const performRequest = async (targetPath, qParams = {}) => {
    const reqUrl = new URL(`${cfg.urlPrefix}${targetPath}`);
    for (const [k, v] of Object.entries(qParams)) {
      if (v !== undefined && v !== null && v !== "") {
        reqUrl.searchParams.set(k, String(v));
      }
    }

    const fetchOptions = {
      method: method.toUpperCase(),
      headers,
    };

    if (body !== undefined && body !== null && !isGet) {
      headers["Content-Type"] = "application/json";
      fetchOptions.body =
        typeof body === "string" ? body : JSON.stringify(body);
    }

    let response = await fetch(reqUrl.toString(), fetchOptions);

    if (response.status === 401 && auth.authSource !== "header_token") {
      const session = userSessions.get(normalizeUserId(auth.userId));
      if (session && session.encryptedRefreshToken) {
        const newAccessToken = await refreshUserSession(session);
        headers["X-Auth-Token"] = newAccessToken;
        response = await fetch(reqUrl.toString(), fetchOptions);
      }
    }

    const rawText = await response.text();
    let json;
    try {
      json = rawText ? JSON.parse(rawText) : {};
    } catch {
      json = { rawText };
    }
    return { response, rawText, json };
  };

  // [특수 처리 1] 사내 SSO/사번 인증 모드(service_account_acl)에서 /recent-documents 호출 시:
  // 토큰 소유자(서비스 계정)의 최근 문서가 아니라, 실제 요청 사용자(auth.userId)가 최근 수정(operator)하거나 작성(author)한 최신 문서를 조회하여 병합
  if (isRecentDocsEndpoint && auth.authMode === "service_account_acl") {
    const docsPath = resolvedPath.replace(/\/recent-documents$/i, "/documents");
    const fetchWindow = Math.min(Math.max(requestedLimit * 4, 100), 250);

    const [byOperator, byAuthor, byRecent] = await Promise.allSettled([
      performRequest(docsPath, { operator: auth.userId, limit: fetchWindow }),
      performRequest(docsPath, { author: auth.userId, limit: fetchWindow }),
      performRequest(resolvedPath, { limit: fetchWindow }),
    ]);

    const opItems =
      byOperator.status === "fulfilled" && byOperator.value.response.ok
        ? getPayloadItems(byOperator.value.json) || []
        : [];
    const auItems =
      byAuthor.status === "fulfilled" && byAuthor.value.response.ok
        ? getPayloadItems(byAuthor.value.json) || []
        : [];
    const recItems =
      byRecent.status === "fulfilled" && byRecent.value.response.ok
        ? getPayloadItems(byRecent.value.json) || []
        : [];

    // 본인이 수정/작성한 문서를 우선 병합하고, 부족할 경우 최근 문서 목록을 합쳐 최신 수정일(edit_date) 내림차순 정렬
    const combined = mergeUniqueItems(opItems, auItems, recItems);
    const sorted = sortItemsByOrder(combined, "latest");
    const syntheticPayload = {
      data: sorted,
    };

    const aclChecked = await enforceUserAclOnPayload(
      syntheticPayload,
      mergedPathParams.libraryName,
      auth,
      docsPath
    );

    const finalItems = (getPayloadItems(aclChecked) || []).slice(
      0,
      requestedLimit
    );
    const slicedPayload = setPayloadItems(aclChecked, finalItems, {
      _sortOrder: "latest (edit_date desc)",
      _returnedCount: finalItems.length,
    });

    const enriched = enrichResponseWithLinks(
      slicedPayload,
      mergedPathParams.libraryName,
      auth.userId
    );

    return {
      actingUser: {
        userId: auth.userId,
        customerId: auth.customerId,
        library: mergedPathParams.libraryName,
        authMode: auth.authMode,
      },
      result: enriched,
    };
  }

  // 기본 API 호출 수행
  let { response: res, rawText, json: parsed } = await performRequest(
    resolvedPath,
    effectiveQueryParams
  );

  // 만약 서버가 특정 날짜 파라미터(from_edit_date 등)를 지원하지 않아 400을 반환한 경우,
  // 해당 파라미터를 제거하고 재조회한 뒤 아래의 filterItemsByDateBounds에서 안전하게 필터링
  if (
    res.status === 400 &&
    (effectiveQueryParams.from_edit_date ||
      effectiveQueryParams.to_edit_date ||
      effectiveQueryParams.from_create_date)
  ) {
    const fallbackParams = { ...effectiveQueryParams };
    delete fallbackParams.from_edit_date;
    delete fallbackParams.to_edit_date;
    delete fallbackParams.from_create_date;
    const retry = await performRequest(resolvedPath, fallbackParams);
    res = retry.response;
    rawText = retry.rawText;
    parsed = retry.json;
  }

  if (!res.ok) {
    const detail =
      parsed?.error?.message ||
      parsed?.error_description ||
      parsed?.message ||
      rawText.slice(0, 400);
    throw new Error(
      `iManage API 오류 (HTTP ${res.status} - ${method} ${resolvedPath}): ${detail}`
    );
  }

  // [특수 처리 2] 문서/워크스페이스/폴더 목록을 최신순(latest)으로 조회할 때,
  // iManage 서버가 오래된 문서번호(docnum 오름차순) 순서로 반환하여 앞쪽(예전 문서)만 잘려온 경우 보강 조회 수행
  let rawItems = getPayloadItems(parsed);
  if (
    isSearchCollectionEndpoint &&
    sortOrder === "latest" &&
    Array.isArray(rawItems) &&
    rawItems.length > 0
  ) {
    const totalCount = Number(
      parsed.total_count ??
        parsed.total ??
        parsed.total_results ??
        parsed.data?.total_count ??
        parsed.data?.total ??
        0
    );
    const expandedLimit = Number(effectiveQueryParams.limit) || 200;
    const isOldestFirst = isAscendingOldestFirst(rawItems);

    // (A) 서버가 total_count를 제공하고 오름차순(예전 문서부터)으로 반환한 경우 -> 가장 끝 페이지(최신 구간)를 즉시 추가 조회
    if (isOldestFirst && totalCount > rawItems.length && requestedOffset === 0) {
      const tailOffset = Math.max(0, totalCount - expandedLimit);
      try {
        const tailResp = await performRequest(resolvedPath, {
          ...effectiveQueryParams,
          offset: tailOffset,
          limit: expandedLimit,
        });
        if (tailResp.response.ok) {
          const tailItems = getPayloadItems(tailResp.json) || [];
          rawItems = mergeUniqueItems(tailItems, rawItems);
        }
      } catch {
        // 추가 조회 실패 시 기존 결과 유지
      }
    }

    // (B) 예전 문서부터 오름차순으로 가득 차서 반환된 경우, 최근 1년(from_edit_date) 조건으로 추가 조회하여 최신 문서가 잘리지 않도록 보강
    if (
      isOldestFirst &&
      rawItems.length >= expandedLimit &&
      requestedOffset === 0 &&
      !effectiveQueryParams.from_edit_date
    ) {
      const oneYearAgoIso = new Date(
        Date.now() - 365 * 24 * 60 * 60 * 1000
      ).toISOString();
      try {
        const recentWindowResp = await performRequest(resolvedPath, {
          ...effectiveQueryParams,
          from_edit_date: oneYearAgoIso,
          limit: expandedLimit,
        });
        if (recentWindowResp.response.ok) {
          const recentWindowItems = getPayloadItems(recentWindowResp.json) || [];
          rawItems = mergeUniqueItems(recentWindowItems, rawItems);
        }
      } catch {
        // from_edit_date 미지원 엔드포인트인 경우 무시
      }
    }

    // (C) 세부 검색어 없이 전체 문서 목록을 조회한 경우,
    //     최근 문서 엔드포인트(/recent-documents) 및 본인 최근 작업 문서도 함께 조회하여 최신 문서를 상단에 보강
    const hasSpecificFilter = Boolean(
      effectiveQueryParams.anywhere ||
        effectiveQueryParams.name ||
        effectiveQueryParams.body ||
        effectiveQueryParams.custom1 ||
        effectiveQueryParams.custom2 ||
        effectiveQueryParams.author ||
        effectiveQueryParams.operator
    );

    if (
      !hasSpecificFilter &&
      /\/documents$/i.test(resolvedPath) &&
      !/\/folders\//i.test(resolvedPath) &&
      requestedOffset === 0 &&
      (isOldestFirst || rawItems.length >= expandedLimit)
    ) {
      const recentPath = resolvedPath.replace(
        /\/documents$/i,
        "/recent-documents"
      );
      const supplementCalls = [
        performRequest(recentPath, { limit: 100 }),
      ];
      if (auth.userId) {
        supplementCalls.push(
          performRequest(resolvedPath, {
            ...effectiveQueryParams,
            operator: auth.userId,
            limit: 100,
          })
        );
      }
      const settled = await Promise.allSettled(supplementCalls);
      for (const s of settled) {
        if (s.status === "fulfilled" && s.value.response.ok) {
          const extra = getPayloadItems(s.value.json) || [];
          rawItems = mergeUniqueItems(extra, rawItems);
        }
      }
    }

    parsed = setPayloadItems(parsed, rawItems);
  }

  // 날짜 범위 필터(from_edit_date, to_edit_date, from_create_date, recentDays) 및 최신순/오래된순 정렬 적용
  const currentItems = getPayloadItems(parsed);
  if (isSortableCollectionEndpoint && Array.isArray(currentItems)) {
    const dateFiltered = filterItemsByDateBounds(currentItems, {
      fromEditMs: Number.isNaN(fromEditMs) ? 0 : fromEditMs,
      toEditMs: Number.isNaN(toEditMs) ? 0 : toEditMs,
      fromCreateMs: Number.isNaN(fromCreateMs) ? 0 : fromCreateMs,
    });
    const sortedItems = sortItemsByOrder(dateFiltered, sortOrder);
    parsed = setPayloadItems(parsed, sortedItems);
  }

  // 사용자별 ACL 보안 필터링 적용 (정렬 후 슬라이싱 전에 수행하여 권한 있는 최신 문서가 누락되지 않도록 보장)
  const aclChecked = await enforceUserAclOnPayload(
    parsed,
    mergedPathParams.libraryName,
    auth,
    resolvedPath
  );

  // 요청된 limit 건수로 최종 슬라이싱
  let finalPayload = aclChecked;
  const aclItems = getPayloadItems(aclChecked);
  if (isSortableCollectionEndpoint && Array.isArray(aclItems)) {
    const sliced = aclItems.slice(0, requestedLimit);
    finalPayload = setPayloadItems(aclChecked, sliced, {
      _sortOrder:
        sortOrder === "latest"
          ? "latest (최신 수정일 edit_date 및 문서번호 내림차순)"
          : sortOrder,
      _returnedCount: sliced.length,
    });
  }

  const enriched = enrichResponseWithLinks(
    finalPayload,
    mergedPathParams.libraryName,
    auth.userId
  );

  return {
    actingUser: {
      userId: auth.userId,
      customerId: auth.customerId,
      library: mergedPathParams.libraryName,
      authMode: auth.authMode,
    },
    result: enriched,
  };
}

/**
 * ZIP 기반 문서(DOCX, XLSX, PPTX, HWPX)에서 XML 텍스트 추출 (보조 파서)
 */
function extractTextFromZipXmlBuffer(buffer) {
  const texts = [];
  let offset = 0;
  while (offset + 30 < buffer.length) {
    // Local file header signature = 0x04034b50
    if (buffer.readUInt32LE(offset) !== 0x04034b50) {
      offset++;
      continue;
    }
    const compressionMethod = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const fileName = buffer
      .subarray(offset + 30, offset + 30 + fileNameLen)
      .toString("utf8");
    const dataStart = offset + 30 + fileNameLen + extraLen;
    const dataEnd = dataStart + compressedSize;

    if (
      dataEnd <= buffer.length &&
      /\.(xml|rels)$/i.test(fileName) &&
      /(document|sheet|sharedStrings|slide|section|content)/i.test(fileName)
    ) {
      try {
        const compressed = buffer.subarray(dataStart, dataEnd);
        const xmlBuf =
          compressionMethod === 8
            ? zlib.inflateRawSync(compressed)
            : compressionMethod === 0
            ? compressed
            : null;
        if (xmlBuf) {
          const xmlStr = xmlBuf.toString("utf8");
          const cleaned = xmlStr
            .replace(/<\/(w:p|p|row|a:p|hp:p)>/gi, "\n")
            .replace(/<[^>]+>/g, " ")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&amp;/g, "&")
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/[ \t]+/g, " ")
            .trim();
          if (cleaned) texts.push(cleaned);
        }
      } catch {
        // 개별 엔트리 압축 해제 실패 시 무시하고 다음 진행
      }
    }
    offset = dataEnd > offset ? dataEnd : offset + 1;
  }
  return texts.join("\n\n");
}

/**
 * 다운로드한 파일 버퍼에서 AI가 읽을 수 있는 텍스트를 추출합니다.
 */
async function extractTextFromBuffer(buffer, fileName, mimeType = "") {
  const ext = path.extname(fileName || "").toLowerCase().replace(".", "");

  // 1. PDF 파일
  if (ext === "pdf" || mimeType.includes("pdf")) {
    try {
      const pdfParseModule = await import("pdf-parse/lib/pdf-parse.js").catch(
        () => import("pdf-parse")
      );
      const pdfParse = pdfParseModule.default || pdfParseModule;
      const data = await pdfParse(buffer);
      return {
        extracted: true,
        format: "pdf",
        pageCount: data.numpages,
        text: (data.text || "").trim(),
      };
    } catch (err) {
      return {
        extracted: false,
        format: "pdf",
        reason: `PDF 텍스트 추출 중 오류 발생: ${err.message}`,
      };
    }
  }

  // 2. Word (DOCX) 파일
  if (ext === "docx" || mimeType.includes("wordprocessingml")) {
    try {
      const mammothModule = await import("mammoth");
      const mammoth = mammothModule.default || mammothModule;
      const result = await mammoth.extractRawText({ buffer });
      return {
        extracted: true,
        format: "docx",
        text: (result.value || "").trim(),
      };
    } catch {
      const fallbackText = extractTextFromZipXmlBuffer(buffer);
      return {
        extracted: Boolean(fallbackText),
        format: "docx",
        text: fallbackText,
      };
    }
  }

  // 3. HWPX / XLSX / PPTX (ZIP+XML 기반 오피스/한글 표준 문서)
  if (["hwpx", "xlsx", "pptx"].includes(ext)) {
    const xmlText = extractTextFromZipXmlBuffer(buffer);
    return {
      extracted: Boolean(xmlText),
      format: ext,
      text: xmlText || `(${ext.toUpperCase()} 파일에서 텍스트를 추출하지 못했습니다.)`,
    };
  }

  // 4. 일반 텍스트 계열 (TXT, CSV, JSON, MD, XML, HTML, LOG 등)
  if (
    ["txt", "csv", "json", "md", "xml", "html", "htm", "log", "sql", "js", "py"].includes(
      ext
    ) ||
    mimeType.startsWith("text/")
  ) {
    let text = buffer.toString("utf8");
    // UTF-8 깨짐 문자()가 많으면 한국어 EUC-KR(CP949) 디코딩 시도
    if (text.includes("\uFFFD")) {
      try {
        const decoder = new TextDecoder("euc-kr");
        text = decoder.decode(buffer);
      } catch {
        // 기본 utf8 유지
      }
    }
    return {
      extracted: true,
      format: ext || "text",
      text: text.trim(),
    };
  }

  return {
    extracted: false,
    format: ext || "binary",
    reason: `이 파일 형식(.${ext || "unknown"})은 바이너리 포맷이므로 지정된 다운로드 폴더에 저장된 원본 파일을 확인하거나 iManage 웹 링크로 열람해 주세요.`,
  };
}

/**
 * 문서 다운로드 + 텍스트 추출 + 지정 폴더 저장 + iManage 바로가기 링크 제공
 */
export async function downloadAndProcessDocument({
  libraryName = DEFAULT_LIBRARY,
  documentId,
  saveToDisk = true,
  customDownloadDir = undefined,
  extractText = true,
  maxTextLength = 30000,
  authUserId = undefined,
}) {
  const cfg = getImanageConfig();
  const auth = await resolveUserAuthContext(authUserId);
  const lib = (libraryName || DEFAULT_LIBRARY).trim().toUpperCase();

  // 1. 문서 메타데이터 먼저 조회 (파일명, 확장자, 버전 및 사용자별 ACL 권한 확인)
  let docMeta = {};
  try {
    const metaResp = await executeImanageApi({
      method: "GET",
      pathTemplate:
        "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/documents/{{documentId}}",
      pathParams: { libraryName: lib, documentId },
      authUserId: auth.userId,
    });
    docMeta = metaResp.result?.data || metaResp.result || {};
  } catch (metaErr) {
    // ACL 권한 없음(403) 오류인 경우 다운로드를 즉시 차단
    if (String(metaErr.message).includes("접근 권한 없음")) {
      throw metaErr;
    }
  }

  // 2. 문서 파일 다운로드 호출
  const downloadPath = `/api/v2/customers/${encodeURIComponent(
    auth.customerId
  )}/libraries/${encodeURIComponent(lib)}/documents/${encodeURIComponent(
    documentId
  )}/download`;

  const res = await fetch(`${cfg.urlPrefix}${downloadPath}`, {
    method: "GET",
    headers: {
      "X-Auth-Token": auth.accessToken,
    },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `문서 다운로드 실패 (HTTP ${res.status} - 문서ID: ${documentId}): 권한이 없거나 존재하지 않는 문서입니다. 상세: ${errText.slice(0, 300)}`
    );
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const contentType = res.headers.get("content-type") || "";
  const contentDisposition = res.headers.get("content-disposition") || "";

  // 파일명 결정
  let fileName = "";
  const filenameStarMatch = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  const filenameMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
  if (filenameStarMatch) {
    fileName = decodeURIComponent(filenameStarMatch[1]);
  } else if (filenameMatch) {
    fileName = decodeURIComponent(filenameMatch[1]);
  } else if (docMeta.name) {
    const ext = (docMeta.extension || docMeta.type || "bin")
      .toLowerCase()
      .replace(/^\./, "");
    fileName = docMeta.name.toLowerCase().endsWith(`.${ext}`)
      ? docMeta.name
      : `${docMeta.name}.${ext}`;
  } else {
    fileName = `${documentId.replace(/[^a-zA-Z0-9._-]/g, "_")}.bin`;
  }

  // 안전한 파일명으로 정제 (경로 조작 방지)
  const safeFileName = fileName.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
  const safeDocPrefix = documentId.replace(/[^a-zA-Z0-9._!-]/g, "_");

  // 3. 지정 폴더에 파일 저장 (사용자별 하위 폴더 격리)
  let savedFilePath = null;
  if (saveToDisk) {
    const baseDownloadDir = path.resolve(
      customDownloadDir || process.env.IMANAGE_DOWNLOAD_DIR || "./downloads"
    );
    const userDir = path.join(
      baseDownloadDir,
      normalizeUserId(auth.userId).replace(/[^a-zA-Z0-9._-]/g, "_") || "default"
    );
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    savedFilePath = path.join(userDir, `${safeDocPrefix}_${safeFileName}`);
    fs.writeFileSync(savedFilePath, buffer);
  }

  // 4. AI 활용을 위한 텍스트 추출
  let extractionResult = null;
  if (extractText) {
    extractionResult = await extractTextFromBuffer(
      buffer,
      safeFileName,
      contentType
    );
    if (
      extractionResult?.text &&
      maxTextLength > 0 &&
      extractionResult.text.length > maxTextLength
    ) {
      extractionResult.totalTextLength = extractionResult.text.length;
      extractionResult.truncated = true;
      extractionResult.text =
        extractionResult.text.slice(0, maxTextLength) +
        `\n\n... [본문이 길어 ${maxTextLength}자까지만 표시됨. 전체 ${extractionResult.totalTextLength}자]`;
    }
  }

  // 5. iManage 문서 링크 생성
  const links = buildItemLinks(
    {
      ...docMeta,
      id: documentId,
      library: lib,
      wstype: "document",
    },
    lib,
    auth.userId
  );

  return {
    actingUser: {
      userId: auth.userId,
      customerId: auth.customerId,
    },
    document: {
      id: documentId,
      library: lib,
      fileName: safeFileName,
      sizeBytes: buffer.length,
      contentType,
      author: docMeta.author_description || docMeta.author,
      operator: docMeta.operator_description || docMeta.operator,
      version: docMeta.version,
      editDate: docMeta.edit_date || docMeta.file_edit_date,
      custom1: docMeta.custom1_description
        ? `${docMeta.custom1} (${docMeta.custom1_description})`
        : docMeta.custom1,
      custom2: docMeta.custom2_description
        ? `${docMeta.custom2} (${docMeta.custom2_description})`
        : docMeta.custom2,
      defaultSecurity: docMeta.default_security,
    },
    links,
    savedFilePath,
    extraction: extractionResult,
    buffer, // HTTP 직접 다운로드 엔드포인트(/download/...)에서도 재사용 가능
  };
}

