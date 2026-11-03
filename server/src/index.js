#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Bridge } from "./bridge.js";
import { HOST, PORT, TOKEN_PATH, loadOrCreateToken } from "./config.js";

// stdout belongs to the MCP protocol: everything else goes to stderr.
const token = loadOrCreateToken();
const bridge = new Bridge({ port: PORT, token, host: HOST });

console.error(`[ff-mcp-bridge] token em: ${TOKEN_PATH}`);
console.error(`[ff-mcp-bridge] cole o token e a porta (${PORT}) nas opções da extensão Firefox.`);

bridge.start().catch((err) => {
  console.error(`[ff-mcp-bridge] não foi possível escutar em ${HOST}:${PORT}: ${err.message}`);
});

const server = new McpServer({ name: "ff-mcp-bridge", version: "0.1.0" });

const tabId = z.number().int().optional().describe("Tab id (default: active tab of the current window)");

function toContent(result) {
  if (result && Array.isArray(result.content)) return result.content;
  if (typeof result === "string") return [{ type: "text", text: result }];
  if (result === undefined || result === null) return [{ type: "text", text: "ok" }];
  return [{ type: "text", text: JSON.stringify(result, null, 2) }];
}

function register(name, description, shape, method = name) {
  server.tool(name, description, shape, async (params) => {
    try {
      const result = await bridge.request(method, params);
      return { content: toContent(result) };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err.message }] };
    }
  });
}

register("tabs_context", "List all open Firefox tabs ({tabId, title, url, active, windowId}).", {});

register("tabs_create", "Open a new tab, optionally at a URL.", {
  url: z.string().optional(),
});

register("tabs_close", "Close a tab.", { tabId: z.number().int() });

register(
  "navigate",
  'Navigate a tab to a URL, or pass "back"/"forward". Waits for the page to finish loading (30s timeout).',
  { url: z.string(), tabId },
);

register(
  "read_page",
  "Read the page as an accessibility-style tree with [ref_N] ids usable by computer/form_input.",
  {
    filter: z.enum(["interactive", "all"]).optional(),
    max_chars: z.number().int().positive().optional(),
    ref_id: z.string().optional().describe("Restrict the tree to descendants of this ref"),
    tabId,
  },
);

register(
  "find",
  "Find up to 20 visible elements whose role/name/text contains the query (case-insensitive).",
  { query: z.string(), tabId },
);

register("get_page_text", "Extract the visible text of the page (article/main first, else body).", {
  max_chars: z.number().int().positive().optional(),
  tabId,
});

register(
  "form_input",
  "Set the value of an input/textarea/select/checkbox/contenteditable by ref, firing input and change events.",
  { ref: z.string(), value: z.union([z.string(), z.number(), z.boolean()]), tabId },
);

register(
  "javascript_tool",
  "Run JavaScript in the page and return the JSON-serialized value of the last expression (top-level await supported).",
  { text: z.string(), world: z.enum(["content", "page"]).optional(), tabId },
);

register("read_console_messages", "Read console messages captured since the content script loaded.", {
  limit: z.number().int().positive().optional(),
  onlyErrors: z.boolean().optional(),
  pattern: z.string().optional(),
  tabId,
});

register("read_network_requests", "List recent network requests (method, url, status, type) of a tab.", {
  limit: z.number().int().positive().optional(),
  urlPattern: z.string().optional(),
  tabId,
});

server.tool(
  "computer",
  "Mouse/keyboard/screenshot automation. Actions: screenshot, left_click, right_click, double_click, type, key, scroll, scroll_to, hover, wait. Clicks take coordinate [x,y] (CSS px of the screenshot) or ref.",
  {
    action: z.enum([
      "screenshot",
      "left_click",
      "right_click",
      "double_click",
      "type",
      "key",
      "scroll",
      "scroll_to",
      "hover",
      "wait",
    ]),
    coordinate: z.array(z.number()).length(2).optional(),
    ref: z.string().optional(),
    text: z.string().optional().describe("Text for `type`; space-separated key combos for `key` (e.g. \"ctrl+a Backspace\")"),
    scroll_direction: z.enum(["up", "down", "left", "right"]).optional(),
    scroll_amount: z.number().optional(),
    duration: z.number().min(0).max(10).optional(),
    tabId,
  },
  async (params) => {
    try {
      if (params.action === "wait") {
        const secs = Math.min(params.duration ?? 1, 10);
        await new Promise((r) => setTimeout(r, secs * 1000));
        return { content: [{ type: "text", text: `Waited ${secs}s` }] };
      }
      const result = await bridge.request("computer", params);
      return { content: toContent(result) };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err.message }] };
    }
  },
);

await server.connect(new StdioServerTransport());
console.error("[ff-mcp-bridge] servidor MCP pronto (stdio).");
