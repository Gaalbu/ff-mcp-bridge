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

## Instalação (3 passos, tudo automático depois)

1. **Clone** este repositório e rode `npm install` (Node >= 18; Firefox instalado).
2. **Registre no Claude Code** para qualquer pasta (ajuste o caminho):
   ```powershell
   claude mcp add --scope user ff-mcp-bridge -- node D:\codigos\extensao-firefox\server\src\index.js
   ```
3. **Use**: peça ao Claude Code algo como *"use ff-mcp-bridge para abrir example.com"*.

O que acontece sozinho na primeira chamada de ferramenta:
- Se o Firefox com a extensão não estiver conectado, o servidor o abre (via `web-ext`) num **perfil dedicado e persistente** em `%USERPROFILE%\.ff-mcp-bridge\firefox-profile`. Faça login nos seus sites nesse perfil uma vez; ele guarda os logins.
- A extensão **pareia sozinha**: busca o token no servidor local (`POST /pair`, aceito só para `Origin: moz-extension://`). Não é preciso colar nada. O token das opções é só reserva.
- O Firefox continua aberto quando a sessão do Claude Code termina; na próxima, a extensão reconecta.

Variáveis de ambiente do servidor: `FF_MCP_AUTOLAUNCH=0` (não abrir o Firefox), `FF_MCP_FIREFOX` (caminho do firefox.exe), `FF_MCP_PROFILE` (pasta do perfil), `FF_MCP_HEADLESS=1`, `FF_MCP_PORT`. Com porta diferente de 8765, informe a mesma porta nas opções da extensão.

Manual (sem auto-launch): `npm run run:ext` abre o Firefox com a extensão. A extensão é carregada como temporária, ou seja, só vale enquanto esse Firefox estiver aberto. Para instalação permanente: `npx web-ext sign --channel=unlisted` com chaves AMO suas.

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

## Testes

```powershell
npm run smoke                                  # bridge sem Firefox
$env:MOZ_REMOTE_ALLOW_SYSTEM_ACCESS='1'; npm run e2e   # Firefox headless + MCP real (precisa de Firefox instalado)
node scripts/e2e-autolaunch.mjs                # sem nada aberto: o servidor abre o Firefox e a extensão pareia sozinha (usa a porta 8765)
```

## Segurança

- O servidor escuta **somente em `127.0.0.1`** (porta `8765`, mude com `FF_MCP_PORT`).
- O **token** autentica a extensão, e o `Origin` precisa ser `moz-extension://`. Conexões inválidas são fechadas com código 4401.
- O **auto-pareamento** entrega o token a qualquer extensão do Firefox que consiga fazer `POST` em `127.0.0.1:8765/pair`. Páginas web não conseguem (o `Origin` delas é rejeitado e a resposta não tem CORS). Uma extensão maliciosa já instalada teria acesso ao navegador de qualquer forma, mas se isso te preocupa, rode o servidor sem pareamento removendo a rota `/pair` e use o token manual.
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
| `scripts/e2e-firefox.mjs`: Firefox 159 headless + extensão + cliente MCP real via stdio (conexão, tabs, navigate, read_page, find, get_page_text, screenshot, clique, formulário com Enter, scroll, JS content/page, console, rede, página restrita, tabs_close, reconexão) | **Testado: 17/17 passam** (site local em 127.0.0.1 e example.com → clique no link até iana.org) |
| Auto-launch do Firefox + auto-pareamento (`e2e-autolaunch.mjs`; e uma sessão real `claude -p` de outra pasta, sem nada aberto antes) | **Testado** (~8s até a primeira resposta) |
| Estado do badge (`ON` verde / `OFF` vermelho, e a volta a `ON` após reiniciar o servidor) | **Testado** lendo o estado da `browserAction` (Firefox headless); aparência visual do ícone não conferida |
| `claude mcp add` + `claude mcp list` | **Testado**: `ff-mcp-bridge ... √ Connected` |
| Sessão real do Claude Code (`claude -p`) chamando `tabs_context`, `navigate`, `read_page`, screenshot e clique no link do example.com | **Testado**: terminou em `https://www.iana.org/help/example-domains`, sem erros |
| DuckDuckGo, captchas, editores ricos | Não testado |

## Roadmap

native messaging, múltiplas sessões, `resize_window`, gravação de GIF, grupo de abas.

## Licença

MIT
