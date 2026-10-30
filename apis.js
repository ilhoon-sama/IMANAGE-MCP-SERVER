/**
 * ============================================================================
 * 📌 iManage Work Server V2 On-Premise 맞춤형 REST API 관리 파일 (Postman Collection 기반)
 * ============================================================================
 *
 * [작성 방법 - 기존 MSSQL MCP의 queries.js와 동일한 구조]
 * 1. name: MCP 도구 이름 (Gemini Enterprise / ChatGPT 등 AI가 호출하는 함수명)
 * 2. description: AI가 언제 이 API를 호출해야 하는지 알려주는 설명
 * 3. type: "read" (GET 조회용) 또는 "write" (POST / PUT / PATCH / DELETE 변경용)
 * 4. method: HTTP 메서드 ("GET", "POST", "PUT", "PATCH", "DELETE")
 * 5. path: iManage V2 API 경로 템플릿
 *    - `{{customerId}}` 및 `{{userId}}`는 로그인한 사용자의 세션에서 자동 바인딩됩니다 (타인 ID 도용 방지).
 *    - `{{libraryName}}`은 입력하지 않으면 기본값(`MATTER`)으로 자동 설정됩니다.
 *      (사용 가능 라이브러리: MATTER / PRECEDENT / SERVICE / TRAINING / PRIVATE)
 * 6. params: AI가 입력할 파라미터 정의
 *    - in: "path" (URL 경로 변수) | "query" (URL 쿼리스트링) | "body" (JSON 요청 본문)
 *    - type: "string" | "number" | "boolean"
 *    - required: 필수 여부 (true / false)
 */

const LIBRARY_DESC =
  "대상 iManage 라이브러리명 (MATTER: 사건/자문[기본값], PRECEDENT: 판례/양식, SERVICE: 서비스, TRAINING: 교육, PRIVATE: 개인문서)";

const SORT_ORDER_DESC =
  "정렬 기준 (기본값: 'latest' [최신 수정일 edit_date 및 최신 문서번호 내림차순], 'oldest' [오래된 순], 'relevance' [검색 정확도순])";

