// End-to-end test: headless Firefox (Selenium) + the real extension + a real MCP client over stdio.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Builder } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadOrCreateToken } from "../server/src/config.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 18765;
const WEB_PORT = 18080;
const EXT_UUID = "11111111-1111-4111-8111-111111111111";
const token = loadOrCreateToken();

const results = [];
async function check(name, fn) {
  try {
    const note = await fn();
    results.push([name, true]);
    console.log(`PASS  ${name}${note ? ` -> ${note}` : ""}`);
  } catch (err) {
    results.push([name, false]);
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- local test site
const web = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  res.setHeader("content-type", "text/html; charset=utf-8");
  if (u.pathname === "/next") return res.end("<title>Next</title><h1>Segunda página</h1>");
  if (u.searchParams.has("q")) {
    return res.end(`<title>Resultados</title><h1>Resultados para ${u.searchParams.get("q")}</h1>`);
  }
  res.end(`<title>Home</title><h1>Olá</h1>
    <a href="/next">More information</a>
    <form action="/" method="get"><input name="q" placeholder="Buscar" aria-label="Buscar"><button type="submit">Ir</button></form>
    <script>console.log("hello-from-page"); console.error("erro-de-teste");</script>`);
});
await new Promise((r) => web.listen(WEB_PORT, "127.0.0.1", r));
const base = `http://127.0.0.1:${WEB_PORT}`;

// ---- MCP client
let client;
async function startClient() {
  client = new Client({ name: "e2e", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: "node",
      args: [path.join(root, "server", "src", "index.js")],
      env: { ...process.env, FF_MCP_PORT: String(PORT) },
      stderr: "ignore",
    }),
  );
}
async function tool(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return { ...res, text };
}
async function waitConnected(timeoutMs = 40000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await tool("tabs_context");
    if (!r.isError) return r;
    await sleep(500);
  }
  throw new Error("extensão não conectou a tempo");
}

await startClient();

// ---- Firefox
const options = new firefox.Options()
  .addArguments("-headless")
  .setPreference("extensions.webextensions.uuids", JSON.stringify({ "ff-mcp-bridge@local": EXT_UUID }));
const driver = await new Builder().forBrowser("firefox").setFirefoxOptions(options).build();

