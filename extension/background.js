"use strict";

const RESTRICTED_MESSAGE = "Esta página não permite scripts (URL restrita do Firefox)";
const NAV_TIMEOUT_MS = 30000;
const MAX_NET_ENTRIES = 500;

// ---------------------------------------------------------------- badge

function setBadge(on) {
  browser.browserAction.setBadgeText({ text: on ? "ON" : "OFF" });
  browser.browserAction.setBadgeBackgroundColor({ color: on ? "#2e9d4f" : "#c0392b" });
}

browser.browserAction.onClicked.addListener(() => browser.runtime.openOptionsPage());

// ---------------------------------------------------------------- tabs

function isRestrictedUrl(url) {
  if (!url) return true;
  if (/^(about|moz-extension|view-source|resource|chrome|data|blob|file):/i.test(url) && !/^file:/i.test(url)) return true;
  try {
    const u = new URL(url);
    if (u.hostname === "addons.mozilla.org") return true;
  } catch {
    return true;
  }
  return false;
}

async function resolveTab(tabId) {
  if (typeof tabId === "number") return browser.tabs.get(tabId);
  let [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) [tab] = await browser.tabs.query({ active: true });
  if (!tab) throw new Error("Nenhuma aba ativa encontrada.");
  return tab;
}

async function callContent(tab, method, params) {
  if (isRestrictedUrl(tab.url)) throw new Error(RESTRICTED_MESSAGE);
  const send = () => browser.tabs.sendMessage(tab.id, { ffmcp: true, method, params });
  let res;
  try {
    res = await send();
  } catch {
    // Tab was open before the extension loaded: inject the content script on demand.
    try {
      await browser.tabs.executeScript(tab.id, { file: "content.js" });
      res = await send();
    } catch {
      throw new Error(RESTRICTED_MESSAGE);
    }
  }
  if (!res) throw new Error(RESTRICTED_MESSAGE);
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

function waitForLoad(tabId) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let sawLoading = false;
    const finish = (fn, arg) => {
      clearTimeout(timeout);
      clearInterval(poll);
      browser.tabs.onUpdated.removeListener(onUpdated);
      fn(arg);
    };
    const onUpdated = (id, info) => {
      if (id !== tabId) return;
      if (info.status === "loading") sawLoading = true;
      if (info.status === "complete") finish(resolve);
    };
    const timeout = setTimeout(
      () => finish(reject, new Error(`Tempo esgotado (30s) esperando a página carregar.`)),
      NAV_TIMEOUT_MS,
    );
    // Same-document navigations (hash changes) may never emit status events.
    const poll = setInterval(async () => {
      try {
        const t = await browser.tabs.get(tabId);
        if (t.status === "complete" && (sawLoading || Date.now() - started > 1500)) finish(resolve);
      } catch (err) {
        finish(reject, err);
      }
    }, 250);
    browser.tabs.onUpdated.addListener(onUpdated);
  });
}

async function tabInfo(tabId) {
  const t = await browser.tabs.get(tabId);
  return { url: t.url, title: t.title };
}

// ---------------------------------------------------------------- network log

const netLog = new Map();

function logNet(details, status) {
  if (details.tabId < 0) return;
  let list = netLog.get(details.tabId);
  if (!list) netLog.set(details.tabId, (list = []));
  list.push({ method: details.method, url: details.url, status, type: details.type });
  if (list.length > MAX_NET_ENTRIES) list.shift();
}

browser.webRequest.onCompleted.addListener((d) => logNet(d, d.statusCode), { urls: ["<all_urls>"] });
browser.webRequest.onErrorOccurred.addListener((d) => logNet(d, d.error || "error"), { urls: ["<all_urls>"] });
browser.tabs.onRemoved.addListener((id) => netLog.delete(id));

// ---------------------------------------------------------------- screenshot

