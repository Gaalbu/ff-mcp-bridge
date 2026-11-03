# Plano one-shot: extensão Firefox + servidor MCP (equivalente ao "Claude in Chrome")

> **Como usar:** cole este arquivo inteiro num chat novo do Claude Code, com a pasta de trabalho vazia (ex.: `D:\codigos\ff-mcp-bridge`), e diga: *"Execute este plano de ponta a ponta, sem me fazer perguntas. Só pare se precisar de uma credencial minha."*

---

## 0. Instruções para o agente (leia primeiro)

- Você vai construir **tudo** deste plano numa única execução. As decisões de arquitetura já estão tomadas abaixo: **não as rediscuta e não pergunte nada ao usuário**.
- Plataforma: Windows 10, PowerShell 5.1 (sem `&&`; use `;` ou `if ($?)`). Node >= 18.
- Idioma do README: português (BR) e inglês curto no topo. Código e comentários em inglês.
- **Nome do projeto: `ff-mcp-bridge`.** Não use "Claude" no nome, no ícone nem no texto da loja. Não imite a marca da Anthropic. O README diz só "compatível com Claude Code via MCP".
- Ao final, rode a checklist da seção 9 e **relate honestamente** o que passou e o que falhou. Não diga "pronto" sem ter testado de verdade.
- Não instale nada global além de dependências do projeto. Não peça nem armazene tokens do GitHub. Se `gh` não estiver autenticado, pare na seção 10 e entregue os comandos exatos.

## 1. Objetivo

Permitir que o Claude Code controle o **Firefox real do usuário** (com seus logins), como o Claude in Chrome faz no Chrome, expondo ferramentas MCP: listar/abrir/fechar abas, navegar, ler a página, achar elementos, clicar, digitar, rolar, tirar screenshot, executar JS, ler console e rede.

Meta de escopo: **MVP funcional hoje**. Funcionalidade > polimento.

## 2. Arquitetura (decidida)

```
Claude Code ──stdio(MCP)──▶ server (Node)  ──WebSocket 127.0.0.1:8765──▶ extensão Firefox
                                                                          ├─ background page (persistente)
                                                                          └─ content script (por aba)
```

Decisões e motivos:

| Decisão | Motivo |
|---|---|
| Firefox **Manifest V2** com background page **persistente** | O WebSocket fica vivo. O MV3 suspende event pages e quebraria a conexão. O Firefox continua suportando MV2. |
| **WebSocket local** em vez de native messaging | Native messaging no Windows exige registro e manifesto do host. WebSocket evita instalador. |
| Servidor MCP em **Node + `@modelcontextprotocol/sdk`**, transporte stdio | Registro simples: `claude mcp add`. |
| O **servidor** abre o WebSocket; a **extensão** conecta com backoff | A extensão pode abrir antes do servidor e reconecta sozinha. |
| Autenticação: **token compartilhado** + checagem de `Origin` | Qualquer página local poderia conectar ao WebSocket. Sem isso o controle do navegador fica exposto. |
| Eventos sintéticos no content script (sem `chrome.debugger`) | O Firefox não tem a API `debugger`. Limitação conhecida: `isTrusted=false` (ver seção 11). |

Bind **somente** em `127.0.0.1`. Porta padrão `8765`, configurável por `FF_MCP_PORT`.

## 3. Estrutura do repositório

```
ff-mcp-bridge/
├─ README.md
├─ LICENSE                      (MIT)
├─ .gitignore                   (node_modules, dist, web-ext-artifacts, .env)
├─ package.json                 (workspaces: server, extension)
├─ server/
│  ├─ package.json              (type: module; deps: @modelcontextprotocol/sdk, ws, zod)
│  └─ src/
│     ├─ index.js               (MCP stdio + registro das tools)
│     ├─ bridge.js              (WebSocket server, token, request/response por id, timeout 30s)
│     └─ config.js              (porta, caminho do token)
├─ extension/
│  ├─ manifest.json
│  ├─ background.js
│  ├─ content.js
│  ├─ options.html
│  ├─ options.js
│  └─ icons/icon-48.png, icon-96.png   (gerar PNG simples via script; sem marca)
└─ scripts/
   ├─ make-icons.mjs            (gera PNGs sólidos com Node puro, sem deps)
   └─ smoke-test.mjs            (testa o bridge sem Firefox, ver seção 9)
```

## 4. Protocolo servidor ⇄ extensão

JSON por mensagem WebSocket:

