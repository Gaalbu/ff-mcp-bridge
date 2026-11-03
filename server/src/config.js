import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const HOST = "127.0.0.1";
export const PORT = Number(process.env.FF_MCP_PORT) || 8765;
export const TOKEN_DIR = path.join(os.homedir(), ".ff-mcp-bridge");
export const TOKEN_PATH = path.join(TOKEN_DIR, "token");

// Reuses the stored token, or creates a new 32-byte hex one on first start.
export function loadOrCreateToken(tokenPath = TOKEN_PATH) {
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // no token yet
  }
  const token = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, token + "\n", { mode: 0o600 });
  return token;
}