async function screenshot(tab) {
  if (isRestrictedUrl(tab.url)) throw new Error(RESTRICTED_MESSAGE);
  if (!tab.active) {
    await browser.tabs.update(tab.id, { active: true });
    await new Promise((r) => setTimeout(r, 200));
  }
  const vp = await callContent(tab, "viewport", {});
  const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());

  // Scale to CSS px so image coordinates equal click coordinates.
  const width = vp.width;
  const height = Math.round((bitmap.height * width) / bitmap.width);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);

  let out = canvas.toDataURL("image/png");
  let mimeType = "image/png";
  if (out.length > 1.5 * 1024 * 1024 * 1.37) {
    out = canvas.toDataURL("image/jpeg", 0.8);
    mimeType = "image/jpeg";
  }
  return { content: [{ type: "image", data: out.split(",")[1], mimeType }] };
}

// ---------------------------------------------------------------- method router

const handlers = {
  async tabs_context() {
    const tabs = await browser.tabs.query({});
    return tabs.map((t) => ({ tabId: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId }));
  },

  async tabs_create({ url }) {
    const tab = await browser.tabs.create(url ? { url } : {});
    if (url) {
      try {
        await waitForLoad(tab.id);
      } catch {
        // Return the tab id anyway; the page may still be loading.
      }
    }
    return { tabId: tab.id };
  },

  async tabs_close({ tabId }) {
    await browser.tabs.remove(tabId);
    return "ok";
  },

  async navigate({ url, tabId }) {
    const tab = await resolveTab(tabId);
    if (url === "back" || url === "forward") {
      const loaded = waitForLoad(tab.id);
      await (url === "back" ? browser.tabs.goBack(tab.id) : browser.tabs.goForward(tab.id));
      await loaded;
    } else {
      const loaded = waitForLoad(tab.id);
      await browser.tabs.update(tab.id, { url });
      await loaded;
    }
    return tabInfo(tab.id);
  },

  async read_network_requests({ limit = 50, urlPattern, tabId }) {
    const tab = await resolveTab(tabId);
    let list = netLog.get(tab.id) || [];
    if (urlPattern) list = list.filter((e) => e.url.includes(urlPattern));
    return list.slice(-limit);
  },

  async computer(params) {
    const tab = await resolveTab(params.tabId);
    if (params.action === "screenshot") return screenshot(tab);
    return callContent(tab, "computer", params);
  },
};

for (const method of [
  "read_page",
  "find",
  "get_page_text",
  "form_input",
  "javascript_tool",
  "read_console_messages",
]) {
  handlers[method] = async (params) => callContent(await resolveTab(params.tabId), method, params);
}

// ---------------------------------------------------------------- websocket connection

let ws = null;
let attempt = 0;
let reconnectTimer = null;

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  const delay = Math.min(1000 * 2 ** attempt, 15000);
  attempt += 1;
  reconnectTimer = setTimeout(connect, delay);
}

async function onMessage(event) {
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch {
    return;
  }
  const reply = (payload) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: msg.id, ...payload }));
  };
  const handler = handlers[msg.method];
  if (!handler) return reply({ error: `Método desconhecido: ${msg.method}` });
  try {
    reply({ result: await handler(msg.params || {}) });
  } catch (err) {
    reply({ error: String(err && err.message ? err.message : err) });
  }
}

async function pair(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/pair`, { method: "POST", cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()).token || null;
  } catch {
    return null;
  }
}

async function connect() {
  clearTimeout(reconnectTimer);
  if (ws) {
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      // already closed
    }
    ws = null;
  }
  const stored = await browser.storage.local.get(["token", "port"]);
  const portNumber = stored.port || 8765;
  // Auto-pairing: the server hands its token only to moz-extension:// origins; the manual token is a fallback.
  const token = (await pair(portNumber)) || stored.token;
  if (!token) {
    setBadge(false);
    scheduleReconnect();
    return;
  }
  let sock;
  try {
    sock = new WebSocket(`ws://127.0.0.1:${portNumber}/?token=${encodeURIComponent(token)}`);
  } catch {
    setBadge(false);
    scheduleReconnect();
    return;
  }
  ws = sock;
  sock.onopen = () => {
    attempt = 0;
    setBadge(true);
  };
  sock.onmessage = onMessage;
  sock.onerror = () => {};
  sock.onclose = (event) => {
    if (ws !== sock) return;
    ws = null;
    setBadge(false);
    if (event.code !== 4000) scheduleReconnect(); // 4000 = replaced by a newer connection
  };
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.token || changes.port)) {
    attempt = 0;
    connect();
  }
});

setBadge(false);
connect();
