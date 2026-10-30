import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const ENC_PREFIX = "enc:";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 프로젝트 폴더 외부(사용자 홈 디렉터리)를 우선 사용하되, 권한 제한 환경에서는 로컬 키 파일로 자동 폴백
function resolveKeyFilePath() {
  if (process.env.MCP_SECRET_KEY_PATH) {
    const customKeyPath = path.resolve(process.env.MCP_SECRET_KEY_PATH);
    if (!fs.existsSync(customKeyPath)) {
      fs.mkdirSync(path.dirname(customKeyPath), { recursive: true });
      const rawSecret = crypto.randomBytes(32).toString("hex");
      fs.writeFileSync(customKeyPath, rawSecret, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
    return customKeyPath;
  }
  const homeKeyPath = path.join(os.homedir(), ".imanage-mcp-secret.key");
  const localKeyPath = path.join(__dirname, ".imanage-mcp-secret.key");

  if (fs.existsSync(homeKeyPath)) return homeKeyPath;
  if (fs.existsSync(localKeyPath)) return localKeyPath;

  try {
    const rawSecret = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(homeKeyPath, rawSecret, { encoding: "utf8", mode: 0o600 });
    return homeKeyPath;
  } catch {
    const rawSecret = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(localKeyPath, rawSecret, { encoding: "utf8", mode: 0o600 });
    return localKeyPath;
  }
}

/**
 * 서버 전용 AES-256 키 로드 (없으면 자동 생성)
 */
function getDerivedKey() {
  const keyFilePath = resolveKeyFilePath();
  const rawSecret = fs.readFileSync(keyFilePath, "utf8").trim();

  const machineSalt =
    process.env.MCP_MACHINE_SALT ||
    `${os.hostname()}_${os.userInfo().username}_imanage_mcp`;
  return crypto.scryptSync(rawSecret, machineSalt, 32);
}

/**
 * 평문 문자열(비밀번호/시크릿/토큰)을 AES-256-GCM으로 암호화 ("enc:iv:tag:cipher" 형식)
 */
export function encryptSecret(plainText) {
  if (!plainText || plainText.startsWith(ENC_PREFIX)) {
    return plainText;
  }
  const key = getDerivedKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plainText, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${ENC_PREFIX}${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * 암호화된 문자열("enc:...")을 메모리 상에서 복호화
 */
export function decryptSecret(value) {
  if (!value) return "";
  if (!value.startsWith(ENC_PREFIX)) {
    return value;
  }

  const parts = value.slice(ENC_PREFIX.length).split(":");
  if (parts.length !== 3) {
    throw new Error("암호화된 시크릿(enc:...) 형식이 올바르지 않습니다.");
  }

  const [ivHex, authTagHex, encryptedHex] = parts;
  const key = getDerivedKey();
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

/**
 * .env 파일에서 특정 키의 원본 값을 직접 읽어옵니다.
 * (비밀번호에 '#' 특수문자가 포함된 경우 dotenv가 주석으로 오인하여 잘라버리는 현상 방지)
 */
function readRawEnvValueFromFile(envFilePath, envKeyName) {
  if (!fs.existsSync(envFilePath)) return null;
  const content = fs.readFileSync(envFilePath, "utf8");
  const match = content.match(new RegExp(`^${envKeyName}=(.*)$`, "m"));
  if (!match) return null;
  let val = match[1].trim();
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    val = val.slice(1, -1);
  }
  return val;
}

/**
 * .env 파일 내 지정된 환경변수(IMANAGE_CLIENT_SECRET, IMANAGE_PASSWORD 등)가
 * 평문이면 즉시 암호문(enc:...)으로 치환 저장하고, 복호화된 실제 값을 반환합니다.
 */
export function resolveAndProtectEnvSecret(envFilePath, envKeyName) {
  const rawFromFile = readRawEnvValueFromFile(envFilePath, envKeyName);
  const currentVal = (
    rawFromFile !== null ? rawFromFile : process.env[envKeyName] || ""
  ).trim();

  if (
    !currentVal ||
    currentVal === "your_client_secret" ||
    currentVal === "your_password"
  ) {
    return currentVal;
  }

  // 이미 암호화되어 있는 경우 복호화하여 반환
  if (currentVal.startsWith(ENC_PREFIX)) {
    return decryptSecret(currentVal);
  }

  // 평문인 경우 암호화 수행 후 .env 파일 내 평문을 암호문으로 자동 교체
  const encryptedVal = encryptSecret(currentVal);
  if (fs.existsSync(envFilePath)) {
    const content = fs.readFileSync(envFilePath, "utf8");
    const regex = new RegExp(`^${envKeyName}=.*$`, "m");
    if (regex.test(content)) {
      const updatedContent = content.replace(
        regex,
        `${envKeyName}=${encryptedVal}`
      );
      fs.writeFileSync(envFilePath, updatedContent, "utf8");
    }
  }
  process.env[envKeyName] = encryptedVal;
  return currentVal;
}
