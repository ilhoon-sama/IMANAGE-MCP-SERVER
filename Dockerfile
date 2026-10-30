FROM node:20-alpine

# 타임존(Asia/Seoul) 및 사내 SSL 인증서 체인 인식을 위한 기본 패키지 설치
RUN apk add --no-cache ca-certificates tzdata
ENV TZ=Asia/Seoul
ENV NODE_ENV=production

WORKDIR /app

# 의존성 패키지 먼저 복사 후 설치 (Docker 레이어 캐싱 최적화)
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# 소스 코드 복사
COPY server.js imanage-client.js apis.js crypto-helper.js ./

# 영구 데이터(암호화 키, 다운로드 파일) 디렉터리 생성
RUN mkdir -p /app/data /app/downloads

# MCP Streamable HTTP 포트 노출
EXPOSE 3001

# 컨테이너 자체 상태 점검 (/health 엔드포인트)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/health || exit 1

# HTTP 서버 모드로 실행
CMD ["node", "server.js", "--http"]
