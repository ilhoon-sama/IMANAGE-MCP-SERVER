import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function verifyImanageLiveConnection() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["server.js"],
  });

  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);
  console.log("1. MCP 서버 연결 성공!");

  // 2. iManage 실제 서버 연결 및 로그인/Discovery 테스트
  console.log("2. test_imanage_connection 호출 중 (https://dm.shinkim.com)...");
  const connRes = await client.callTool({
    name: "test_imanage_connection",
    arguments: {},
  });
  console.log("👉 연결 결과:\n", connRes.content?.[0]?.text);

  // 3. 최근 문서 조회 테스트 (MATTER 라이브러리)
  if (!connRes.isError) {
    console.log("\n3. get_recent_documents (MATTER 라이브러리) 호출 중...");
    const recentRes = await client.callTool({
      name: "get_recent_documents",
      arguments: { libraryName: "MATTER", limit: 3 },
    });
    console.log("👉 최근 문서 조회 결과:\n", recentRes.content?.[0]?.text);
  }

  await client.close();
}

verifyImanageLiveConnection().catch((err) => {
  console.error("테스트 실패:", err);
  process.exit(1);
});