- Requisição (servidor → extensão): `{ "id": "uuid", "method": "navigate", "params": { ... } }`
- Resposta (extensão → servidor): `{ "id": "uuid", "result": { ... } }` ou `{ "id": "uuid", "error": "mensagem" }`
- Handshake: a extensão conecta em `ws://127.0.0.1:8765/?token=<TOKEN>`. O servidor valida o token e exige `Origin` começando com `moz-extension://`. Caso contrário, fecha com código 4401.
- Apenas **uma** extensão conectada por vez (a nova substitui a antiga).
- Se não houver extensão conectada, as tools retornam o erro claro: *"Extensão Firefox não conectada. Abra o Firefox com a extensão ff-mcp-bridge instalada e o token configurado."*

### Token

- No primeiro start, o servidor gera 32 bytes hex aleatórios e salva em `%USERPROFILE%\.ff-mcp-bridge\token` (reutiliza nas próximas vezes).
- O servidor **imprime no stderr** (nunca no stdout, que é o canal do MCP) o caminho do arquivo do token e uma linha de instrução.
- A página de opções da extensão tem um campo "Token" e um campo "Porta"; salva em `browser.storage.local`. Ao salvar, a extensão reconecta.

## 5. Extensão: `manifest.json`

```json
{
  "manifest_version": 2,
  "name": "ff-mcp-bridge",
  "version": "0.1.0",
  "description": "Local bridge that lets an MCP client control this Firefox.",
  "browser_specific_settings": { "gecko": { "id": "ff-mcp-bridge@local", "strict_min_version": "115.0" } },
  "permissions": ["tabs", "activeTab", "storage", "webNavigation", "webRequest", "<all_urls>", "scripting"],
  "background": { "scripts": ["background.js"], "persistent": true },
  "content_scripts": [{ "matches": ["<all_urls>"], "js": ["content.js"], "run_at": "document_start", "all_frames": false }],
  "options_ui": { "page": "options.html", "open_in_tab": true },
  "icons": { "48": "icons/icon-48.png", "96": "icons/icon-96.png" }
}
```

Observação: se `"scripting"` for rejeitada em MV2 pelo `web-ext lint`, remova-a e use `browser.tabs.executeScript`/`sendMessage`.

## 6. Ferramentas MCP (nomes e contratos)

Todas as tools aceitam `tabId` (número, opcional; padrão = aba ativa da janela atual). Valide as entradas com `zod`. Erros viram `isError: true` com texto legível.

| Tool | Parâmetros | Retorno |
|---|---|---|
| `tabs_context` | — | Lista de `{tabId, title, url, active, windowId}` |
| `tabs_create` | `url?` | `{tabId}` |
| `tabs_close` | `tabId` | `ok` |
| `navigate` | `url` (ou `"back"`/`"forward"`), `tabId?` | Espera `status=complete` (timeout 30s) e devolve `{url, title}` |
| `read_page` | `filter?: "interactive"\|"all"`, `max_chars?` (padrão 50000), `ref_id?` | Árvore de acessibilidade em texto YAML-like, com `[ref_N]` por elemento |
| `find` | `query` | Até 20 elementos cujo role/nome/texto contém `query` (case-insensitive), com `ref_N` |
| `get_page_text` | `max_chars?` | `innerText` do `article`/`main` ou do `body` |
| `computer` | `action` + parâmetros (abaixo) | Texto ou imagem |
| `form_input` | `ref`, `value` | Define valor de input/textarea/select/checkbox/contenteditable e dispara `input`+`change` |
| `javascript_tool` | `text`, `world?: "content"\|"page"` | Resultado serializado em JSON da última expressão (suporta `await` de topo) |
| `read_console_messages` | `limit?`, `onlyErrors?`, `pattern?` | Mensagens capturadas desde que o content script carregou |
| `read_network_requests` | `limit?`, `urlPattern?` | `{method, url, status, type}` via `webRequest` (somente metadados) |

### `computer` — ações do MVP

`screenshot`, `left_click`, `right_click`, `double_click`, `type`, `key`, `scroll`, `scroll_to`, `hover`, `wait`.

- Clique aceita `coordinate: [x,y]` **ou** `ref`.
- `type` precisa de `text`; `key` aceita combinações separadas por espaço (`"ctrl+a Backspace"`); `scroll` usa `coordinate`, `scroll_direction`, `scroll_amount`; `wait` usa `duration` (máx. 10s).

### Detalhes de implementação que o agente não pode errar

