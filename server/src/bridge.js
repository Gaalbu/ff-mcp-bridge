import crypto from "node:crypto";
import http from "node:http";
import { WebSocketServer } from "ws";

export const NOT_CONNECTED_MESSAGE =
  "Extensão Firefox não conectada. Abra o Firefox com a extensão ff-mcp-bridge instalada e o token configurado.";

const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_REPLACED = 4000;

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export class Bridge {
  constructor({ port, token, host = "127.0.0.1", timeoutMs = 30000, log = console.error } = {}) {
    this.port = port;
    this.token = token;
    this.host = host;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.wss = null;
    this.client = null;
    this.pending = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.http = http.createServer((req, res) => this.#onHttp(req, res));
      this.wss = new WebSocketServer({ server: this.http, maxPayload: 64 * 1024 * 1024 });
      this.wss.on("connection", (ws, req) => this.#onConnection(ws, req));
      this.http.once("listening", resolve);
      this.http.once("error", reject);
      this.http.listen(this.port, this.host);
    });
  }

  stop() {
    this.#rejectAll(new Error("Bridge encerrada."));
    return new Promise((resolve) => {
      if (!this.wss) return resolve();
      for (const c of this.wss.clients) c.terminate();
      this.wss.close(() => this.http.close(() => resolve()));
    });
  }

  // Resolves true as soon as an extension is connected, or false after timeoutMs.
  async waitConnected(timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (this.connected) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return this.connected;
  }

  // Auto-pairing: only a moz-extension:// origin on a loopback Host header gets the token.
  // It is a POST because Firefox omits Origin on same-origin-privileged GETs from extensions but sends it on POST.
  // Web pages send their own Origin (and the response has no CORS headers), so they cannot read it.
  #onHttp(req, res) {
    const host = req.headers.host ?? "";
    const origin = req.headers.origin ?? "";
    const hostOk = host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`;
    if (req.method === "POST" && req.url === "/pair" && hostOk && origin.startsWith("moz-extension://")) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ token: this.token }));
      return;
    }
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("forbidden");
  }

  get connected() {
    return !!this.client && this.client.readyState === 1;
  }

  #onConnection(ws, req) {
    let token = "";
    try {
      token = new URL(req.url, "http://localhost").searchParams.get("token") ?? "";
    } catch {
      // malformed URL -> empty token
    }
    const origin = req.headers.origin ?? "";
    if (!safeEqual(token, this.token) || !origin.startsWith("moz-extension://")) {
      this.log(`[ff-mcp-bridge] conexão rejeitada (origin=${origin || "-"})`);
      ws.close(CLOSE_UNAUTHORIZED, "unauthorized");
      return;
    }

    if (this.client && this.client !== ws) {
      this.#rejectAll(new Error("Extensão substituída por uma nova conexão."));
      this.client.close(CLOSE_REPLACED, "replaced");
    }
    this.client = ws;
    this.log("[ff-mcp-bridge] extensão conectada");

    ws.on("message", (data) => this.#onMessage(data));
    ws.on("close", () => {
      if (this.client === ws) {
        this.client = null;
        this.#rejectAll(new Error("Extensão Firefox desconectou durante a requisição."));
        this.log("[ff-mcp-bridge] extensão desconectada");
      }
    });
    ws.on("error", (err) => this.log(`[ff-mcp-bridge] erro no socket: ${err.message}`));
  }

  #onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const entry = this.pending.get(msg?.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error !== undefined) entry.reject(new Error(String(msg.error)));
    else entry.resolve(msg.result);
  }

  #rejectAll(err) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this.pending.delete(id);
    }
  }

  request(method, params = {}, timeoutMs = this.timeoutMs) {
    if (!this.connected) return Promise.reject(new Error(NOT_CONNECTED_MESSAGE));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Tempo esgotado (${Math.round(timeoutMs / 1000)}s) aguardando resposta da extensão para "${method}".`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.client.send(JSON.stringify({ id, method, params }), (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }
}
