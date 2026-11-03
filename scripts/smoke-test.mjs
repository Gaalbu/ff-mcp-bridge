// Tests the bridge without Firefox, using a fake WebSocket extension.
import assert from "node:assert/strict";
import http from "node:http";
import WebSocket from "ws";
import { Bridge, NOT_CONNECTED_MESSAGE } from "../server/src/bridge.js";

const PORT = 20000 + Math.floor(Math.random() * 20000);
const TOKEN = "smoke-test-token";
const bridge = new Bridge({ port: PORT, token: TOKEN, timeoutMs: 30000, log: () => {} });
await bridge.start();

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push([name, true]);
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push([name, false]);
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

function connect(token, origin) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${token}`, { origin });
  return new Promise((resolve, reject) => {
    ws.on("error", reject);
    ws.on("open", () => resolve({ ws, closed: new Promise((r) => ws.on("close", (code) => r(code))) }));
  });
}

await check("sem extensão, erro claro", async () => {
  await assert.rejects(bridge.request("tabs_context"), (e) => e.message === NOT_CONNECTED_MESSAGE);
});

await check("token errado é rejeitado (4401)", async () => {
  const { closed } = await connect("wrong", "moz-extension://x");
  assert.equal(await closed, 4401);
});

await check("Origin http:// é rejeitado (4401)", async () => {
  const { closed } = await connect(TOKEN, "http://evil.example");
  assert.equal(await closed, 4401);
});

function getPair({ origin, host = `127.0.0.1:${PORT}` }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ method: "POST", host: "127.0.0.1", port: PORT, path: "/pair", headers: { host, ...(origin ? { origin } : {}) } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

await check("/pair entrega o token só para moz-extension://", async () => {
  const good = await getPair({ origin: "moz-extension://abc" });
  assert.equal(good.status, 200);
  assert.equal(JSON.parse(good.body).token, TOKEN);
  assert.equal((await getPair({ origin: "https://evil.example" })).status, 403);
  assert.equal((await getPair({})).status, 403);
  assert.equal((await getPair({ origin: "moz-extension://abc", host: "evil.example" })).status, 403);
});

await check("waitConnected expira sem extensão", async () => {
  assert.equal(await bridge.waitConnected(300), false);
});

let ext;
await check("conexão válida responde tabs_context", async () => {
  ext = (await connect(TOKEN, "moz-extension://x")).ws;
  ext.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.method === "tabs_context") {
      ext.send(JSON.stringify({ id: msg.id, result: [{ tabId: 1, title: "t", url: "https://example.com", active: true, windowId: 1 }] }));
    } else if (msg.method === "boom") {
      ext.send(JSON.stringify({ id: msg.id, error: "falhou de propósito" }));
    }
    // any other method: stay silent to exercise the timeout
  });
  const res = await bridge.request("tabs_context");
  assert.equal(res[0].tabId, 1);
});

await check("erro da extensão é propagado", async () => {
  await assert.rejects(bridge.request("boom"), /falhou de propósito/);
});

await check("requisição expira com mensagem clara", async () => {
  await assert.rejects(bridge.request("silent", {}, 300), /Tempo esgotado.*silent/);
});

await check("desconexão rejeita pendentes e limpa o Map", async () => {
  const p = bridge.request("silent", {}, 5000);
  ext.close();
  await assert.rejects(p, /desconectou/);
  assert.equal(bridge.pending.size, 0);
});

await bridge.stop();
const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passaram`);
process.exit(failed ? 1 : 0);