1. **Referências (`ref_N`)**: o content script mantém `Map<string, WeakRef<Element>>` com contador crescente por aba. `read_page` percorre o DOM e ignora `script/style/noscript` e elementos ocultos (`display:none`, `visibility:hidden`, `aria-hidden=true`). Role = `aria-role` ou mapeamento da tag (`a→link`, `button→button`, `input[type]→textbox/checkbox/...`, `h1-6→heading`). Nome = `aria-label` > `labels` > `alt` > `placeholder` > texto (truncado em 100 caracteres). `filter:"interactive"` retorna só links, botões, inputs, selects, textareas, elementos com `tabindex>=0` e com `role` interativo. Se a ref estiver morta (elemento removido), retorne erro: *"ref expirada, rode read_page de novo"*.
2. **Screenshot**: use `browser.tabs.captureVisibleTab(windowId, {format:"png"})`. Redimensione no background (canvas) para a **largura da viewport em CSS px**, para que as coordenadas da imagem sejam as mesmas dos cliques. Para obter viewport e `devicePixelRatio`, peça ao content script. Retorne como conteúdo MCP `{type:"image", data:<base64 sem prefixo>, mimeType:"image/png"}`. Se o PNG passar de ~1,5 MB, use JPEG qualidade 0.8.
3. **Clique**: `scrollIntoView({block:"center"})` se necessário, depois dispare `pointerdown → mousedown → pointerup → mouseup → click` com `bubbles/cancelable/view` e coordenadas. Por fim chame `.focus()` se o elemento for focável. Para `<a>`, `<button>`, `<input type=checkbox/radio>`, o `.click()` nativo também é aceitável como fallback.
4. **Digitação**: foque o elemento ativo; para `input/textarea` use o setter nativo (`Object.getOwnPropertyDescriptor(proto,"value").set`) e dispare `input`; para `contenteditable` use `document.execCommand("insertText", false, text)`. `key` dispara `keydown/keypress/keyup`; `Enter` em formulário também chama `requestSubmit()` quando o elemento é input de texto dentro de `<form>`.
5. **`javascript_tool`**: `world:"content"` (padrão) executa no content script via `new Function` assíncrono. `world:"page"` injeta `<script>` com o código e devolve o resultado por `window.postMessage` com nonce aleatório; se a CSP bloquear, retorne o erro explicando.
6. **Console**: o content script injeta, no mundo da página, um `<script>` que envolve `console.log/info/warn/error/debug` e `window.onerror`, e repassa via `postMessage` com nonce. Guarde até 500 entradas por aba.
7. **Rede**: `browser.webRequest.onCompleted` e `onErrorOccurred` com filtro `<all_urls>`; guarde 500 entradas por aba (`tabId`).
8. **Páginas restritas** (`about:`, `moz-extension:`, `addons.mozilla.org`, visualizador de PDF, páginas de erro): o content script não carrega. Retorne: *"Esta página não permite scripts (URL restrita do Firefox)"*. Não trave nem estoure timeout.
9. **Timeout**: o servidor falha a requisição após 30s com mensagem clara. Limpe o `Map` de pendentes ao desconectar (rejeite todas).
10. **Reconexão**: a extensão tenta reconectar com backoff exponencial de 1s até 15s. O badge do ícone fica verde (`ON`) quando conectado e vermelho (`OFF`) quando não.
11. **Logs**: o servidor nunca escreve no stdout além do protocolo MCP. Use `console.error`.

## 7. Servidor: `server/src/index.js`

- `McpServer` com `StdioServerTransport`.
- Registre cada tool com `zod`. Cada handler chama `bridge.request(method, params)`.
- Respostas de texto: `{content:[{type:"text", text}]}`. Imagem: `{content:[{type:"image", data, mimeType}]}`.
- `package.json` do servidor: `"bin": { "ff-mcp-bridge": "src/index.js" }`, shebang `#!/usr/bin/env node`, `"type":"module"`.
- Sem build step. Rode direto com `node server/src/index.js`.

## 8. Ordem de execução (com tempo estimado)

1. **(10 min)** Criar a estrutura, `package.json`, `.gitignore`, `LICENSE`, `npm install`.
2. **(20 min)** `bridge.js` + `index.js` com apenas `tabs_context` e `navigate`; `scripts/smoke-test.mjs`. Teste com um cliente WebSocket falso.
3. **(25 min)** `manifest.json`, `background.js` (conexão, reconexão, badge, roteamento por `method`), `options.html/js`.
4. **(40 min)** `content.js`: `read_page`, `find`, `get_page_text`, refs, `form_input`, clique, digitação, tecla, rolagem, hover.
5. **(20 min)** Screenshot, `javascript_tool`, console, rede, `tabs_create/close`.
6. **(15 min)** Testes manuais no Firefox (seção 9), correção de bugs.
7. **(15 min)** README, ícones, `npx web-ext lint`.
8. **(10 min)** Git e GitHub (seção 10).

Se algum passo estourar o tempo, **corte**, nesta ordem: `read_network_requests`, `world:"page"`, `hover`, `right_click`. Nunca corte: `tabs_context`, `navigate`, `read_page`, `find`, `computer` (`screenshot`, `left_click`, `type`, `key`, `scroll`), `get_page_text`.

