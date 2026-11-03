# ff-mcp-bridge

**EN:** A Firefox extension plus a local MCP server that lets an MCP client (e.g. Claude Code) control your real Firefox: tabs, navigation, page reading, clicks, typing, screenshots, JS, console and network metadata. Compatible with Claude Code via MCP.

**PT-BR:** Extensão do Firefox + servidor MCP local que permite a um cliente MCP (ex.: Claude Code) controlar o seu Firefox real, com seus logins.

> Este projeto **não é um produto da Anthropic** e não é afiliado a ela.

## Arquitetura

```
Claude Code ──stdio(MCP)──▶ server (Node)  ──WebSocket 127.0.0.1:8765──▶ extensão Firefox
                                                                          ├─ background page (persistente)
                                                                          └─ content script (por aba)
```

## Instalação (5 passos)

1. **Clone** este repositório.
2. `npm install` (Node >= 18).
3. **Carregue a extensão**: `npm run run:ext` (abre um Firefox com perfil de teste), ou `about:debugging` → "Este Firefox" → "Carregar extensão temporária" → `extension/manifest.json`.
4. **Cole o token**: inicie o servidor uma vez (`npm start`) para gerar `%USERPROFILE%\.ff-mcp-bridge\token`; abra as opções da extensão, cole o token e salve. O badge do ícone fica `ON` (verde) quando conectado.
5. **Registre no Claude Code** (ajuste o caminho):
   ```powershell
   claude mcp add ff-mcp-bridge -- node D:\codigos\extensao-firefox\server\src\index.js
   ```

Para uso permanente (sem recarregar a cada reinício): `npx web-ext sign --channel=unlisted` com chaves AMO suas.

## Ferramentas

| Tool | Descrição |
|---|---|
| `tabs_context` | Lista abas (`tabId`, título, URL, ativa, janela) |
| `tabs_create` / `tabs_close` | Abre / fecha abas |
| `navigate` | Vai a uma URL, `"back"` ou `"forward"`; espera carregar (30s) |
| `read_page` | Árvore de acessibilidade com `[ref_N]` (`filter`, `max_chars`, `ref_id`) |
| `find` | Até 20 elementos por role/nome/texto |
| `get_page_text` | Texto de `article`/`main`/`body` |
| `computer` | `screenshot`, `left_click`, `right_click`, `double_click`, `type`, `key`, `scroll`, `scroll_to`, `hover`, `wait` |
| `form_input` | Define valor de input/textarea/select/checkbox/contenteditable |
| `javascript_tool` | Executa JS (`world: "content"` ou `"page"`), com `await` de topo |
| `read_console_messages` | Console capturado desde o carregamento do content script |
| `read_network_requests` | Metadados de rede via `webRequest` |

Todas aceitam `tabId` opcional (padrão: aba ativa).

## Segurança

- O servidor escuta **somente em `127.0.0.1`** (porta `8765`, mude com `FF_MCP_PORT`).
- O **token** autentica a extensão, e o `Origin` precisa ser `moz-extension://`. Conexões inválidas são fechadas com código 4401.
- A extensão tem `<all_urls>`: ela acessa todas as abas. **Quem controla o servidor controla o navegador.** Não exponha a porta.
- Use um **perfil dedicado do Firefox** para automação.
- O manifest declara `'unsafe-eval'` na CSP para o `javascript_tool` rodar no content script. Isso é aceitável para uso local, mas a AMO pode exigir revisão extra.

## Limitações conhecidas

- Eventos sintéticos (`isTrusted=false`): falham em alguns sites (botões que exigem gesto real, captchas, alguns editores ricos).
- Sem API `debugger`: sem emulação de dispositivo nem corpo de requisições.
- Páginas restritas (`about:`, `moz-extension:`, `addons.mozilla.org`, visualizador de PDF) devolvem *"Esta página não permite scripts (URL restrita do Firefox)"*.
- Só uma extensão conectada por servidor. Duas sessões do Claude Code simultâneas disputam a porta: use `FF_MCP_PORT` diferente e a mesma porta nas opções.
- Iframes não são percorridos pelo `read_page`/`find` (`all_frames: false`).

## Testado / não testado

| Item | Estado |
|---|---|
| `scripts/smoke-test.mjs` (token errado, Origin http, timeout, sem extensão, erro propagado, desconexão) | **Testado: 7/7 passam** |
| `web-ext lint` | **Testado: 0 erros**; avisos sobre CSP `unsafe-eval` (esperado) |
| Carregar a extensão e badge `ON` no Firefox | Não testado |
| Fluxo real com Claude Code (abrir example.com, ler, screenshot, clicar) | Não testado |
| Formulário (digitar + Enter) | Não testado |
| Página restrita (`about:preferences`) | Não testado |
| Reconexão automática | Não testado |

## Roadmap

native messaging, múltiplas sessões, `resize_window`, gravação de GIF, grupo de abas.

## Licença

MIT
