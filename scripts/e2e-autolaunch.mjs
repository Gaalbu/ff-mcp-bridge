// Fully automatic path: no Firefox running, no token configured. The MCP server must open Firefox
// (headless here), the extension must auto-pair, and the first tool call must just work.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ff-mcp-autolaunch-"));
const client = new Client({ name: "e2e-auto", version: "0" });
await client.connect(
  new StdioClientTransport({
    command: "node",
    args: [path.join(root, "server", "src", "index.js")],
    // Default port: a fresh profile has no port setting, so the extension only knows 8765.
    env: { ...process.env, FF_MCP_PORT: "8765", FF_MCP_PROFILE: profile, FF_MCP_HEADLESS: "1" },
    stderr: "inherit",
  }),
);

let failed = false;
try {
  const t0 = Date.now();
  const res = await client.callTool({ name: "tabs_context", arguments: {} }, undefined, { timeout: 120000 });
  const text = res.content.map((c) => c.text ?? "").join("\n");
  if (res.isError || !text.includes("tabId")) throw new Error(`tabs_context falhou: ${text}`);
  console.log(`PASS  primeira chamada abriu o Firefox e funcionou (${Math.round((Date.now() - t0) / 1000)}s)`);

  const created = await client.callTool({ name: "tabs_create", arguments: { url: "https://example.com" } });
  const tabId = JSON.parse(created.content[0].text).tabId;
  const page = await client.callTool({ name: "get_page_text", arguments: { tabId } });
  if (!/documentation examples|Example Domain/.test(page.content[0].text)) throw new Error(page.content[0].text);
  console.log("PASS  navegação e leitura de página após o auto-launch");
} catch (err) {
  failed = true;
  console.log(`FAIL  ${err.message}`);
} finally {
  await client.close().catch(() => {});
}
process.exit(failed ? 1 : 0);