## 9. Verificação (obrigatória antes de dizer "pronto")

**A. Automática (sem Firefox)**
- `node scripts/smoke-test.mjs`: sobe o `bridge`, conecta um WebSocket falso com `Origin: moz-extension://x` e o token correto, responde a `tabs_context` e verifica que (1) token errado é rejeitado, (2) `Origin` de `http://` é rejeitado, (3) a requisição expira com mensagem clara se ninguém responder, (4) sem extensão, o erro é o texto da seção 4.
- `npx --yes web-ext lint --source-dir extension`: sem erros (avisos são aceitáveis; cite-os).

**B. Manual no Firefox**
1. `npx --yes web-ext run --source-dir extension --firefox-profile ff-mcp-dev --keep-profile-changes` (abre um Firefox com perfil de teste e a extensão carregada). Alternativa: `about:debugging` → "Este Firefox" → "Carregar extensão temporária" → `extension/manifest.json`.
2. Abra as opções da extensão, cole o token (de `%USERPROFILE%\.ff-mcp-bridge\token`) e confirme que o badge fica `ON`.
3. Registre no Claude Code: `claude mcp add ff-mcp-bridge -- node D:\codigos\ff-mcp-bridge\server\src\index.js` (ajuste o caminho).
4. Teste real, numa sessão do Claude Code: *"use ff-mcp-bridge para abrir https://example.com, ler a página, tirar screenshot e clicar no link 'More information'"*.
5. Teste de formulário numa página com `<input>` (ex.: busca do DuckDuckGo): digitar, `Enter`, ler resultados.
6. Teste de página restrita (`about:preferences`): deve devolver o erro amigável, sem travar.
7. Desconecte e reconecte: feche o servidor, reabra e confirme que o badge volta a `ON` sozinho.

Registre no README uma tabela "testado / não testado" com o resultado real.

## 10. Git e GitHub (faça hoje)

Rode na raiz do projeto:

```powershell
git init -b main
git add .
git commit -m "feat: initial ff-mcp-bridge (Firefox extension + MCP server)"
gh auth status
```

- Se `gh auth status` estiver OK: `gh repo create ff-mcp-bridge --public --source . --remote origin --push --description "Firefox extension + local MCP server so Claude Code (or any MCP client) can control Firefox"`.
- Se **não** estiver autenticado ou não houver `gh`: **pare e entregue** ao usuário estes comandos (ele cria o repo vazio no site e roda):

```powershell
git remote add origin https://github.com/<USUARIO>/ff-mcp-bridge.git
git push -u origin main
```

- Antes do commit, **verifique que não há segredos**: o token fica fora do repo (está em `%USERPROFILE%`). Rode `git status` e `git ls-files` e confira.
- Depois de publicar, crie uma tag `v0.1.0`. **Não** publique na AMO hoje (exige assinatura/revisão). Para uso permanente: `npx web-ext sign --channel=unlisted` com chaves AMO do próprio usuário, documentado no README.

## 11. README: conteúdo mínimo

1. O que é e o que **não** é (não é um produto da Anthropic; não afiliado).
2. Diagrama da seção 2.
3. Instalação em 5 passos (clone → `npm install` → carregar extensão → colar token → `claude mcp add`).
4. Tabela de ferramentas.
5. **Segurança**: o servidor só escuta em `127.0.0.1`; o token autentica a extensão; a extensão tem `<all_urls>`, então tem acesso total às abas, e quem controla o servidor controla o navegador. Não exponha a porta. Recomende usar um perfil dedicado do Firefox para automação.
6. **Limitações conhecidas**: eventos sintéticos (`isTrusted=false`) falham em alguns sites (botões que exigem gesto real, captchas, alguns editores ricos); sem `debugger`, então sem emulação de dispositivo nem interceptação de corpo de requisições; páginas restritas do Firefox; apenas uma extensão conectada por servidor; uma porta fixa implica que duas sessões do Claude Code simultâneas disputam a porta (use `FF_MCP_PORT` diferente + porta nas opções).
7. Tabela "testado / não testado".
8. Roadmap curto: native messaging, múltiplas sessões, `resize_window`, gravação de GIF, grupo de abas.

## 12. Definição de pronto

- [ ] `smoke-test.mjs` passa.
- [ ] `web-ext lint` sem erros.
- [ ] Teste manual 1-7 da seção 9 executado e resultado registrado.
- [ ] Repositório no GitHub (ou comandos entregues ao usuário) com a tag `v0.1.0`.
- [ ] Resumo final ao usuário: o que funciona, o que não foi testado, limitações, e como registrar no Claude Code.