export const APIS = [
  // ==========================================================================
  // 1. [Documents] 문서 검색, 상세 조회, 버전/활동 이력 조회 (기본값: 최신 문서 우선)
  // ==========================================================================
  {
    name: "search_library_documents",
    description:
      "지정한 라이브러리(MATTER/PRECEDENT/SERVICE/TRAINING/PRIVATE, 기본값: MATTER)에서 문서를 조건 검색합니다. 기본적으로 최신 수정일(edit_date) 및 최신 문서번호 기준 내림차순(최신 문서 우선)으로 정렬하여 반환합니다. 통합 검색어(anywhere), 문서 제목(name), 본문(body), 작성자(author), 수정자(operator), 고객코드(custom1), 사건/자문 관리번호(custom2), 최근 일수(recentDays), 수정일 범위(from_edit_date/to_edit_date) 등으로 검색하며, 로그인한 사용자가 열람 권한을 가진 문서 목록과 iManage 웹 바로가기 링크(_links)를 반환합니다.",
    type: "read",
    method: "GET",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/documents",
    params: {
      libraryName: {
        in: "path",
        type: "string",
        required: false,
        default: "MATTER",
        description: LIBRARY_DESC,
      },
      anywhere: {
        in: "query",
        type: "string",
        required: false,
        description: "통합 키워드 검색 (문서 제목 + 본문 + 설명 통합 검색어)",
      },
      name: {
        in: "query",
        type: "string",
        required: false,
        description: "문서 제목(파일명) 검색어",
      },
      body: {
        in: "query",
        type: "string",
        required: false,
        description: "문서 본문 내 포함 텍스트 검색어",
      },
      custom1: {
        in: "query",
        type: "string",
        required: false,
        description: "Custom1 코드 (주로 고객번호 / Client ID)",
      },
      custom2: {
        in: "query",
        type: "string",
        required: false,
        description: "Custom2 코드 (주로 사건/자문 관리번호 / Matter No)",
      },
      author: {
        in: "query",
        type: "string",
        required: false,
        description: "문서 작성자(Author) 사번/ID",
      },
      operator: {
        in: "query",
        type: "string",
        required: false,
        description: "문서 최종 수정자(Operator) 사번/ID",
      },
      type: {
        in: "query",
        type: "string",
        required: false,
        description: "문서 애플리케이션 타입 (예: WORD, ACROBAT, EXCEL, PPT, HWP 등)",
      },
      recentDays: {
        in: "query",
        type: "number",
        required: false,
        description:
          "최근 N일 이내 수정된 문서만 필터링할 때 입력 (예: 30, 90, 365). 비워두면 전체 기간에서 최신순으로 조회합니다.",
      },
      from_edit_date: {
        in: "query",
        type: "string",
        required: false,
        description:
          "이 날짜 이후에 수정된 문서만 조회 (YYYY-MM-DD 또는 ISO 8601 형식, 예: '2025-01-01')",
      },
      to_edit_date: {
        in: "query",
        type: "string",
        required: false,
        description:
          "이 날짜 이전에 수정된 문서만 조회 (YYYY-MM-DD 또는 ISO 8601 형식, 예: '2026-12-31')",
      },
      from_create_date: {
        in: "query",
        type: "string",
        required: false,
        description:
          "이 날짜 이후에 생성된 문서만 조회 (YYYY-MM-DD 또는 ISO 8601 형식, 예: '2025-01-01')",
      },
      sortOrder: {
        in: "query",
        type: "string",
        required: false,
        default: "latest",
        description: SORT_ORDER_DESC,
      },
      limit: {
        in: "query",
        type: "number",
        required: false,
        default: 25,
        description: "최대 조회 건수 (기본값: 25)",
      },
      offset: {
        in: "query",
        type: "number",
        required: false,
        description: "페이징 시작 위치 (0부터 시작)",
      },
    },
  },

  {
    name: "search_all_customer_documents",
    description:
      "전체 라이브러리(MATTER, PRECEDENT, SERVICE, TRAINING, PRIVATE)를 대상으로 문서를 통합 검색합니다. 기본적으로 최신 수정일(edit_date) 및 최신 문서번호 기준 내림차순(최신 문서 우선)으로 정렬하여 반환합니다.",
    type: "read",
    method: "GET",
    path: "/api/v2/customers/{{customerId}}/documents",
    params: {
      anywhere: {
        in: "query",
        type: "string",
        required: false,
        description: "통합 키워드 검색어",
      },
      name: {
        in: "query",
        type: "string",
        required: false,
        description: "문서 제목 검색어",
      },
      body: {
        in: "query",
        type: "string",
        required: false,
        description: "문서 본문 내 포함 텍스트 검색어",
      },
      custom1: {
        in: "query",
        type: "string",
        required: false,
        description: "Custom1 (고객 ID)",
      },
      custom2: {
        in: "query",
        type: "string",
        required: false,
        description: "Custom2 (사건/자문 관리번호)",
      },
      author: {
        in: "query",
        type: "string",
        required: false,
        description: "작성자 ID",
      },
      operator: {
        in: "query",
        type: "string",
        required: false,
        description: "최종 수정자(Operator) ID",
      },
      type: {
        in: "query",
        type: "string",
        required: false,
        description: "문서 애플리케이션 타입 (예: WORD, ACROBAT, EXCEL, PPT, HWP 등)",
      },
      recentDays: {
        in: "query",
        type: "number",
        required: false,
        description: "최근 N일 이내 수정된 문서만 필터링할 때 입력 (예: 30, 90, 365)",
      },
      from_edit_date: {
        in: "query",
        type: "string",
        required: false,
        description: "이 날짜 이후에 수정된 문서만 조회 (예: '2025-01-01')",
      },
      to_edit_date: {
        in: "query",
        type: "string",
        required: false,
        description: "이 날짜 이전에 수정된 문서만 조회 (예: '2026-12-31')",
      },
      from_create_date: {
        in: "query",
        type: "string",
        required: false,
        description: "이 날짜 이후에 생성된 문서만 조회 (예: '2025-01-01')",
      },
      sortOrder: {
        in: "query",
        type: "string",
        required: false,
        default: "latest",
        description: SORT_ORDER_DESC,
      },
      limit: {
        in: "query",
        type: "number",
        required: false,
        default: 25,
        description: "최대 조회 건수 (기본값: 25)",
      },
      offset: {
        in: "query",
        type: "number",
        required: false,
        description: "페이징 시작 위치 (0부터 시작)",
      },
    },
  },

  {
    name: "get_recent_documents",
    description:
      "지정한 라이브러리(기본값: MATTER)에서 로그인한 사용자가 최근 열람·수정·작성한 최신 문서(Recent Documents) 목록과 iManage 문서 링크를 최신순으로 조회합니다.",
    type: "read",
    method: "GET",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/recent-documents",
    params: {
      libraryName: {
        in: "path",
        type: "string",
        required: false,
        default: "MATTER",
        description: LIBRARY_DESC,
      },
      limit: {
        in: "query",
        type: "number",
        required: false,
        default: 25,
        description: "최대 조회 건수 (기본값: 25)",
      },
    },
  },

  {
    name: "get_all_recent_documents",
    description:
      "전체 라이브러리(MATTER, PRECEDENT, SERVICE, TRAINING, PRIVATE)에서 로그인한 사용자가 최근 열람·수정·작성한 최신 문서(Recent Documents) 목록을 통합 조회합니다.",
    type: "read",
    method: "GET",
    path: "/api/v2/customers/{{customerId}}/recent-documents",
    params: {
      limit: {
        in: "query",
        type: "number",
        required: false,
        default: 25,
        description: "최대 조회 건수 (기본값: 25)",
      },
    },
  },

  {
    name: "get_checked_out_documents",
    description:
      "특정 라이브러리에서 현재 체크아웃(편집 중 잠금) 상태인 문서 목록을 조회합니다.",
    type: "read",
    method: "GET",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/documents/checked-out",
    params: {
      libraryName: {
        in: "path",
        type: "string",
        required: false,
        default: "MATTER",
        description: LIBRARY_DESC,
      },
    },
  },

  {
    name: "get_document_detail",
    description:
      "특정 문서 ID(documentId, 예: 'MATTER!12345.1')의 상세 프로파일 메타데이터(제목, 문서번호, 버전, 작성자, 고객/사건번호 custom1/custom2, 보안등급 등)와 iManage 웹 링크를 조회합니다.",
    type: "read",
    method: "GET",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/documents/{{documentId}}",
    params: {
      libraryName: {
        in: "path",
        type: "string",
        required: false,
        default: "MATTER",
        description: LIBRARY_DESC,
      },
      documentId: {
        in: "path",
        type: "string",
        required: true,
        description: "조회할 문서 ID (예: 'MATTER!12345.1')",
      },
    },
  },

  {
    name: "get_document_nvp",
    description:
      "특정 문서(documentId)의 추가 속성인 Name-Value Pairs(NVP) 정보를 조회합니다.",
    type: "read",
    method: "GET",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/documents/{{documentId}}/name-value-pairs",
    params: {
      libraryName: {
        in: "path",
        type: "string",
        required: false,
        default: "MATTER",
        description: LIBRARY_DESC,
      },
      documentId: {
        in: "path",
        type: "string",
        required: true,
        description: "문서 ID (예: 'MATTER!12345.1')",
      },
    },
  },

  {
    name: "get_document_history",
    description:
      "특정 문서(documentId)의 전체 이력(History)을 조회합니다.",
    type: "read",
    method: "GET",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/documents/{{documentId}}/history",
    params: {
      libraryName: {
        in: "path",
        type: "string",
        required: false,
        default: "MATTER",
        description: LIBRARY_DESC,
      },
      documentId: {
        in: "path",
        type: "string",
        required: true,
        description: "문서 ID (예: 'MATTER!12345.1')",
      },
    },
  },

  {
    name: "get_document_version_history",
    description:
      "특정 문서(documentId)의 모든 버전 이력(Version History: v1, v2 등 각 버전별 문서ID, 수정자, 수정일시, 코멘트)을 조회합니다.",
    type: "read",
    method: "GET",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/documents/{{documentId}}/history/versions",
    params: {
      libraryName: {
        in: "path",
        type: "string",
        required: false,
        default: "MATTER",
        description: LIBRARY_DESC,
      },
      documentId: {
        in: "path",
        type: "string",
        required: true,
        description: "문서 ID (예: 'MATTER!12345.1')",
      },
    },
  },

  {
    name: "get_document_activity_history",
    description:
      "특정 문서(documentId)의 활동 이력(Activity History: 열람, 다운로드, 수정, 프린트 등)을 조회합니다.",
    type: "read",
    method: "GET",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/documents/{{documentId}}/history/activities",
    params: {
      libraryName: {
        in: "path",
        type: "string",
        required: false,
        default: "MATTER",
        description: LIBRARY_DESC,
      },
      documentId: {
        in: "path",
        type: "string",
        required: true,
        description: "문서 ID (예: 'MATTER!12345.1')",
      },
    },
  },

  {
    name: "get_document_user_history",
    description:
      "특정 문서(documentId)를 열람/수정한 사용자별 이력(User History)을 조회합니다.",
    type: "read",
    method: "GET",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/documents/{{documentId}}/history/users",
    params: {
      libraryName: {
        in: "path",
        type: "string",
        required: false,
        default: "MATTER",
        description: LIBRARY_DESC,
      },
      documentId: {
        in: "path",
        type: "string",
        required: true,
        description: "문서 ID (예: 'MATTER!12345.1')",
      },
    },
  },

  {
    name: "get_document_highlights",
    description:
      "특정 문서(documentId)에서 키워드 하이라이트(본문 스니펫/미리보기) 정보를 조회합니다.",
    type: "read",
    method: "GET",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/documents/{{documentId}}/highlights",
    params: {
      libraryName: {
        in: "path",
        type: "string",
        required: false,
        default: "MATTER",
        description: LIBRARY_DESC,
      },
      documentId: {
        in: "path",
        type: "string",
        required: true,
        description: "문서 ID (예: 'MATTER!12345.1')",
      },
      keyword: {
        in: "query",
        type: "string",
        required: false,
        description: "하이라이트할 검색 키워드",
      },
    },
  },

  {
    name: "get_document_operations",
    description:
      "현재 로그인한 사용자가 특정 문서(documentId)에 대해 수행할 수 있는 권한/작업 목록(조회, 수정, 다운로드, 체크아웃 가능 여부 등)을 확인합니다.",
    type: "read",
    method: "GET",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/documents/{{documentId}}/operations",
    params: {
      libraryName: {
        in: "path",
        type: "string",
        required: false,
        default: "MATTER",
        description: LIBRARY_DESC,
      },
      documentId: {
        in: "path",
        type: "string",
        required: true,
        description: "문서 ID (예: 'MATTER!12345.1')",
      },
    },
  },

  // ==========================================================================
  // 2. [Workspaces] 사건/자문 워크스페이스 검색, 하위 폴더 및 보안(ACL) 조회
  // ==========================================================================
  {
    name: "search_workspaces",
    description:
      "지정한 라이브러리(MATTER/PRECEDENT/SERVICE/TRAINING/PRIVATE)에서 사건/자문 워크스페이스(Workspace)를 검색합니다. 기본적으로 최근 수정/생성된 최신 워크스페이스 순으로 정렬하여 반환합니다. 사건명(name), 통합검색어(anywhere), 고객코드(custom1), 관리번호(custom2) 등으로 조회합니다.",
    type: "read",
    method: "GET",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/workspaces",
    params: {
      libraryName: {
        in: "path",
        type: "string",
        required: false,
        default: "MATTER",
        description: LIBRARY_DESC,
      },
      name: {
        in: "query",
        type: "string",
        required: false,
        description: "워크스페이스(사건/자문방) 이름 검색어",
      },
      anywhere: {
        in: "query",
        type: "string",
        required: false,
        description: "워크스페이스 통합 검색어",
      },
      custom1: {
        in: "query",
        type: "string",
        required: false,
        description: "Custom1 (고객 ID / Client Code)",
      },
      custom2: {
        in: "query",
        type: "string",
        required: false,
        description: "Custom2 (사건/자문 관리번호 / Matter Code)",
      },
      recentDays: {
        in: "query",
        type: "number",
        required: false,
        description: "최근 N일 이내 활동/수정된 워크스페이스만 필터링할 때 입력",
      },
      from_edit_date: {
        in: "query",
        type: "string",
        required: false,
        description: "이 날짜 이후에 수정된 워크스페이스만 조회 (예: '2025-01-01')",
      },
      sortOrder: {
        in: "query",
        type: "string",
        required: false,
        default: "latest",
        description: SORT_ORDER_DESC,
      },
      limit: {
        in: "query",
        type: "number",
        required: false,
        default: 25,
        description: "최대 조회 건수 (기본값: 25)",
      },
      offset: {
        in: "query",
        type: "number",
        required: false,
        description: "페이징 시작 위치 (0부터 시작)",
      },
    },
  },

  {
    name: "search_all_customer_workspaces",
    description:
      "전체 라이브러리를 대상으로 사건/자문 워크스페이스(Workspace)를 통합 검색하며, 기본적으로 최신 워크스페이스 순으로 정렬하여 반환합니다.",
    type: "read",
    method: "GET",
    path: "/api/v2/customers/{{customerId}}/workspaces",
    params: {
      name: {
        in: "query",
        type: "string",
        required: false,
        description: "워크스페이스(사건/자문방) 이름 검색어",
      },
      anywhere: {
        in: "query",
        type: "string",
        required: false,
        description: "워크스페이스 통합 검색어",
      },
      custom1: {
        in: "query",
        type: "string",
        required: false,
        description: "Custom1 (고객 ID / Client Code)",
      },
      custom2: {
        in: "query",
        type: "string",
        required: false,
        description: "Custom2 (사건/자문 관리번호 / Matter Code)",
      },
      sortOrder: {
        in: "query",
        type: "string",
        required: false,
        default: "latest",
        description: SORT_ORDER_DESC,
      },
      limit: {
        in: "query",
        type: "number",
        required: false,
        default: 25,
        description: "최대 조회 건수 (기본값: 25)",
      },
    },
  },

  {
    name: "get_workspace_detail",
    description:
      "특정 워크스페이스(workspaceId)의 상세 정보 및 iManage 웹 바로가기 링크를 조회합니다.",
    type: "read",
    method: "GET",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/workspaces/{{workspaceId}}",
    params: {
      libraryName: {
        in: "path",
        type: "string",
        required: false,
        default: "MATTER",
        description: LIBRARY_DESC,
      },
      workspaceId: {
        in: "path",
        type: "string",
        required: true,
        description: "워크스페이스 ID (예: 'MATTER!105')",
      },
    },
  },

  {
    name: "get_workspace_children",
    description:
      "특정 워크스페이스(workspaceId) 내부의 1차 하위 폴더(Folders), 탭(Tabs), 검색폴더 목록을 조회합니다.",
    type: "read",
    method: "GET",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/workspaces/{{workspaceId}}/children",
    params: {
      libraryName: {
        in: "path",
        type: "string",
        required: false,
        default: "MATTER",
        description: LIBRARY_DESC,
      },
      workspaceId: {
        in: "path",
        type: "string",
        required: true,
        description: "워크스페이스 ID (예: 'MATTER!105')",
      },
    },
  },

  {
    name: "get_workspace_security",
    description:
      "특정 워크스페이스(workspaceId)에 설정된 보안 권한(ACL: 기본 보안등급, 접근 허용 사용자 및 그룹 권한)을 조회합니다.",
    type: "read",
    method: "GET",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/workspaces/{{workspaceId}}/security",
    params: {
      libraryName: {
        in: "path",
        type: "string",
        required: false,
        default: "MATTER",
        description: LIBRARY_DESC,
      },
      workspaceId: {
        in: "path",
        type: "string",
        required: true,
        description: "워크스페이스 ID",
      },
    },
  },

  {
    name: "get_workspace_nvp",
    description:
      "특정 워크스페이스(workspaceId)의 Name-Value Pairs(NVP) 확장 메타데이터를 조회합니다.",
    type: "read",
    method: "GET",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/workspaces/{{workspaceId}}/name-value-pairs",
    params: {
      libraryName: {
        in: "path",
        type: "string",
        required: false,
        default: "MATTER",
        description: LIBRARY_DESC,
      },
      workspaceId: {
        in: "path",
        type: "string",
        required: true,
        description: "워크스페이스 ID",
      },
    },
  },

  {
    name: "search_workspace_users",
    description:
      "특정 워크스페이스(workspaceId)와 관련된 사용자 목록을 검색합니다.",
    type: "read",
    method: "GET",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/workspaces/{{workspaceId}}/users/search",
    params: {
      libraryName: {
        in: "path",
        type: "string",
        required: false,
        default: "MATTER",
        description: LIBRARY_DESC,
      },
      workspaceId: {
        in: "path",
        type: "string",
        required: true,
        description: "워크스페이스 ID",
      },
    },
  },

  // ==========================================================================
  // 3. [Folders] 폴더 검색, 폴더 내 문서 목록 및 하위 폴더 조회
  // ==========================================================================
  {
    name: "search_folders",
    description:
      "지정한 라이브러리에서 폴더(Folder)를 검색하며, 기본적으로 최신 폴더 순으로 정렬하여 반환합니다.",
    type: "read",
    method: "GET",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/folders",
    params: {
      libraryName: {
        in: "path",
        type: "string",
        required: false,
        default: "MATTER",
        description: LIBRARY_DESC,
      },
      name: {
        in: "query",
        type: "string",
        required: false,
        description: "폴더명 검색어",
      },
      sortOrder: {
        in: "query",
        type: "string",
        required: false,
        default: "latest",
        description: SORT_ORDER_DESC,
      },
      limit: {
        in: "query",
        type: "number",
        required: false,
        default: 25,
        description: "최대 조회 건수",
      },
    },
  },

  {
    name: "get_folder_children",
    description:
      "특정 폴더(folderId) 하위의 서브폴더 및 컨텐츠 목록을 조회합니다.",
    type: "read",
    method: "GET",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/folders/{{folderId}}/children",
    params: {
      libraryName: {
        in: "path",
        type: "string",
        required: false,
        default: "MATTER",
        description: LIBRARY_DESC,
      },
      folderId: {
        in: "path",
        type: "string",
        required: true,
        description: "폴더 ID (예: 'MATTER!204')",
      },
    },
  },

  {
    name: "get_folder_documents",
    description:
      "특정 폴더(folderId) 안에 들어있는 모든 문서(Documents) 목록과 각 문서의 iManage 링크를 조회하며, 기본적으로 최신 수정일(edit_date) 및 최신 문서번호 기준 내림차순으로 정렬하여 반환합니다.",
    type: "read",
    method: "GET",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/folders/{{folderId}}/documents",
    params: {
      libraryName: {
        in: "path",
        type: "string",
        required: false,
        default: "MATTER",
        description: LIBRARY_DESC,
      },
      folderId: {
        in: "path",
        type: "string",
        required: true,
        description: "폴더 ID (예: 'MATTER!204')",
      },
      sortOrder: {
        in: "query",
        type: "string",
        required: false,
        default: "latest",
        description: SORT_ORDER_DESC,
      },
      limit: {
        in: "query",
        type: "number",
        required: false,
        default: 50,
        description: "최대 조회 건수 (기본값: 50)",
      },
    },
  },

  {
    name: "get_folder_security",
    description:
      "특정 폴더(folderId)의 보안 권한(ACL) 설정 정보를 조회합니다.",
    type: "read",
    method: "GET",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/folders/{{folderId}}/security",
    params: {
      libraryName: {
        in: "path",
        type: "string",
        required: false,
        default: "MATTER",
        description: LIBRARY_DESC,
      },
      folderId: {
        in: "path",
        type: "string",
        required: true,
        description: "폴더 ID",
      },
    },
  },

  // ==========================================================================
  // 4. [Customs] 고객 코드(Custom1), 사건/자문 관리번호(Custom2) 등 커스텀 필드 조회
  // ==========================================================================
  {
    name: "get_custom1_recent",
    description:
      "특정 라이브러리에서 최근 사용된 Custom1(고객 코드) 목록을 조회합니다.",
    type: "read",
    method: "GET",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/custom1/recent",
    params: {
      libraryName: {
        in: "path",
        type: "string",
        required: false,
        default: "MATTER",
        description: LIBRARY_DESC,
      },
    },
  },

  {
    name: "get_custom1_detail",
    description:
      "특정 Custom1 코드(custom1Id, 예: 고객번호)의 상세 명칭 및 정보를 조회합니다.",
    type: "read",
    method: "GET",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/custom1/{{custom1Id}}",
    params: {
      libraryName: {
        in: "path",
        type: "string",
        required: false,
        default: "MATTER",
        description: LIBRARY_DESC,
      },
      custom1Id: {
        in: "path",
        type: "string",
        required: true,
        description: "조회할 Custom1 코드 (예: 고객 ID)",
      },
    },
  },

  {
    name: "search_custom2_by_custom1",
    description:
      "특정 Custom1(고객 ID: custom1Id)에 속한 하위 Custom2(사건/자문 관리번호) 목록을 검색합니다.",
    type: "read",
    method: "GET",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/customs/custom1/{{custom1Id}}/custom2/search",
    params: {
      libraryName: {
        in: "path",
        type: "string",
        required: false,
        default: "MATTER",
        description: LIBRARY_DESC,
      },
      custom1Id: {
        in: "path",
        type: "string",
        required: true,
        description: "상위 Custom1 코드 (고객 ID)",
      },
      description: {
        in: "query",
        type: "string",
        required: false,
        description: "Custom2 설명/명칭 검색어",
      },
    },
  },

  {
    name: "search_custom_values",
    description:
      "라이브러리 내 커스텀 테이블(customTable: 'custom1', 'custom2', 'custom3' 등)의 코드 및 설명을 검색합니다.",
    type: "read",
    method: "GET",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/customs/{{customTable}}/search",
    params: {
      libraryName: {
        in: "path",
        type: "string",
        required: false,
        default: "MATTER",
        description: LIBRARY_DESC,
      },
      customTable: {
        in: "path",
        type: "string",
        required: true,
        default: "custom1",
        description: "검색할 커스텀 테이블명 (예: 'custom1', 'custom2')",
      },
      string: {
        in: "query",
        type: "string",
        required: false,
        description: "코드 또는 명칭 통합 검색어",
      },
      description: {
        in: "query",
        type: "string",
        required: false,
        description: "명칭(Description) 검색어",
      },
      limit: {
        in: "query",
        type: "number",
        required: false,
        default: 25,
        description: "최대 조회 건수",
      },
    },
  },

  // ==========================================================================
  // 5. [My Matters & My Favorites] 내 사건 목록 및 내 즐겨찾기 조회
  //    (보안 정책: {{userId}}는 로그인한 본인의 ID로 자동 고정되어 타인 목록 조회 불가)
  // ==========================================================================
  {
    name: "get_my_matters",
    description:
      "현재 로그인한 사용자의 '내 사건(My Matters)' 워크스페이스/폴더 목록을 조회합니다.",
    type: "read",
    method: "GET",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/users/{{userId}}/my-matters/children",
    params: {
      libraryName: {
        in: "path",
        type: "string",
        required: false,
        default: "MATTER",
        description: LIBRARY_DESC,
      },
    },
  },

  {
    name: "get_my_favorites",
    description:
      "현재 로그인한 사용자의 '내 즐겨찾기(My Favorites)' 문서/폴더/워크스페이스 목록을 조회합니다.",
    type: "read",
    method: "GET",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/my-favorites/children",
    params: {
      libraryName: {
        in: "path",
        type: "string",
        required: false,
        default: "MATTER",
        description: LIBRARY_DESC,
      },
    },
  },

  // ==========================================================================
  // 6. [Users / Captions / Trustees] 라이브러리 사용자, 캡션, 권한자 조회
  // ==========================================================================
  {
    name: "search_library_users",
    description:
      "지정한 라이브러리(MATTER/PRECEDENT/SERVICE/TRAINING/PRIVATE)의 사용자(Users) 목록을 조회/검색합니다.",
    type: "read",
    method: "GET",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/users",
    params: {
      libraryName: {
        in: "path",
        type: "string",
        required: false,
        default: "MATTER",
        description: LIBRARY_DESC,
      },
      query: {
        in: "query",
        type: "string",
        required: false,
        description: "사용자 이름 또는 ID 검색어",
      },
      limit: {
        in: "query",
        type: "number",
        required: false,
        default: 25,
        description: "최대 조회 건수",
      },
    },
  },

  {
    name: "get_library_captions",
    description:
      "지정한 라이브러리의 메타데이터 필드 캡션(Captions) 목록을 조회합니다.",
    type: "read",
    method: "GET",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/captions",
    params: {
      libraryName: {
        in: "path",
        type: "string",
        required: false,
        default: "MATTER",
        description: LIBRARY_DESC,
      },
    },
  },

  {
    name: "get_library_trustees",
    description:
      "지정한 라이브러리의 보안 권한자/그룹(Trustees) 목록을 조회합니다.",
    type: "read",
    method: "GET",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/trustees",
    params: {
      libraryName: {
        in: "path",
        type: "string",
        required: false,
        default: "MATTER",
        description: LIBRARY_DESC,
      },
    },
  },

  /*
  // ==========================================================================
  // 🔒 [비활성화됨 - READ 전용 기본 정책]
  // 아래는 Postman Collection에 포함된 생성/수정/삭제/체크아웃(WRITE) API입니다.
  // 필요한 경우 주석을 해제하고 .env에서 ALLOW_WRITE=true로 설정하면 자동 활성화됩니다.
  // ==========================================================================
  {
    name: "patch_document_profile",
    description: "특정 문서(documentId)의 제목(name) 등 메타데이터를 수정합니다.",
    type: "write",
    method: "PATCH",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/documents/{{documentId}}",
    params: {
      libraryName: { in: "path", type: "string", required: false, default: "MATTER", description: LIBRARY_DESC },
      documentId: { in: "path", type: "string", required: true, description: "수정할 문서 ID" },
      name: { in: "body", type: "string", required: true, description: "변경할 문서 제목" },
    },
  },
  {
    name: "checkout_document",
    description: "특정 문서(documentId)를 체크아웃합니다.",
    type: "write",
    method: "POST",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/documents/{{documentId}}/checkout",
    params: {
      libraryName: { in: "path", type: "string", required: false, default: "MATTER", description: LIBRARY_DESC },
      documentId: { in: "path", type: "string", required: true, description: "체크아웃할 문서 ID" },
      appname: { in: "body", type: "string", required: false, default: "MCP", description: "애플리케이션명" },
      comments: { in: "body", type: "string", required: false, description: "체크아웃 코멘트" },
    },
  },
  {
    name: "remove_document_lock",
    description: "특정 문서(documentId)의 체크아웃/잠금을 해제합니다.",
    type: "write",
    method: "DELETE",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/documents/{{documentId}}/lock",
    params: {
      libraryName: { in: "path", type: "string", required: false, default: "MATTER", description: LIBRARY_DESC },
      documentId: { in: "path", type: "string", required: true, description: "잠금 해제할 문서 ID" },
    },
  },
  {
    name: "create_my_favorites_shortcut",
    description: "특정 문서나 폴더를 내 즐겨찾기(My Favorites)에 바로가기로 추가합니다.",
    type: "write",
    method: "POST",
    path: "/api/v2/customers/{{customerId}}/libraries/{{libraryName}}/my-favorites/shortcuts",
    params: {
      libraryName: { in: "path", type: "string", required: false, default: "MATTER", description: LIBRARY_DESC },
      id: { in: "body", type: "string", required: true, description: "대상 문서/폴더 ID" },
      name: { in: "body", type: "string", required: true, description: "바로가기 표시 이름" },
    },
  },
  */
];

