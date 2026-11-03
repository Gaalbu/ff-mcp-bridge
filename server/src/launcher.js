import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function findWebExt() {
  for (const candidate of [
    path.join(ROOT, "node_modules", "web-ext", "bin", "web-ext.js"),
    path.join(ROOT, "server", "node_modules", "web-ext", "bin", "web-ext.js"),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Starts Firefox with the extension loaded (via web-ext) in a persistent dedicated profile.
// Firefox is left running when this server exits, so logins and tabs survive.
export class FirefoxLauncher {
  constructor({ profileDir, log = console.error }) {
    this.profileDir = profileDir;
    this.log = log;
    this.launched = false;
  }

  launchOnce() {
    if (this.launched) return false;
    const webExt = findWebExt();
    if (!webExt) {
      this.log("[ff-mcp-bridge] web-ext não encontrado; rode npm install. Abra o Firefox manualmente.");
      return false;
    }
    this.launched = true;
    const args = [
      webExt, "run",
      "--source-dir", path.join(ROOT, "extension"),
      "--firefox-profile", this.profileDir,
      "--profile-create-if-missing",
      "--keep-profile-changes",
      "--no-reload",
      "--no-input",
    ];
    if (process.env.FF_MCP_FIREFOX) args.push("--firefox", process.env.FF_MCP_FIREFOX);
    if (process.env.FF_MCP_HEADLESS === "1") args.push("--arg=-headless");
    this.log(`[ff-mcp-bridge] abrindo Firefox (perfil: ${this.profileDir})`);
    const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", (err) => this.log(`[ff-mcp-bridge] falha ao abrir o Firefox: ${err.message}`));
    child.unref();
    return true;
  }
}