try {
  await driver.installAddon(path.join(root, "extension"), true);
  // Marionette refuses to navigate to moz-extension:// URLs, so open the tab from the chrome context.
  const before = await driver.getAllWindowHandles();
  driver.setContext(firefox.Context.CHROME);
  await driver.executeScript(
    `gBrowser.selectedTab = gBrowser.addTab(arguments[0], {
       triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`,
    `moz-extension://${EXT_UUID}/options.html`,
  );
  driver.setContext(firefox.Context.CONTENT);
  await sleep(1000);
  const after = await driver.getAllWindowHandles();
  await driver.switchTo().window(after.find((h) => !before.includes(h)));
  await driver.executeScript(
    `document.getElementById("token").value = arguments[0];
     document.getElementById("port").value = arguments[1];
     document.getElementById("save").click();`,
    token,
    PORT,
  );

  await check("extensão conecta ao servidor (tabs_context)", async () => {
    const r = await waitConnected();
    ok(r.text.includes("tabId"), "sem tabs na resposta");
  });

  let tabId;
  await check("tabs_create + navigate (site local)", async () => {
    const created = await tool("tabs_create", { url: base });
    tabId = JSON.parse(created.text).tabId;
    const nav = await tool("navigate", { url: base, tabId });
    ok(!nav.isError && nav.text.includes("Home"), nav.text);
  });

  await check("read_page devolve refs", async () => {
    const r = await tool("read_page", { tabId, filter: "interactive" });
    ok(/\[ref_\d+\]/.test(r.text) && r.text.includes("More information"), r.text);
  });

  await check("get_page_text", async () => {
    const r = await tool("get_page_text", { tabId });
    ok(r.text.includes("Olá"), r.text);
  });

  let linkRef;
  await check("find acha o link", async () => {
    const r = await tool("find", { query: "more information", tabId });
    const m = r.text.match(/\[(ref_\d+)\]/);
    ok(m, r.text);
    linkRef = m[1];
  });

  await check("screenshot devolve imagem", async () => {
    const res = await client.callTool({ name: "computer", arguments: { action: "screenshot", tabId } });
    const img = res.content.find((c) => c.type === "image");
    ok(img && img.data.length > 1000, JSON.stringify(res).slice(0, 200));
    return `${img.mimeType}, ${Math.round(img.data.length / 1024)} KB b64`;
  });

  await check("left_click no link navega", async () => {
    const c = await tool("computer", { action: "left_click", ref: linkRef, tabId });
    ok(!c.isError, c.text);
    await sleep(1500);
    const t = await tool("get_page_text", { tabId });
    ok(t.text.includes("Segunda página"), t.text);
  });

  await check("formulário: form_input + Enter", async () => {
    await tool("navigate", { url: base, tabId });
    const f = await tool("find", { query: "Buscar", tabId });
    const ref = f.text.match(/textbox.*\[(ref_\d+)\]/)?.[1];
    ok(ref, f.text);
    const click = await tool("computer", { action: "left_click", ref, tabId });
    ok(!click.isError, click.text);
    const typed = await tool("computer", { action: "type", text: "firefox", tabId });
    ok(!typed.isError, typed.text);
    const key = await tool("computer", { action: "key", text: "Enter", tabId });
    ok(!key.isError, key.text);
    await sleep(1500);
    const t = await tool("get_page_text", { tabId });
    ok(t.text.includes("Resultados para firefox"), t.text);
  });

  await check("scroll", async () => {
    const r = await tool("computer", { action: "scroll", coordinate: [100, 100], scroll_direction: "down", scroll_amount: 2, tabId });
    ok(!r.isError, r.text);
  });

  await check("javascript_tool (content e page)", async () => {
    const a = await tool("javascript_tool", { text: "1 + 2", tabId });
    ok(a.text === "3", a.text);
    const b = await tool("javascript_tool", { text: "const x = await Promise.resolve(40); x + 2", tabId });
    ok(b.text === "42", b.text);
    const c = await tool("javascript_tool", { text: "document.title", world: "page", tabId });
    ok(c.text.includes("Resultados"), c.text);
  });

  await check("read_console_messages", async () => {
    await tool("navigate", { url: base, tabId });
    const r = await tool("read_console_messages", { tabId });
    ok(r.text.includes("hello-from-page") && r.text.includes("erro-de-teste"), r.text);
  });

  await check("read_network_requests", async () => {
    const r = await tool("read_network_requests", { tabId });
    ok(r.text.includes("127.0.0.1"), r.text);
  });

  await check("site externo: example.com, ler, screenshot e clicar no link", async () => {
    const created = await tool("tabs_create", { url: "https://example.com" });
    const id = JSON.parse(created.text).tabId;
    const page = await tool("read_page", { tabId: id, filter: "interactive" });
    ok(page.text.includes("Example Domain") || /link/.test(page.text), page.text);
    const shot = await client.callTool({ name: "computer", arguments: { action: "screenshot", tabId: id } });
    ok(shot.content.some((c) => c.type === "image"), "sem imagem");
    const ref = page.text.match(/link.*\[(ref_\d+)\]/)?.[1];
    ok(ref, page.text);
    await tool("computer", { action: "left_click", ref, tabId: id });
    await sleep(3000);
    const ctx = JSON.parse((await tool("tabs_context")).text).find((t) => t.tabId === id);
    ok(/iana\.org/.test(ctx.url), ctx.url);
    await tool("tabs_close", { tabId: id });
    return ctx.url;
  });

  await check("página restrita devolve erro amigável sem travar", async () => {
    const [{ tabId: optTab }] = JSON.parse((await tool("tabs_context")).text).filter((t) => t.url.startsWith("moz-extension:"));
    const t0 = Date.now();
    const r = await tool("read_page", { tabId: optTab });
    ok(r.isError && r.text.includes("URL restrita do Firefox"), r.text);
    ok(Date.now() - t0 < 5000, "demorou demais");
  });

  await check("tabs_close", async () => {
    const r = await tool("tabs_close", { tabId });
    ok(!r.isError, r.text);
  });

  await check("reconexão após reiniciar o servidor", async () => {
    await client.close();
    await sleep(500);
    await startClient();
    await waitConnected(60000);
  });
} finally {
  await driver.quit().catch(() => {});
  await client.close().catch(() => {});
  web.close();
}

const failed = results.filter(([, o]) => !o).length;
console.log(`\n${results.length - failed}/${results.length} passaram`);
process.exit(failed ? 1 : 0);
