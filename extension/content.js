"use strict";

if (!window.__ffmcpLoaded) {
  window.__ffmcpLoaded = true;

  // ------------------------------------------------------------ refs

  const refs = new Map(); // "ref_N" -> WeakRef<Element>
  const refOf = new WeakMap(); // Element -> "ref_N"
  let refCounter = 0;

  function getRef(el) {
    let id = refOf.get(el);
    if (!id) {
      id = `ref_${++refCounter}`;
      refOf.set(el, id);
      refs.set(id, new WeakRef(el));
    }
    return id;
  }

  function resolveRef(id) {
    const el = refs.get(id)?.deref();
    if (!el || !el.isConnected) throw new Error("ref expirada, rode read_page de novo");
    return el;
  }

  // ------------------------------------------------------------ accessibility helpers

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK"]);
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "textbox", "checkbox", "radio", "combobox", "listbox", "option",
    "menuitem", "tab", "switch", "slider", "spinbutton", "searchbox", "menuitemcheckbox", "menuitemradio",
  ]);
  const TAG_ROLES = {
    A: "link", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox", IMG: "img",
    H1: "heading", H2: "heading", H3: "heading", H4: "heading", H5: "heading", H6: "heading",
    NAV: "navigation", MAIN: "main", HEADER: "banner", FOOTER: "contentinfo", ASIDE: "complementary",
    FORM: "form", TABLE: "table", UL: "list", OL: "list", LI: "listitem", DIALOG: "dialog",
    SUMMARY: "button", OPTION: "option", P: "paragraph", LABEL: "label",
  };
  const INPUT_ROLES = {
    checkbox: "checkbox", radio: "radio", button: "button", submit: "button", reset: "button",
    image: "button", range: "slider", number: "spinbutton", search: "searchbox",
  };

  function trunc(s, n = 100) {
    s = (s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  function getRole(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(/\s+/)[0];
    if (el.tagName === "A" && !el.hasAttribute("href")) return null;
    if (el.tagName === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "hidden") return null;
      return INPUT_ROLES[type] || "textbox";
    }
    if (el.isContentEditable && el.getAttribute("contenteditable") !== null) return "textbox";
    return TAG_ROLES[el.tagName] || null;
  }

  function isInteractive(el, role) {
    if (INTERACTIVE_ROLES.has(role)) return true;
    if (el.tagName === "SUMMARY") return true;
    const tab = el.getAttribute("tabindex");
    return tab !== null && Number(tab) >= 0;
  }

  function getName(el) {
    const label = el.getAttribute("aria-label");
    if (label) return trunc(label);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const t = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ");
      if (t.trim()) return trunc(t);
    }
    if (el.labels && el.labels.length) return trunc([...el.labels].map((l) => l.textContent).join(" "));
    const alt = el.getAttribute("alt");
    if (alt) return trunc(alt);
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return trunc(placeholder);
    if (el.tagName === "INPUT" && ["button", "submit", "reset"].includes(el.type)) return trunc(el.value);
    if (el.tagName === "SELECT") return trunc(el.selectedOptions[0]?.textContent || "");
    const title = el.getAttribute("title");
    const text = trunc(el.textContent);
    return text || (title ? trunc(title) : "");
  }

  function isHiddenStyle(el) {
    if (el.getAttribute("aria-hidden") === "true") return true;
    const cs = getComputedStyle(el);
    return cs.display === "none" || cs.visibility === "hidden";
  }

  function isVisible(el) {
    if (isHiddenStyle(el)) return false;
    return el.getClientRects().length > 0;
  }

  function describe(el, role) {
    const parts = [role || el.tagName.toLowerCase()];
    const name = getName(el);
    if (name) parts.push(JSON.stringify(name));
    parts.push(`[${getRef(el)}]`);
    if (el.tagName === "A" && el.href) parts.push(`href=${trunc(el.href, 200)}`);
    if (el.tagName === "INPUT") parts.push(`type=${el.type}`);
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
      if (el.type === "checkbox" || el.type === "radio") parts.push(`checked=${el.checked}`);
      else if (el.type !== "password" && el.value) parts.push(`value=${JSON.stringify(trunc(el.value, 80))}`);
    }
    if (el.disabled) parts.push("disabled");
    if (/^H[1-6]$/.test(el.tagName)) parts.push(`level=${el.tagName[1]}`);
    return parts.join(" ");
  }

  // ------------------------------------------------------------ read_page / find / text

  function readPage({ filter = "all", max_chars = 50000, ref_id }) {
    const root = ref_id ? resolveRef(ref_id) : document.body;
    if (!root) return "(página vazia)";
    const interactiveOnly = filter === "interactive";
    const lines = [];

    function walk(el, depth, skipText) {
      if (SKIP_TAGS.has(el.tagName) || isHiddenStyle(el)) return;
      const role = getRole(el);
      const interactive = isInteractive(el, role);
      const emit = interactiveOnly ? interactive : role !== null || interactive;
      let childDepth = depth;
      let childSkipText = skipText;
      if (emit) {
        lines.push("  ".repeat(interactiveOnly ? 0 : depth) + "- " + describe(el, role));
        childDepth = depth + 1;
        if (["link", "button", "heading", "option", "label", "paragraph"].includes(role)) childSkipText = true;
      }
      for (const child of el.childNodes) {
        if (child.nodeType === 1) walk(child, childDepth, childSkipText);
        else if (child.nodeType === 3 && !interactiveOnly && !childSkipText) {
          const t = trunc(child.nodeValue);
          if (t) lines.push("  ".repeat(childDepth) + `- text ${JSON.stringify(t)}`);
        }
      }
      const shadow = el.openOrClosedShadowRoot || el.shadowRoot;
      if (shadow) for (const child of shadow.children) walk(child, childDepth, childSkipText);
    }

    walk(root, 0, false);
    let out = lines.join("\n");
    if (out.length > max_chars) out = out.slice(0, max_chars) + `\n…(truncado em ${max_chars} caracteres)`;
    return out || "(nenhum elemento encontrado)";
  }

  function findElements({ query }) {
    const q = String(query).toLowerCase();
    const found = [];
    for (const el of document.body.querySelectorAll("*")) {
      if (found.length >= 20) break;
      if (SKIP_TAGS.has(el.tagName) || !isVisible(el)) continue;
      const role = getRole(el);
      const ownText = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join(" ");
      const haystack = `${role || ""} ${getName(el)} ${trunc(ownText)} ${el.getAttribute("placeholder") || ""} ${
        el.type === "password" ? "" : el.value || ""
      }`.toLowerCase();
      if (!haystack.includes(q)) continue;
      if (role === null && !isInteractive(el, role) && !trunc(ownText)) continue;
      found.push(describe(el, role));
    }
    return found.length ? found.join("\n") : "Nenhum elemento encontrado.";
  }

  function getPageText({ max_chars = 50000 }) {
    const root = document.querySelector("article") || document.querySelector("main") || document.body;
    const text = (root?.innerText || "").trim();
    return text.length > max_chars ? text.slice(0, max_chars) + `\n…(truncado em ${max_chars} caracteres)` : text;
  }

  // ------------------------------------------------------------ input helpers

  const nativeSetter = (el) => {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype
      : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    return Object.getOwnPropertyDescriptor(proto, "value").set;
  };

  function fire(el, type, init = {}) {
    el.dispatchEvent(new Event(type, { bubbles: true, cancelable: false, ...init }));
  }

  function fireInput(el, inputType, data) {
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data }));
  }

  function formInput({ ref, value }) {
    const el = resolveRef(ref);
    el.scrollIntoView({ block: "center" });
    if (el.tagName === "SELECT") {
      const wanted = String(value);
      const opt = [...el.options].find((o) => o.value === wanted) || [...el.options].find((o) => o.text.trim() === wanted);
      if (!opt) throw new Error(`Opção "${wanted}" não encontrada no select.`);
      el.value = opt.value;
    } else if (el.type === "checkbox" || el.type === "radio") {
      el.checked = value === true || value === "true" || value === 1;
    } else if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      el.focus();
      nativeSetter(el).call(el, String(value));
    } else if (el.isContentEditable) {
      el.focus();
      document.execCommand("selectAll", false);
      if (!document.execCommand("insertText", false, String(value))) el.textContent = String(value);
    } else {
      throw new Error(`Elemento <${el.tagName.toLowerCase()}> não aceita valor.`);
    }
    fire(el, "input");
    fire(el, "change");
    return `Valor definido em ${ref}`;
  }

  function isTextField(el) {
    return el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !["checkbox", "radio", "button", "submit", "reset", "file", "image", "range", "color"].includes(el.type)));
  }

  function insertText(el, text) {
    if (isTextField(el)) {
      let start = el.value.length;
      let end = start;
      try {
        if (el.selectionStart !== null) {
          start = el.selectionStart;
          end = el.selectionEnd;
        }
      } catch {
        // some input types throw on selection access
      }
      nativeSetter(el).call(el, el.value.slice(0, start) + text + el.value.slice(end));
      try {
        el.setSelectionRange(start + text.length, start + text.length);
      } catch {
        // unsupported for this input type
      }
      fireInput(el, "insertText", text);
    } else if (el.isContentEditable) {
      document.execCommand("insertText", false, text);
    } else {
      throw new Error("O elemento focado não aceita texto. Clique em um campo de texto primeiro.");
    }
  }

  function deleteText(el, forward) {
    if (isTextField(el)) {
      let start = el.value.length;
      let end = start;
      try {
        if (el.selectionStart !== null) {
          start = el.selectionStart;
          end = el.selectionEnd;
        }
      } catch {
        // ignore
      }
      if (start === end) {
        if (forward) end = Math.min(el.value.length, end + 1);
        else start = Math.max(0, start - 1);
      }
      nativeSetter(el).call(el, el.value.slice(0, start) + el.value.slice(end));
      try {
        el.setSelectionRange(start, start);
      } catch {
        // ignore
      }
      fireInput(el, forward ? "deleteContentForward" : "deleteContentBackward", null);
    } else if (el.isContentEditable) {
      document.execCommand(forward ? "forwardDelete" : "delete");
    }
  }

  // ------------------------------------------------------------ pointer actions

  function targetFor({ ref, coordinate }) {
    if (ref) {
      const el = resolveRef(ref);
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      return { el, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }
    if (coordinate) {
      const [x, y] = coordinate;
      const el = document.elementFromPoint(x, y);
      if (!el) throw new Error(`Nenhum elemento em (${x}, ${y}).`);
      return { el, x, y };
    }
    throw new Error("Informe coordinate ou ref.");
  }

  function mouse(el, type, x, y, extra = {}) {
    const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Ctor(type, {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons: 0, ...extra,
    }));
  }

  function pressSequence(el, x, y, button, detail) {
    const buttons = button === 2 ? 2 : 1;
    mouse(el, "pointerdown", x, y, { button, buttons, detail });
    mouse(el, "mousedown", x, y, { button, buttons, detail });
    if (el.focus && el.matches?.("a,button,input,select,textarea,summary,[tabindex],[contenteditable]")) el.focus();
    mouse(el, "pointerup", x, y, { button, detail });
    mouse(el, "mouseup", x, y, { button, detail });
  }

  function click(params, kind) {
    const { el, x, y } = targetFor(params);
    mouse(el, "pointerover", x, y);
    mouse(el, "mouseover", x, y);
    mouse(el, "pointermove", x, y);
    mouse(el, "mousemove", x, y);
    if (kind === "right") {
      pressSequence(el, x, y, 2, 1);
      mouse(el, "contextmenu", x, y, { button: 2 });
    } else if (kind === "double") {
      pressSequence(el, x, y, 0, 1);
      mouse(el, "click", x, y, { detail: 1 });
      pressSequence(el, x, y, 0, 2);
      mouse(el, "click", x, y, { detail: 2 });
      mouse(el, "dblclick", x, y, { detail: 2 });
    } else {
      pressSequence(el, x, y, 0, 1);
      mouse(el, "click", x, y, { detail: 1 });
    }
    return `${kind} click em <${el.tagName.toLowerCase()}> (${x}, ${y})`;
  }

  function hover(params) {
    const { el, x, y } = targetFor(params);
    for (const t of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) {
      mouse(el, t, x, y);
    }
    return `hover em <${el.tagName.toLowerCase()}> (${x}, ${y})`;
  }

  function scrollableAncestor(el, dir) {
    const vertical = dir === "up" || dir === "down";
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const overflow = vertical ? cs.overflowY : cs.overflowX;
      const can = vertical ? n.scrollHeight > n.clientHeight : n.scrollWidth > n.clientWidth;
      if (can && /auto|scroll/.test(overflow)) return n;
    }
    return null;
  }

  function scroll({ coordinate, scroll_direction = "down", scroll_amount = 3 }) {
    const px = scroll_amount * 100;
    const dx = scroll_direction === "left" ? -px : scroll_direction === "right" ? px : 0;
    const dy = scroll_direction === "up" ? -px : scroll_direction === "down" ? px : 0;
    let target = null;
    if (coordinate) {
      const el = document.elementFromPoint(coordinate[0], coordinate[1]);
      if (el) target = scrollableAncestor(el, scroll_direction);
    }
    if (target) {
      target.scrollBy({ left: dx, top: dy, behavior: "instant" });
      return `Rolou elemento para ${scroll_direction} (scrollTop=${Math.round(target.scrollTop)})`;
    }
    window.scrollBy({ left: dx, top: dy, behavior: "instant" });
    return `Rolou página para ${scroll_direction} (scrollY=${Math.round(window.scrollY)})`;
  }

  // ------------------------------------------------------------ keyboard

  const KEY_ALIASES = {
    esc: "Escape", return: "Enter", del: "Delete", space: " ", spacebar: " ", up: "ArrowUp", down: "ArrowDown",
    left: "ArrowLeft", right: "ArrowRight", pageup: "PageUp", pagedown: "PageDown", backspace: "Backspace",
    enter: "Enter", tab: "Tab", escape: "Escape", delete: "Delete", home: "Home", end: "End",
  };

  function parseCombo(combo) {
    const parts = combo.split("+");
    let key = parts.pop();
    if (key === "" && parts.length) key = "+";
    const mods = new Set(parts.map((m) => m.toLowerCase()));
    const norm = KEY_ALIASES[key.toLowerCase()] || (key.length > 1 ? key[0].toUpperCase() + key.slice(1) : key);
    return {
      key: norm,
      ctrlKey: mods.has("ctrl") || mods.has("control"),
      shiftKey: mods.has("shift"),
      altKey: mods.has("alt") || mods.has("option"),
      metaKey: mods.has("cmd") || mods.has("meta") || mods.has("win") || mods.has("windows"),
    };
  }

  function focusables() {
    return [...document.querySelectorAll("a[href],button,input,select,textarea,summary,[tabindex],[contenteditable]")]
      .filter((e) => !e.disabled && e.tabIndex >= 0 && isVisible(e));
  }

  function pressKey(combo) {
    const k = parseCombo(combo);
    const el = document.activeElement && document.activeElement !== document.documentElement
      ? document.activeElement : document.body;
    const init = { key: k.key, ctrlKey: k.ctrlKey, shiftKey: k.shiftKey, altKey: k.altKey, metaKey: k.metaKey };
    const down = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true, composed: true });
    el.dispatchEvent(down);
    const printable = k.key.length === 1 && !k.ctrlKey && !k.metaKey;
    let keypressPrevented = false;
    if (!down.defaultPrevented && (printable || k.key === "Enter")) {
      const kp = new KeyboardEvent("keypress", { ...init, bubbles: true, cancelable: true, composed: true });
      el.dispatchEvent(kp);
      keypressPrevented = kp.defaultPrevented;
    }

    // Untrusted events have no default actions, so emulate the common ones.
    if (!down.defaultPrevented && !keypressPrevented) {
      const accel = k.ctrlKey || k.metaKey;
      if (accel && k.key.toLowerCase() === "a") {
        if (isTextField(el)) el.select();
        else document.execCommand("selectAll");
      } else if (printable) {
        if (el.tagName === "BUTTON" && k.key === " ") el.click();
        else if (isTextField(el) || el.isContentEditable) insertText(el, k.key);
      } else if (k.key === "Backspace" || k.key === "Delete") {
        deleteText(el, k.key === "Delete");
      } else if (k.key === "Enter") {
        if (el.tagName === "TEXTAREA" || el.isContentEditable) insertText(el, "\n");
        else if (el.tagName === "BUTTON" || el.tagName === "A" || el.tagName === "SUMMARY" || el.type === "submit") el.click();
        else if (el.tagName === "INPUT" && el.form) {
          if (typeof el.form.requestSubmit === "function") el.form.requestSubmit();
          else el.form.submit();
        }
      } else if (k.key === "Tab") {
        const list = focusables();
        const idx = list.indexOf(el);
        const next = list[(idx + (k.shiftKey ? -1 : 1) + list.length) % list.length];
        next?.focus();
      } else if (isTextField(el) && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(k.key)) {
        try {
          const pos = k.key === "Home" ? 0 : k.key === "End" ? el.value.length
            : Math.max(0, Math.min(el.value.length, el.selectionStart + (k.key === "ArrowLeft" ? -1 : 1)));
          el.setSelectionRange(pos, pos);
        } catch {
          // ignore
        }
      } else if (k.key === " " && !isTextField(el)) {
        window.scrollBy({ top: window.innerHeight * 0.9, behavior: "instant" });
      } else if (k.key === "PageDown" || k.key === "PageUp") {
        window.scrollBy({ top: (k.key === "PageDown" ? 1 : -1) * window.innerHeight * 0.9, behavior: "instant" });
      } else if (k.key === "ArrowDown" || k.key === "ArrowUp") {
        if (!isTextField(el)) window.scrollBy({ top: (k.key === "ArrowDown" ? 1 : -1) * 40, behavior: "instant" });
      }
    }
    el.dispatchEvent(new KeyboardEvent("keyup", { ...init, bubbles: true, cancelable: true, composed: true }));
  }

  function typeText(text) {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) {
      throw new Error("Nenhum elemento focado. Clique em um campo de texto antes de digitar.");
    }
    for (const ch of text) {
      const init = { key: ch === "\n" ? "Enter" : ch, bubbles: true, cancelable: true, composed: true };
      const down = new KeyboardEvent("keydown", init);
      el.dispatchEvent(down);
      el.dispatchEvent(new KeyboardEvent("keypress", init));
      if (!down.defaultPrevented) insertText(el, ch);
      el.dispatchEvent(new KeyboardEvent("keyup", init));
    }
    return `Digitou ${text.length} caractere(s)`;
  }

  // ------------------------------------------------------------ javascript_tool

  // Self-contained so it can be stringified into the page world.
  async function runnerCore(code) {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const candidates = ["return (" + code + "\n)"];
    const trimmed = code.replace(/\s+$/, "");
    const lines = trimmed.split("\n");
    if (lines.length > 1) {
      const last = lines.pop().replace(/;\s*$/, "");
      candidates.push(lines.join("\n") + "\nreturn (" + last + "\n)");
    }
    const noSemi = trimmed.replace(/;\s*$/, "");
    const cut = noSemi.lastIndexOf(";");
    if (cut > -1) candidates.push(noSemi.slice(0, cut + 1) + "\nreturn (" + noSemi.slice(cut + 1) + "\n)");
    candidates.push(code);
    let fn;
    let lastErr;
    for (const body of candidates) {
      try {
        fn = new AsyncFunction(body);
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!fn) throw lastErr;
    const value = await fn();
    const seen = new WeakSet();
    return JSON.stringify(value, (k, v) => {
      if (typeof v === "function") return "[Function]";
      if (typeof v === "bigint") return v + "n";
      if (typeof Node !== "undefined" && v instanceof Node) return "<" + v.nodeName.toLowerCase() + ">";
      if (v && typeof v === "object") {
        if (seen.has(v)) return "[Circular]";
        seen.add(v);
      }
      return v;
    });
  }

  async function javascriptTool({ text, world = "content" }) {
    if (world === "page") return runInPage(text);
    const json = await runnerCore(text);
    return json === undefined ? "undefined" : json;
  }

  function runInPage(code) {
    return new Promise((resolve, reject) => {
      const nonce = crypto.getRandomValues(new Uint32Array(4)).join("-");
      let done = false;
      const finish = (fn, arg) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        document.removeEventListener("securitypolicyviolation", onCsp);
        fn(arg);
      };
      const onMessage = (ev) => {
        if (ev.source !== window || !ev.data || ev.data.__ffmcp !== nonce) return;
        if (ev.data.ok) finish(resolve, ev.data.value === undefined ? "undefined" : ev.data.value);
        else finish(reject, new Error(ev.data.error));
      };
      const onCsp = () =>
        finish(reject, new Error("A CSP da página bloqueou o script inline (world:\"page\"). Use world:\"content\"."));
      const timer = setTimeout(
        () => finish(reject, new Error("Tempo esgotado executando no mundo da página (possível bloqueio de CSP).")),
        25000,
      );
      window.addEventListener("message", onMessage);
      document.addEventListener("securitypolicyviolation", onCsp);

      const script = document.createElement("script");
      script.textContent = `(function(nonce, code){
        const runnerCore = ${runnerCore.toString()};
        runnerCore(code).then(
          v => window.postMessage({__ffmcp: nonce, ok: true, value: v}, "*"),
          e => window.postMessage({__ffmcp: nonce, ok: false, error: String(e && e.stack || e)}, "*")
        );
      })(${JSON.stringify(nonce)}, ${JSON.stringify(code)});`;
      (document.documentElement || document.head).appendChild(script);
      script.remove();
    });
  }

  // ------------------------------------------------------------ console capture

  const consoleLog = [];
  const MAX_CONSOLE = 500;

  function formatArg(a) {
    if (typeof a === "string") return a;
    if (a instanceof Error) return a.stack || String(a);
    try {
      return JSON.stringify(a) ?? String(a);
    } catch {
      try {
        return String(a);
      } catch {
        return "[unprintable]";
      }
    }
  }

  function record(level, text) {
    consoleLog.push({ level, text: String(text).slice(0, 2000), time: new Date().toISOString() });
    if (consoleLog.length > MAX_CONSOLE) consoleLog.shift();
  }

  // Firefox lets content scripts wrap the page's console directly (no inline script, so no CSP issues).
  try {
    const pageWin = window.wrappedJSObject;
    const pageConsole = pageWin.console;
    for (const level of ["log", "info", "warn", "error", "debug"]) {
      const original = pageConsole[level];
      pageConsole[level] = exportFunction(function (...args) {
        try {
          record(level, args.map(formatArg).join(" "));
        } catch {
          // never break the page
        }
        return original.apply(pageConsole, args);
      }, pageWin);
    }
  } catch (err) {
    record("warn", `ff-mcp-bridge: não foi possível capturar console (${err.message})`);
  }

  window.addEventListener("error", (e) => record("error", `Uncaught ${e.message} (${e.filename}:${e.lineno})`));
  window.addEventListener("unhandledrejection", (e) => record("error", `Unhandled rejection: ${formatArg(e.reason)}`));

  function readConsole({ limit = 50, onlyErrors = false, pattern }) {
    let list = consoleLog;
    if (onlyErrors) list = list.filter((m) => m.level === "error");
    if (pattern) list = list.filter((m) => m.text.includes(pattern));
    list = list.slice(-limit);
    return list.length ? list.map((m) => `[${m.level}] ${m.text}`).join("\n") : "Nenhuma mensagem de console.";
  }

  // ------------------------------------------------------------ message router

  async function dispatch(method, params) {
    switch (method) {
      case "read_page": return readPage(params);
      case "find": return findElements(params);
      case "get_page_text": return getPageText(params);
      case "form_input": return formInput(params);
      case "javascript_tool": return javascriptTool(params);
      case "read_console_messages": return readConsole(params);
      case "viewport":
        return { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio };
      case "computer":
        switch (params.action) {
          case "left_click": return click(params, "left");
          case "right_click": return click(params, "right");
          case "double_click": return click(params, "double");
          case "hover": return hover(params);
          case "type":
            if (typeof params.text !== "string") throw new Error("`type` precisa de `text`.");
            return typeText(params.text);
          case "key": {
            if (!params.text) throw new Error("`key` precisa de `text`.");
            for (const combo of params.text.trim().split(/\s+/)) pressKey(combo);
            return `Pressionou ${params.text}`;
          }
          case "scroll": return scroll(params);
          case "scroll_to": {
            if (!params.ref) throw new Error("`scroll_to` precisa de `ref`.");
            resolveRef(params.ref).scrollIntoView({ block: "center", inline: "center" });
            return `Rolou até ${params.ref}`;
          }
          default: throw new Error(`Ação não suportada na página: ${params.action}`);
        }
      default:
        throw new Error(`Método desconhecido no content script: ${method}`);
    }
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.ffmcp) return undefined;
    return dispatch(msg.method, msg.params || {}).then(
      (result) => ({ ok: true, result }),
      (err) => ({ ok: false, error: String(err && err.message ? err.message : err) }),
    );
  });
}
