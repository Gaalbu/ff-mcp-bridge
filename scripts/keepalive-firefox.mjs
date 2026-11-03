// Starts headless Firefox with the extension configured (token + port) and keeps it alive.
// Used to test the real `claude mcp add` flow: run this, then use Claude Code with the registered server.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Builder } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { loadOrCreateToken } from "../server/src/config.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.FF_MCP_PORT) || 8765;
const UUID = "22222222-2222-4222-8222-222222222222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const options = new firefox.Options()
  .addArguments("-headless")
  .setPreference("extensions.webextensions.uuids", JSON.stringify({ "ff-mcp-bridge@local": UUID }));
const driver = await new Builder().forBrowser("firefox").setFirefoxOptions(options).build();
const stop = async () => {
  await driver.quit().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

await driver.installAddon(path.join(root, "extension"), true);
const before = await driver.getAllWindowHandles();
driver.setContext(firefox.Context.CHROME);
await driver.executeScript(
  `gBrowser.selectedTab = gBrowser.addTab(arguments[0], {
     triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`,
  `moz-extension://${UUID}/options.html`,
);
driver.setContext(firefox.Context.CONTENT);
await sleep(1000);
const after = await driver.getAllWindowHandles();
await driver.switchTo().window(after.find((h) => !before.includes(h)));
await driver.executeScript(
  `document.getElementById("token").value = arguments[0];
   document.getElementById("port").value = arguments[1];
   document.getElementById("save").click();`,
  loadOrCreateToken(),
  PORT,
);
// Leave a normal tab open so "active tab" resolves to a scriptable page.
await driver.switchTo().newWindow("tab");
await driver.get("https://example.com");
console.log(`READY: Firefox headless com a extensão (porta ${PORT}). Ctrl+C para encerrar.`);
setInterval(() => {}, 1 << 30); // keep the event loop alive until SIGINT/SIGTERM
