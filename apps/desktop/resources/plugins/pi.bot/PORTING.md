# MiniMax Bot → PI-Desktop 源码级移植说明

> **结论**：MiniMax Code 下发的官方插件 `minimax-bot` **v0.7.31** 已全量移植为 PI-Desktop 0.21.0 的内置插件 `pi.bot`。原包 **103 个文件逐字节未改**（全量 SHA-256 复核一致），新增 8 个适配层文件 + 1 份移植说明。三档能力桥全部落地：**L1 纯文本 / L2 本地工具循环 / L3 native（宿主完整 Agent 回合，含 shell）**，并按 0.7.31 新契约实现了**会话级排队**（`whenBusy:'queue'` + `run.queued`）。L3 采用 `desktop.control` 官方通道，不需要 `agent.extension` 高风险授权。
>
> 移植时间：2026-11-13　最近升级：2026-11-23（0.7.24 → 0.7.31）　目标项目：`E:\PI-Desktop-dev`　落点：`apps/desktop/resources/plugins/pi.bot/`

> **验证范围说明**：下文“原包 103 文件哈希一致”“仅新增插件目录”和“未修改现有文件”等表格/结论记录的是 2026-11-13 初次移植时的快照，不代表当前工作树。后续已在内置插件中补入兼容和可靠性改动，2026-11-23 的当前 Git 变更应以 `git status` 和对应测试为准。

---

## 0. 一页速览

| 项 | 值 |
|---|---|
| 原包来源 | `E:\UserData\minimax\v2\plugin-cache\official\sha256-tree-v1-2cf8fd02…\`（v0.7.31） |
| 落点 | `E:\PI-Desktop-dev\apps\desktop\resources\plugins\pi.bot\`（内置插件目录，host-core 自动扫描，**不改主程序一行**） |
| 原源码 | 103 文件 / 2.8 MB，**零改动**（`miniapp/`、`tests/`、`.minimax-plugin/`、README、icon、原 package.json 全保留） |
| 新增适配层 | 9 文件：`manifest.json`、`main.cjs`、`panel/index.html`、`host/agent-bridge.mjs`、`host/native-bridge.mjs`、`host/miniapp-context.mjs`、`host/session-queue.mjs`、`host/standalone.mjs`、`host/queue-selftest.mjs`（另加本说明文档 `PORTING.md`，合计 10 个新文件） |
| 插件清单 | PI-Desktop 规范 `manifest.json`，已通过项目自带 `validateManifest()` 校验 |
| 入口 | `main.cjs`（CommonJS）—— 因为原包 `package.json` 是 `"type": "module"`，`.cjs` 才能被 `require()` 加载 |
| 页面 | `ui.panel` → `panel/index.html` → iframe 指向本机回环服务 `/bot`，**原版 client 零改写**；同一份 HTML 也注册成 `contributes.views`，成为工作面板「新建」列表里的一行 |
| 入口 | ① 工作面板「新建」→ MiniMax Bot（停靠视图，无标题栏）② 插件启动器 `Alt+Space` 输 `bot` ③ 命令面板「打开独立窗口」（1180×780）④ 视图右下角「独立窗口」按钮 |
| 资源 | **按需启动**：不开窗口不跑 Bot 服务，页面关掉 ~5 秒后回收（见 §5.3） |
| 模型桥 | `pi.agent.complete` + `pi.models.list`，默认 `loop` 模式（工具循环 + 团队工具）；`complete` 为纯文本降级档，`native` 用宿主完整 Agent 回合（需 `PI_BOT_AGENT_MODE=native` 显式开启） |
| 排队 | 声明 `capabilities.has('agent.run')`，同一 Bot 会话忙时按 `whenBusy:'queue'` 排队并回 `run.queued`，等满 10 分钟由引擎判 BUSY（0.7.31 契约） |
| 验证 | **L3 native 自测 14/14**、L2 回归 13/13、L1 回归 11/11、排队专项 11/11、并发集成 6/6、上游 442 项测试 439 通过（3 项为 Windows 文件锁/并发写的老问题）、清单校验 OK |
| Git 影响 | 仅新增 `?? apps/desktop/resources/plugins/pi.bot/`，**未修改任何现有文件**（项目原有 20+ 个改动文件全部保持原样） |

---

## 1. 目录映射

```
apps/desktop/resources/plugins/pi.bot/
├── manifest.json                  ← 新增：PI-Desktop 插件清单
├── main.cjs                       ← 新增：插件入口（onLoad / onUnload / onPanelInvoke）
├── panel/index.html               ← 新增：面板容器（iframe + 面板桥取地址）
├── host/
│   ├── agent-bridge.mjs           ← 新增：MiniAppAgentClient 契约适配 + L1/L2 工具循环
│   ├── native-bridge.mjs          ← 新增（L3）：desktop.control 完整 Agent 回合 + 事件流翻译
│   ├── miniapp-context.mjs        ← 新增：端口/数据目录/日志/生命周期/三模式分发
│   ├── session-queue.mjs          ← 新增：会话级串行队列（0.7.31 的 whenBusy:'queue'）
│   ├── queue-selftest.mjs         ← 新增：排队回归（桥接层 + 引擎全链路）
│   └── standalone.mjs             ← 新增：脱离 PI-Desktop 的独立运行与自测入口
├── miniapp/                       ← 原包，一字未改
│   ├── client/                    原生 ESM 页面（app.js / panels.js / skins/ …）
│   ├── node/                      server.mjs / engine.mjs / team.mjs / store.mjs /
│   │                              task-dispatcher.mjs / memory.mjs / mcp.mjs / …
│   ├── miniapp.json               原 MiniApp 清单（surface.path=/bot）
│   └── package.json              原包元信息（type: module）
├── .minimax-plugin/plugin.json    原插件清单（schemaVersion 1 / minimax-bot 0.7.31）
├── servers.mcp.json               原 MCP 端点声明
├── tests/                         原 40+ 测试，全量保留
├── README.md / LICENSE / icon.png 原文档与资源
└── PORTING.md                     本文件
```

**为什么放内置目录**：`apps/desktop/electron/main/host-process.ts:56` 的 `resolveBuiltinPluginsDir()` 会把 `resources/plugins` 传给 host-core 自动对账，源码树与打包后都识别；不需要注册任何清单、不碰主程序。若想当「开发插件」手动加载，把整个目录复制到 `examples/plugins/pi-bot/` 并用「Load development plugin」即可，代码不用改。

---

## 2. 架构与调用链

```
PI-Desktop 主进程
  └─ plugin-host-process.mjs（utilityProcess，独立 Node 进程）
       └─ main.cjs（全局 pi.* 走宿主代理）
            ├─ pi.services.register → 宿主在 onLoad 后拉起，保持常驻
            ├─ pi.plugin.getDataPath() → 插件私有数据目录
            └─ host/miniapp-context.mjs
                 ├─ 选空闲回环端口、构造 AbortSignal / logger
                 ├─ 注入 context.agent = host/agent-bridge.mjs
                 └─ 动态 import() 原 miniapp/node/server.mjs  ← 源码零改动
                      ├─ /bot、/bot/*.js|css、/api/*、/mcp/minimax-bot、SSE
                      ├─ Store / MemoryStore / Engine / Team / TaskDispatcher
                      └─ 每个 Bot 回合 → context.agent.run()
                           ├─ L1：pi.agent.complete（一次性补全）
                           └─ L2：本地 Agent 循环 → pi.fs.* / pi.net.fetch / 内部 MCP

渲染层
  └─ ui.panel → panel/index.html
       └─ pluginBridge.invoke('pibot.origin') 拿回 http://127.0.0.1:<port>
            └─ iframe 同源加载 /bot（原 client 的 /api/* 与 EventSource 无需改写）
```

**关键设计**：原插件只依赖 `MiniAppContext`（`pluginRoot / dataDir / listen / signal / logger / agent`）。把这份上下文「伪造」齐，原 `server.mjs` 就以为自己还跑在 MiniMax Code 里——这是源码零改动能成立的原因。

---

## 3. 能力差异的解法（三档）

原 MiniMax Bot 的每个回合是**带文件 / shell / MCP 工具的完整 Agent**；PI-Desktop 的 `pi.agent.complete` 规范明确写着 `tools: []`（`docs/spec/07-plugins/03-plugin-api.md:1040`），且限流 8 次/60 秒/插件、90 秒预算。直接桥接会得到一个「只会聊天」的 Bot。三条官方通道实测如下：

| 通道 | 证据 | 能否用于「用户直接跟 Bot 聊天」 |
|---|---|---|
| `pi.agent.complete` | `03-plugin-api.md:1024` | ✅ 能，但无工具 |
| `session/collaboration/spawn`（新开独立 Agent 会话，带全套工具） | `session-collaboration-control.ts:12`、`03-plugin-api.md:948`、`services/session-collaboration.ts:107` | ❌ `sender()` 硬校验 `sessionId + turnId + invocationId` 且必须匹配当前活跃回合，面板直聊进不去 |
| **`desktop.control` 的 `agent/prompt`** | `mcp-control.ts:202/373`、`plugin-runtime.ts:6090-6208` | ✅ **`write` 级普通操作，网关只查 operation 存在与参数形状，没有活跃回合校验**；配 `session/create` 可跑带全套工具的真实 Agent 回合 |
| `agent.extension`（代码跑进 Agent sidecar） | `16-trusted-extensions.md:274-284` | ⚠️ 需要高风险授权、marketplace 禁止分发，且仍缺「面板 → sidecar」触发链路；`sendUserMessage`（`runtime.ts:3043`）会把消息塞进用户当前会话队列，污染主聊天 |

### 落地的三档

| 档 | 模式 | 补齐的能力 | 仍缺 |
|---|---|---|---|
| **L1** | `complete`（只聊天降级档） | 对话、@ 点名接力、`[PASS]` 跳过、群纪要、团队记忆、定时任务、派活、用量、21 个 MCP 工具 | 文件 / 网络 / shell、工具审批弹窗 |
| **L2** | **`loop`（默认）** | 插件进程内本地 Agent 循环：工具清单写进 system（系统提示词），模型以 JSON 输出工具调用，适配层解析执行再喂回。**工具全走受控网关**：`pi.fs.*`（受 scope）、`pi.net.fetch`（受 `net.domains`）、`bot_tool`（本地回环直调原 21 个 MCP 工具）；合成 `tool.started/tool.finished` | 任意 shell 命令、宿主级工具审批弹窗 |
| **L3** | `native`（可选，显式开启） | 每个 Bot 建一个 PI-Desktop 独立 durable session，`agent/prompt` 触发**宿主完整 Agent 回合（bash / edit / write / MCP 全套工具）**，订阅 `desktop:agentEvent` 把 `message_update` / `tool_start` / `tool_end` / `tool_permission_request` 翻译成原版事件流，`desktop:turnEnded` 收口，`session/get` 兜底读回复 | 宿主级 Ask 问卷（只观测不代答）；与 MiniMax 云端 Agent 的实现细节不可能逐字节一致 |

**为什么 L3 没按原计划用 `agent.extension`（纠偏）**：动手前把 `plugin-runtime.ts` / `mcp-control.ts` / `session-collaboration.ts` 的实现读死，发现 `desktop.control` 的 `agent/prompt` 是普通 `write` 操作、`session/create` 能建独立会话、事件订阅能拿实时流——**不需要高风险授权就能拿到同样甚至更完整的工具能力**，还天然解决「每 Bot 独立会话」和「会话窗口限制」，更不会被 marketplace 拒。所以 L3 落地为 `native`（`host/native-bridge.mjs`），`agent.extension` 保留为可选升级路径，不硬塞进清单拖累分发。

**L2 的限流与降级**：`pi.agent.complete` 8 次/60 秒是宿主硬限。适配层用全局令牌桶压到 **6 次/60 秒**、单回合最多 **4 步**、工具结果截 8,000 字符、历史保留 40 条 / 120,000 字符；撞限流返回带 `BUSY` / `AGENT_UNAVAILABLE` 码的错误，原 `engine.mjs` 自己决定重试或显示重试按钮。

**L3 的健壮性**：启动时 `probe()` 用 `pi.desktop.listOperations()` 检查 `session/create / agent/prompt / agent/getStatus / session/get` 是否齐全，缺任意一个**自动降级到 L2** 并记日志；`subscribeAgentEvents` 不可用时退回 `agent/getStatus` 轮询；`desktop:turnEnded` 是唯一 durable 收口回执，`agent_end` / `turn_end` 不当完成依据；`reason: 'unknown'` 只用 `session/get` 兜底、绝不重放回合；单回合 120 秒超时、abort 时发 `agent/abort`。

**默认档位是 `loop`**，不是 `native`。这是踩过坑之后定的：

> `create_bot` / `create_group` / `remember` / `dispatch_tasks` 这些**团队工具只挂在插件自己的 MCP 端点**（`/mcp/minimax-bot`）上，宿主 Agent 看不到它们；`native` 走的是宿主自己的回合，于是「建 Bot、建群、记记忆、派任务」全部失效，连 Bot 的人格 `instructions` 也传不过去（`native-bridge` 只发用户那句话）。用户报「让它创建一个群都做不到」，根因就在这类口径错配。

| 档位 | 建议用途 |
|---|---|
| `loop`（默认） | 干正事：文件 + 网络 + **全套团队工具**，人格完整 |
| `native` | 想借宿主全套工具（bash/edit/写码/MCP）时显式开，接受团队工具失效 |
| `complete` | 只聊天 |

**切换方式**：启动 PI-Desktop 前设 `PI_BOT_AGENT_MODE=complete|loop|native`。`main.cjs` 读取它；独立自测用 `--mode`。**启用 native 需要在插件页重新授予 `desktop.control`**（新权限会导致安装审查，缺失会报 `PLUGIN_PERMISSION_DENIED`），但不需要 `agent.extension` 那种高风险授权。

---

## 4. 适配层文件说明

| 文件 | 职责 | 关键实现 |
|---|---|---|
| `main.cjs` | PI-Desktop 插件入口 | 注册命令 `pibot.open`（打开独立窗口）、`onPanelInvoke('pibot.origin' / 'status' / 'touch' / 'release' / 'openWindow')`；**不注册常驻服务**：Bot 服务在首次界面请求时才拉起，无消费者后由空闲回收器关掉（见 §5.3） |
| `host/miniapp-context.mjs` | 宿主差异收敛层 | 临时占端口拿号码（`server.mjs` 只收 `listen.port`、不回传实际端口，EADDRINUSE 自动重试 4 次）、构造 `MiniAppContext`、动态 `import()` 原 `server.mjs`、`/bot` 就绪探测、favicon 宿主级守卫（`favicon.ico → 204`，原版由 Electron 兜底，不改源码）、dispose 时恢复原型 |
| `host/agent-bridge.mjs` | `MiniAppAgentClient` 契约适配 | `run / answer / reply / models`；按 `sessionId` 维护每 Bot 独立历史；合成 `turn.started → text.delta → message.committed → turn.finished` 事件流；L2 工具循环；`pi.models.list()` → 原 catalog 形状；错误分类成 `AGENT_UNAVAILABLE / INVALID_ARGUMENTS / BUSY / REQUEST_CANCELLED` 并带 `retryable` |
| `host/native-bridge.mjs` | **L3 native** | `session/create` 建每 Bot 独立会话 → `agent/prompt` 跑宿主完整回合 → `desktop:agentEvent` 翻译 `text.delta` / `tool.started` / `tool.finished` / `permission.requested` → `desktop:turnEnded` 收口 → `session/get` 兜底；`probe()` 缺操作自动降级 L2，事件订阅不可用改轮询，unknown 不重放 |
| `host/standalone.mjs` | 独立运行 + 自测 | mock 宿主（可预测的模型 / fs / net），`--selftest` 自动跑 13 项断言并退出；开发时 `node host/standalone.mjs --mode loop` 直接看原版 UI |
| `panel/index.html` | 面板容器（一套页面两种落位） | `pluginBridge.invoke('pibot.origin')` 拿地址 → 先自己 `fetch(no-cors)` 探一次本地服务是否可达 → 可达才挂 iframe。连上后**不显示任何常驻状态条**，只有出问题时浮一条覆盖层；右下角半透明圆点收着「独立窗口 / 浏览器 / 重连」。`body` 用 `var(--pi-plugin-titlebar-height, 0px)`，视图里是 0、独立窗口里是 46 |
| `manifest.json` | PI-Desktop 清单 | 见 §5 |

**原插件 `engine.mjs` 依赖的事件与字段全部对齐**：`turn.started` 会写入 `message.sessionId` 并落会话；`text.delta` / `message.committed` 复用尾部文本片段；`tool.*` 画工具气泡；`turn.finished` 收口；`models()` 让页面显示模型选择器。

---

## 5. 权限清单与理由

| 权限 | 用途 |
|---|---|
| `ui.panel` | 打开独立窗口（`pi.ui.openPanel()`），也是启动器触发词的前置条件 |
| `ui.view` | 把 Bot 界面注册成工作面板里的一个标签页（`contributes.views`），即「新建」列表里那一行 |
| `agent.complete` | Bot 回合的模型推理（走宿主凭据与配额，插件拿不到密钥） |
| `models.list` | 填充「每个 Bot 单独设模型/推理强度」的选择器 |
| `fs.read` / `fs.write` | L2 的 `read_text` / `write_text` / `list_dir` / `glob` 工具 |
| `net.fetch` | L2 的 `fetch` 工具 |
| `desktop.control` | **L3 native**：`session/create` / `agent/prompt` / `agent/getStatus` / `session/get` / `subscribeAgentEvents`。安装时确认一次；缺失时宿主会报 `PLUGIN_PERMISSION_DENIED: missing grant for desktop.control`，必须重新授权 |
| `shell.openExternal` | 面板的兜底出口「在浏览器打开」：宿主把面板网络策略拦死时，至少能一键在系统浏览器里用同一套 UI |

`fs` scope：`read = workspace/**/*`（读可整树）、`write = workspace/pi-bot/**` + `*.md`（写按规范不允许整树通配，已收窄）。
`net.domains = ["127.0.0.1", "localhost"]`：面板 iframe 与内部 MCP 回环调用必需。`plugin-sdk/src/net-policy.ts:40` 的 `isLocalNetDomain()` 会把回环条目标记为「本地服务」并在工具里给出警告，属于预期的合法用法，不是配置错误。

### 5.1 面板打开后一片空白（已修，未改宿主）

**现象**：插件服务明明起来了（日志有 `pi.bot.started http://127.0.0.1:<port>`），点「打开面板」却只看到一张白纸。

**根因**：宿主里有两条打开面板的路径，参数不一致——

| 路径 | 位置 | 是否带 `manifest.net.domains` |
|---|---|---|
| 插件自己调 `pi.ui.openPanel()` | `plugin-runtime.ts:5973` | ✅ 传了 |
| 宿主 UI 的「打开面板」按钮 | `ipc/plugin-ui-ipc.ts:159` | ~~❌ 没传~~ **已修，见 §5.1.1** |

漏传后 `PluginPanelHost.applyEgressPolicy()` 拿到 `netDomains: undefined`，`applyPluginEgressPolicy()` 里 `const domains = input.netDomains ?? []` 就是空数组，于是面板 session 的 `webRequest.onBeforeRequest` 把 `http://127.0.0.1:<port>/bot` 当成越权出站直接 `cancel`，iframe 收到的是一张空文档。

**证据**（真实运行日志）：

```
"code":"PERMISSION_DENIED","data":{"api":"panel.egress","ok":false,"url":"http://127.0.0.1:54324/bot"}
```

**插件侧兜底（保留）**：`PluginPanelHost.open()` 遇到已存在的窗口时会用新参数**重新** `applyEgressPolicy`。所以面板加载时让插件用带白名单的那条路径再开一次，白名单就被补上：

1. `panel/index.html` 在设置 `iframe.src` **之前**调 `pluginBridge.invoke("pibot.ensurePolicy")`；
2. `main.cjs` 收到后调 `pi.ui.openPanel()`——走的是 `plugin-runtime.ts:5973` 那条带 `netDomains` 的路径；
3. 宿主把已存在窗口的策略替换成正确白名单，iframe 正常加载。

宿主修复后这条对源码宿主已是冗余，保留只为让插件跑在尚未更新的打包版宿主上也不白屏；只在独立窗口形态触发，停靠视图直接跳过（视图由宿主一直正确下发，多调会凭空多弹一个窗口）。

**同时加的兜底**（就算日后宿主策略再变，也不会再白屏）：

- 面板自己先 `fetch(origin + '/bot', { mode: 'no-cors' })` 探一次再决定挂不挂 iframe。**这一条是后来补的**，因为 Chromium 加载失败时照样会触发 iframe 的 `load` 事件，网页侧分辨不出来——原来的 8 秒兜底会被这个假 `load` 提前清掉，结果还是白纸。`fetch` 走同一套 session 网络策略，被拦就 reject，这是唯一能问出真相的办法；
- 探不通 → 直接浮出「面板连不上本地服务」＋诊断详情（宿主给的 `manifest.net`、`permissions`、`pi.net.fetch` 自测结论），并给出三条出路；
- 右下角圆点里的「浏览器」走 `shell.openExternal`，面板被拦也能用同一套 UI。

#### 5.1.1 宿主侧根治（已实施）

给 `ipc/plugin-ui-ipc.ts` 的 `pluginPanels.open({...})` 补上三项，并复用 `plugin-runtime.ts` 同源的 `parseNetDomains()`，避免另写一套校验：

```ts
const parsedDomains = parseNetDomains(manifest.net?.domains);
const netDomains = parsedDomains.ok ? (parsedDomains.domains ?? []) : [];
// ...
netDomains,
netAnyHost: loaded.permissions.has("net.anyHost"),
allowMicrophone: loaded.permissions.has("ui.microphone"),
```

顺带修掉 `plugin-panel-host.ts` 的 `applyEgressPolicy()`：它只往下传了 `netDomains` 和 `allowMicrophone`，**把 `netAnyHost` 丢了**（停靠视图那条 `plugin-view-host.ts:515` 是传全的，两条路径不对称）。不补这一行，上面新加的 `netAnyHost` 就是死代码——`applyPluginEgressPolicy()` 里 `anyHost: input.netAnyHost === true` 恒为 `false`，声明了 `net.anyHost` 的插件在独立窗口里依然被拦。

这两处都属于**补全 manifest 已声明的授权**，不放宽任何权限：未声明的 host 照样拒绝，云元数据地址（`169.254.169.254`）即使 `anyHost` 也依旧拒绝。

自验：`tsc --noEmit` 0 错误；`parseNetDomains(["127.0.0.1","localhost"])` → `ok:true`（IPv4 不被误判，这点必须验，否则修了也白修）；`isNetUrlAllowedWithGrant` 对 `http://127.0.0.1:56239/bot` 为 `true`，对未声明外网为 `false`，对云元数据在 `anyHost:true` 下仍为 `false`。

### 5.2 入口形态：一个界面，三种落位

同一份 `panel/index.html` 同时服务三种落位，靠宿主写的 `data-pi-plugin-panel-shape`（`view` / `panel` / `widget`）分流；读不到就用 `--pi-plugin-titlebar-height` 兜底（视图恒为 0px）。

| 落位 | 怎么进 | 有无线程拖动带 | 白名单来源 | 关闭时 |
|---|---|---|---|---|
| **停靠视图**（主推） | 右侧工作面板「新建」→ **MiniMax Bot** | 无（0px，内容拿满） | `ipc/plugin-ui-ipc.ts:327` 正确下发 `netDomains` | 宿主 `destroy()` → `webContents.close()`，页面真销毁 |
| **独立窗口** | 命令 `pibot.open`、视图右下角「独立窗口」、启动器 | 26px 宿主标题栏 | `plugin-runtime.ts:5988` 带 `netDomains` ✅ | 窗口关闭即销毁 |
| 浮动挂件 | （未启用） | 无 | — | — |

视图的注册就三行（`manifest.json`）：

```json
"contributes": { "views": [{ "id": "bot", "title": { "en": "MiniMax Bot", "zh-CN": "MiniMax Bot" },
  "icon": "bot", "entry": "panel/index.html", "order": 5 }] }
```

宿主的过滤条件（`ipc/plugin-ui-ipc.ts:187-210`）：持有 `ui.view`、在当前项目活跃、`view.entry` 文件真实存在。本插件三条都满足，所以会出现在「新建」列表里。`icon` 只能取宿主闭集里的 token（`bot` 在列），插件不能自带 SVG。

另外两条入口，不用改代码就已经生效：

- **插件启动器**（`Alt + Space`）→ 输入 `bot` / `团队` / `机器人` / `minimax` 直接开（`contributes.launcherTriggers`，正则匹配整段输入）；
- **命令面板** → 搜「MiniMax Bot: 打开独立窗口」；
- **「新建」列表悬停箭头**（宿主侧新增）→ 鼠标移到 **MiniMax Bot** 那一行，右侧浮出一个 ↗ 按钮，点它直接开独立窗口，点行本身仍是开标签页。只有声明了 `ui.panel` 的插件才会出现这个按钮（`WorkPanel.tsx` 的 `openWindowPluginId`），纯视图插件（如文件管理器）不会做无用功。

### 5.2.1 页头配色：为什么必须动态

**现象**：独立窗口顶部那条 26px 拖动带，颜色和下面的界面不一致——换一次主题就撞一次色。

**根因**：拖动带的颜色不是写死的，是宿主 preload **采样这个页面 `document.body` 的 `background`** 得来的（`plugin-preload` 的 `pageSurface()` → `--pi-plugin-panel-page-background`）。而 panel 页和 iframe 里的原版界面是两套配色来源：panel 页写死什么色，页头就是什么色，跟内容毫无关系。

**修法**：panel 页的配色改成跟着 `prefers-color-scheme` 动态走，深浅两套色值直接抄原版 `miniapp/client/app.css`：

| 变量 | 浅色（原版 `:root`） | 深色（原版 `[data-theme='dark']`） |
|---|---|---|
| `--page`（被采样） | `#fcfcfc` | `#141414` |
| `--fg` | `#141414` | `#f2f2f2` |
| `--muted` | `#6e6e6e` | `#9a9a9a` |
| `--line` | `rgba(20,20,20,.1)` | `rgba(255,255,255,.08)` |

为什么这个媒体查询就一定准：原版客户端的默认 `theme` 是 `system`，解析出来就是 `prefers-color-scheme`（`core.js` 的 `applyAppearance()`）；而 panel 页和 iframe 同处一个渲染进程，这条媒体查询对两边的答案必然相同。

**兜底**：原版也允许手动锁浅/深，那个选择存在它自己的 `localStorage` 里（origin 是 `127.0.0.1:<port>`），panel 页跨 origin 读不到。所以右下角 `⋯` 里给了「跟随系统 / 浅色 / 深色」三档手动切换，存在 panel 自己的 `localStorage`（`pibot.panel.theme`）。

**关于「无边框」的取舍**：宿主支持 `meta name="pi-plugin-chrome" content="v3"`（paint-through），能让页面内容透过那 26px 直接顶到窗口最上沿。但本插件的界面是**整屏 iframe**，iframe 顶部就是原版的标题栏（含搜索、新建按钮）；一旦内容顶进拖动带，那排按钮的点击会被窗口拖动吃掉。所以这里选择 **v2 + 同色**：内容从 26px 下方开始，但那 26px 的背景与内容完全同色，视觉上没有分界线，交互一个不少。

---

### 5.3 资源策略：不开窗口就不跑

原先的写法是注册 `contributes.services` + `background.service`，宿主 load 完插件就 `start()`，`start()` 里直接 `ensureRuntime()` —— 等于 PI-Desktop 一启动就把 Bot 的 HTTP 服务、SSE、定时任务调度器全拉起来，**一天不开面板也一直跑**。

现在改成纯按需：

| 阶段 | 行为 |
|---|---|
| 宿主 load 插件 | 只注册命令，Bot 服务**不启动**；插件进程只空转事件循环 |
| 首次 `pibot.origin` / `status` 等界面请求 | 才 `ensureRuntime()` 起服务（实测约 1 秒，面板顶部有 2px 进度条） |
| 页面还开着 | 每 20s 一次 `pibot.touch`（页面隐藏时 60s）续命 |
| 页面卸载 | `pagehide` → `pibot.release`，5 秒宽限后回收（宽限是为了区分「只是重载」和「真关了」） |
| 既没心跳也没 release | 90s 空闲后回收，兜底 |
| 回收后再打开 | 重新拉起，端口重新分配 |

`PI_BOT_IDLE_TIMEOUT_MS` 可覆盖空闲阈值（毫秒，最低 5000）。心跳计时器都 `unref()`，不会吊住宿主停插件。

**代价（说清楚）**：定时任务（原版 30 秒 tick）只在窗口开着时才会触发；窗口全关时不会按时跑。要恢复常驻，把 `contributes.services` + `background.service` 加回去，并在 `onLoad` 里 `pi.services.register({ start: ensureRuntime })` 即可 —— 两处都在 git 历史里。

实测（`test-ondemand.cjs`，11 项全过）：加载后 `running=false` → 单发心跳仍 `false` → `origin` 后 `true` → 有心跳跨过阈值不回收 → `release` 后 5 秒内回收 → 回收后能再次拉起。

### 5.4 插件从列表里消失（已修）：清单 id 不许带点号

**现象**：改完入口形态后重启 PI-Desktop，插件页「已安装」里没有 MiniMax Bot 了，`plugin.log` 里也**一条 `pi.bot` 记录都没有** —— 不是加载失败，是根本没被看到。

**根因**：`contributes.launcherTriggers[].id` 当时写成 `pibot.launcher`。宿主真正的校验在 Rust 侧（`crates/host-core`），不是 TS 的 SDK：

```rust
// crates/host-core/src/plugins/validation/contribution_ids.rs
pub(super) fn is_contrib_id(value: &str) -> bool {
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}
```

**点号不在允许字符里**。而 `views[]` 和 `launcherTriggers[]` 的 id 都走这个函数。

然后 `PluginManager::sync_builtin()`（`crates/host-core/src/plugins/registry.rs:101-106`）对读不出来的内置插件是 `continue` —— **静默跳过，不打日志**；紧接着 `drop_missing_builtin()` 判定「本构建不再下发它」，把这行从注册表删掉（`registry.json` 里 18 条，没有 `pi.bot`）。整条链没有任何一处报错。

**为什么自测没拦住**：`@pi-desktop/plugin-sdk` 的 `validateManifest()` 允许点号（`pibot.open` 这种命令 id 本来就是点号风格），TS 侧校验 `ok=true`。**TS 过了 ≠ 宿主能加载**，真正的守门人是 Rust。这是宿主两套校验不一致的地方，`commands[].id` 走宽松的 `filter_map`，`views` / `launcherTriggers` 却走严格的 `is_contrib_id`。

**修法**：`pibot.launcher` → `pibot-launcher`。

**验证（让 Rust 亲口说，不靠猜）**：临时加一个单元测试读真实目录跑 `PluginManager::read_manifest()`：

| 清单里的 id | 输出 |
|---|---|
| `pibot.launcher` | `PROBE_RESULT=FAIL error=PLUGIN_INVALID: launcher trigger id is missing or invalid` |
| `pibot-launcher` | `PROBE_RESULT=OK id=pi.bot version=0.7.31 perms=9` |

探针跑完即删，`git diff -- crates/host-core/src/plugins/tests.rs` 为空。

**以后加清单字段的硬规则**：

- 走 `is_contrib_id` 的（`views[].id`、`launcherTriggers[].id`、`mcpServers[].id`、`settings[].key` 等）：**只用字母开头 + 字母数字下划线连字符，不能有点号**；
- `commands[].id` 可以带点号（宽松提取，不校验格式）；
- 改完清单**必须**用真实 Rust 校验过一遍，只跑 `validateManifest()` 不算数。

**这个坑已堵死（2026-11-13，宿主侧两处改动）**：

| 改动 | 位置 | 作用 |
|---|---|---|
| 常驻回归测试 `every_bundled_plugin_manifest_passes_the_host_validator` | `crates/host-core/src/plugins/tests.rs` | 扫真实 `resources/plugins`，逐个过 `read_manifest()`；任何一个被拒就让 `cargo test -p host-core` 变红，并点名目录与原因 |
| 静默跳过改为留痕 | `crates/host-core/src/plugins/registry.rs:101` | `Err(_) => continue` → `Err(error) => { tracing::warn!(plugin_dir = ?path, %error, …); continue }`，插件仍被跳过（不阻塞宿主启动），但日志里留一句话 |

验证证据：

- **反向验证**：`launcherTriggers[0].id` 临时改回 `pibot.launcher` → 测试变红，输出 `pi.bot: PLUGIN_INVALID: launcher trigger id is missing or invalid`；恢复为 `pibot-launcher` → 变绿；
- **warn 实测**（临时探针，跑完已删）：用坏 JSON 目录跑 `sync_builtin`，stderr 打出 `WARN … bundled plugin manifest is unreadable; it is not registered plugin_dir="…broken.plugin" error=PLUGIN_INVALID: key must be a string at line 1 column 3`，同一时刻 `mgr.get("broken.plugin")` 为 `None` —— 确认插件仍被跳过，日志只是补上说明，行为没变；
- **全量回归**：基线 1307 passed / 0 failed / 5 ignored → 改动后 1308 passed / 0 failed / 5 ignored。

宿主 `tracing` 默认 `EnvFilter::new("info")`，`warn` 高于 `info`，**默认配置下就会输出到 stderr**，不需要额外设环境变量。

### 5.5 工具调用被当成正文显示（已修）

**现象**：对话里出现一整段 `{"tool":"bot_tool","args":{"name":"list_team","arguments":{...}}}`。

**根因**：`runTurn()` 的 `system` 参数默认值是 `TOOL_PROTOCOL`，而 `allowTools` 默认是 `mode === 'loop'`。两个默认值互相独立，于是 **`complete` 模式下照样把工具协议教给了模型，却完全不解析它的输出**——模型老老实实按协议吐出调用，桥把它当普通文本直接显示。

**修法**（`host/agent-bridge.mjs`）：

1. 新增 `CHAT_ONLY` 提示词，明确「不要输出 JSON、没有可用工具」；
2. `system` 默认值改为 `allowTools ? TOOL_PROTOCOL : CHAT_ONLY`，**协议和解析能力绑在一起**；
3. 兜底：`parseToolCall()` 改为无条件调用。若发现模型越界吐了工具调用而当前模式没有工具，**丢掉这段 JSON**，用一次纯文本收口重问；若收口还是 JSON，就如实回一句「当前是对话模式，切到 loop 才能查实时数据」，绝不把源码摆给用户看。

**验证**（`test-tool-leak.mjs`，7/7）：

| 场景 | 断言 |
|---|---|
| complete + 模型正常回答 | 正文原样返回，下发的 system **不含** `bot_tool` |
| complete + 模型越界吐工具 JSON | 输出**不含** `"tool"`，给出可理解说明，模型被叫 2 次（原始 + 收口） |
| loop + 模型吐工具 JSON | 仍正常解析执行并给出最终答复（工具能力没被修坏） |

---

## 6. 运行与验证

```bash
# 独立自测（不需要启动 Electron）
cd E:/PI-Desktop-dev/apps/desktop/resources/plugins/pi.bot
node host/standalone.mjs --mode native --selftest      # 14/14（L3）
node host/standalone.mjs --mode loop --selftest        # 13/13（L2）
node host/standalone.mjs --mode complete --selftest    # 11/11（L1）
node host/standalone.mjs --mode native                # 常驻，浏览器打开打印出的 /bot 地址

# 按需启动 / 空闲回收（假宿主驱动真实 main.cjs，不需要 Electron）
cd D:/workbuddy-work/2026-11-13-11-56-06
node test-ondemand.cjs                                  # 11/11

# 语法检查
node --check main.cjs
node --check host/agent-bridge.mjs
node --check host/native-bridge.mjs
node --check host/miniapp-context.mjs
node --check host/standalone.mjs

# 清单校验（在项目根）
cd E:/PI-Desktop-dev
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { validateManifest } from '@pi-desktop/plugin-sdk';
console.log(validateManifest(JSON.parse(readFileSync('apps/desktop/resources/plugins/pi.bot/manifest.json','utf8'))).ok);
"

# 在 PI-Desktop 里启用（native 需要重新授予 desktop.control）
PI_BOT_AGENT_MODE=native pnpm dev
# 首次/更新后到插件页确认新增权限 ui.view；然后在右侧工作面板「新建」里点 MiniMax Bot，
# 或按 Alt+Space 输 bot，或命令面板搜「MiniMax Bot: 打开独立窗口」
```

---

## 7. 验证证据

| 检查 | 结果 |
|---|---|
| 原包 103 文件全量复制 | ✅ 103 个文件 SHA-256 全量与源一致（含 engine/server/mcp/store/team/task-dispatcher/memory/client/tests/README/package.json） |
| 现有项目文件 | ✅ `git status` 里本次移植只新增 `?? apps/desktop/resources/plugins/pi.bot/`；项目原有的 20+ 个 `M` 文件是移植前就存在的用户改动，一个都没碰、也没新增任何 `M` |
| `validateManifest()` | ✅ `{ ok: true }`（首轮发现 `services.id` 不允许点号，已改为 `pibot_server`） |
| 插件入口契约（模拟宿主） | ✅ `onLoad` 注册命令/服务 → `service.start` 拉起服务 → `onPanelInvoke` 返回 origin/status → `/bot` HTTP 200 → `onUnload` 清空 |
| **L3 `native` 自测** | ✅ **14/14**：页面、state、21 MCP 工具、建 Bot/群、记忆、定时、私聊回合、**宿主 Agent 工具事件 parts=2**、**回复来自流式事件**、**带宿主工具执行结果**、群聊 @ 点名、用量 |
| L2 `loop` 回归 | ✅ **13/13**：页面、state、21 MCP 工具、建 Bot、建群、记忆、定时、私聊回合、**工具片段 parts=2**、**最终答复结合工具结果**、群聊 @ 点名、用量 |
| L1 `complete` 回归 | ✅ **11/11**（无工具片段断言，符合预期） |
| **排队能力（0.7.31）** | ✅ `node host/queue-selftest.mjs` **17/17**：同会话并发 → `run.queued(position=1)` 且串行、不同会话并行、排队中取消 → `REQUEST_CANCELLED` 且不执行、未声明 `whenBusy` 仍按旧行为、能力表只声明 `agent.run`；引擎全链路：带 sessionId 的第二轮成功（能力接线正确）、私聊/群聊同时触发均完成且无 BUSY |
| 清单校验（含新权限） | ✅ `validateManifest()` OK，`permissions` 含 `desktop.control` / `shell.openExternal` |
| 插件入口三模式 | ✅ 模拟宿主 `pi.*`：`onLoad` → `service.start` → `pibot.origin` / `pibot.status`（native 返回 `capabilities.supported=true` 与全套工具清单）→ 服务页面 200 → `onUnload` 清空 |
| 面板白名单自愈 | ✅ 模拟宿主验证 `pibot.ensurePolicy` → `pi.ui.openPanel()` 被调用 1 次（宿主据此重新应用 `netDomains`）；**改版后仅独立窗口调用，停靠视图直接跳过**（视图由宿主正确下发，多调会凭空多弹一个窗口） |
| **按需启动 / 回收** | ✅ **11/11**（`test-ondemand.cjs`）：加载后不启动 → 单发心跳不启动 → `origin` 才启动 → 有心跳跨过 6s 阈值不回收 → `release` 后 5s 内回收 → 回收后能再次拉起 → 二次关闭同样回收 → `openWindow` 走 `openPanel` |
| **头部空间**（改版实测） | ✅ 停靠视图同尺寸 520×700：旧版 `frameTop=47 / 高 654 / 占 93%` → 新版 `frameTop=0 / 高 700 / 占 100%` |
| 面板外壳（连不上） | ✅ 不再白屏：`fetch no-cors` 探不通 → 浮出「面板连不上本地服务」＋三条出路＋完整诊断（落位形态、服务地址、探测失败原因、`manifest.net`、`permissions`） |
| 面板外壳（无宿主桥） | ✅ 红点 +「无法连接 Bot 服务」+「详情 / 重试」按钮 + 具体原因「面板桥不可用」 |
| 出站自检 | ✅ 启动时写 `pi.bot.egress.diagnose`：`manifestNet` / `permissions` / `pi.net.fetch` 结论 |
| 真实浏览器视觉核验 | ✅ Playwright 打开 `/bot`：三栏布局、Chief 形象、欢迎语、输入框完整，无溢出/错位/空白；修掉 favicon 404 后控制台 **0 错误 0 警告** |
| favicon 守卫 | ✅ `/favicon.ico = 204`、`/bot = 200`，dispose 后恢复 `http.Server.prototype.emit` |

---

## 8. 未决项与限制（不粉饰）

1. **已在真实 PI-Desktop 实例中运行**（`plugin.log` 可证：`plugin.load.success` → `pibot_server running` → `pi.bot.started http://127.0.0.1:<port>`），面板白屏的根因也在那里被日志定位（见 §5.1）。仍未覆盖的是：`native` 模式在真实宿主里的整轮对话（本轮验证走的是模拟宿主 + 独立进程 + 浏览器），以及首次/更新后需要在「插件」页重新授予新增权限（`desktop.control`、`shell.openExternal`），缺失会报 `PLUGIN_PERMISSION_DENIED`。
2. **shell 能力已由 L3 native 补回**，走的是 `agent/prompt` 触发宿主完整 Agent 回合，不是 `agent.extension`。原计划那条高风险路径**没有启用**：它要 marketplace 禁止分发的授权、还要自铺 sidecar 消息桥，而 native 已达成同样目标且更安全。若你后续坚持要 sidecar 版，需要额外声明 `agent.extension` + `contributes.agentExtensions` 并写扩展模块。
3. **L3 会在 PI-Desktop 会话列表里为每个 Bot 建一个 durable session**（`session/create`）。这是「每 Bot 独立会话」的代价，也带来一个好处：宿主侧能直接看到并打开这些会话（类似原版 `agent.open`）。
4. **工具审批 / 问卷**：L3 把宿主的 `tool_permission_request` 翻译成原版 `permission.requested`（面板能显示），但 `asktool_request`（Ask 问卷）只观测不代答，`reply` 仍是 no-op——执行侧审批权归宿主，插件不替用户点「允许」。L1/L2 的 `answer` 把答案当新一轮输入续跑。
5. **限流**：L1/L2 受 `pi.agent.complete` 8 次/60 秒/插件限制（适配层压到 6 次、单回合 4 步）；**L3 不走这个接口**，改受宿主 Agent 会话与工具预算约束，单回合 120 秒超时。
6. **L3 依赖宿主版本**：需要 `desktop.control` 暴露 `session/create` / `agent/prompt` / `agent/getStatus` / `session/get`。`probe()` 缺任意一个就**自动降级到 L2** 并记日志，不会让服务起不来；`subscribeAgentEvents` 不可用时退回 `agent/getStatus` 轮询（失去逐字流式但功能完整）。
7. **原插件的 `/api/media` 仍用 Node `fs` 读 Bot 消息引用过的本地绝对路径**（MiniMax 原设计如此）。PI-Desktop 插件进程不是 OS 级沙箱（spec 04 明确 "Plugin entry code is not an OS sandbox"），这条路径不经过 `pi.fs.*` 审计通道。要收紧可在 `host/miniapp-context.mjs` 的宿主守卫里加 `/api/media` 的 URL 策略。
8. 原插件 `servers.mcp.json` 里端口 `9` 是 MiniMax 宿主的占位符；本移植不通过宿主 MCP 自动注册，21 个工具由插件自己的 `/mcp/minimax-bot` 提供。PI-Desktop 主 Agent 若要调用需另声明 `mcp.server.remote` 指向回环地址（未做，避免扩大授权面）。
9. **能力 100%「逐字节等价」仍不成立**：模型、配额、上下文压缩、工具审批 UI 都是 PI-Desktop 的实现，不是 MiniMax 云端那套。这是换宿主的固有差异，任何授权也变不掉。
10. **改成按需启动后，定时任务不再后台跑**（§5.3 的代价）：原版 30 秒 tick 只在窗口开着时推进，窗口全关时不会到点触发。要恢复常驻得把 `contributes.services` + `background.service` 加回来。这是拿「静默可用」换「不占资源」，选择权在你。
11. **停靠视图还没在真实 Electron 里跑过**：`contributes.views` 的注册、宿主的过滤条件（`ui.view` / 项目活跃 / `entry` 存在）、视图那条 IPC 正确下发 `netDomains`、iframe 子框架受同一套策略放行——这四条都在源码里逐行确认过，但真正的渲染结果要等你重启 PI-Desktop 点一次「新建 → MiniMax Bot」才算数。本轮视觉核验用的是 Chromium + 假宿主（形态标记、`--pi-plugin-titlebar-height`、`pluginBridge` 都按宿主源码的行为模拟）。
12. **插件进程本身无法做到零占用**：宿主对已启用的插件会在启动时 load（`docs/plugin-development.md`：`activationEvents` 只是描述性元数据，不是懒加载调度器）。所以那个 Node 进程一直在，只是空转——真要吃 CPU 和内存的 Bot 服务（HTTP + SSE + 定时器）才被这次改动挪到了按需。要做到连进程都不起，只能把插件在插件页禁用。

---

## 9. 回滚路径

**先解释为什么插件页没有「卸载」按钮**：`packages/shared/src/types/plugins.ts:330-335` 写得很明确——`bundled: true`（随应用 `resources/plugins` 下发）的插件**设计上不允许卸载**，只能禁用、更新、改作用域。`registry.json` 里 `pi.bot` 就是 `"source": "builtin", "bundled": true`，所以菜单里只有「开启自动更新」。

**无损卸载**：插件目录是纯新增，删掉即可；但宿主还会留下三样东西，要一起清才算干净——

| 残留 | 位置 | 说明 |
|---|---|---|
| 注册表条目 | `<数据根>\plugins\registry.json` 里的 `pi.bot` | 不清会留一条幽灵记录 |
| Bot 数据 | `<数据根>\plugins\data\pi.bot\` | `state.json` / `messages/` / `memory/`（聊天记录与团队记忆） |
| 浏览器分区 | `<数据根>\...\pi-plugin-pi.bot\` | 面板页的 localStorage / 缓存 |

脚本已经写好：**`D:\workbuddy-work\2026-11-13-11-56-06\uninstall-pi-bot.ps1`**

```powershell
# 1) 先预演，只列清单，不动任何东西
powershell -ExecutionPolicy Bypass -File .\uninstall-pi-bot.ps1

# 2) 确认后真卸载（目录一律进回收站，可还原；默认连数据一起清）
powershell -ExecutionPolicy Bypass -File .\uninstall-pi-bot.ps1 -Execute

# 3) 想保留 Bot 聊天记录和记忆，重装后接着用
powershell -ExecutionPolicy Bypass -File .\uninstall-pi-bot.ps1 -Execute -KeepBotData
```

脚本会自动找到**所有数据根**（你这台机器上有 `.pi-desktop`、`.pi-desktop-dev`、`PI-Desktop-Plugin-Test-Configured-…` 三套），改注册表前先把 `registry.json` 备份到 `%TEMP%\pi-bot-uninstall-<时间戳>\`，并逐条保留其他插件条目。执行前会检查 PI-Desktop 是否在运行（占用文件会导致删不掉）。

**手工版（不想跑脚本）**：

```bash
# 停掉应用后
rm -rf E:/PI-Desktop-dev/apps/desktop/resources/plugins/pi.bot
# 再从各数据根删：plugins/registry.json 里的 pi.bot 条目、plugins/data/pi.bot、Partitions/pi-plugin-pi.bot
```

没有修改任何现有文件、没有改 `pnpm-workspace.yaml`、没有动主程序代码，`git status` 里除了这个新增目录不会产生任何差异。原 MiniMax Code 的插件缓存与数据目录全程只读。

**只想撤掉 L3、保留原移植**：改 L3 前备份的 6 个文件在 `D:\workbuddy-work\2026-11-13-11-56-06\l3-backup\`（`manifest.json.bak` / `main.cjs.bak` / `PORTING.md.bak` / `host/*.bak`），把它们复制回 `pi.bot/` 对应位置，再删掉 `host/native-bridge.mjs` 即可；`manifest.json` 里会一并去掉 `desktop.control` 权限。源码级移植（103 文件 + L1/L2）完全不受影响。

---

## 附录 A · 关键源码位置

| 主题 | 文件 |
|---|---|
| 原插件源码 | `E:\UserData\minimax\v2\plugin-cache\official\sha256-tree-v1-d7cd61e5…\` |
| PI-Desktop 插件宿主 | `apps/desktop/electron/main/plugin-host-process.mjs`（模块加载、服务钩子） |
| 权限网关 | `apps/desktop/electron/main/plugin-runtime.ts` |
| 插件 API 规范 | `docs/spec/07-plugins/03-plugin-api.md` |
| 权限矩阵 | `docs/spec/07-plugins/13-plugin-permissions-matrix.md` |
| 可信扩展 | `docs/spec/07-plugins/16-trusted-extensions.md` |
| 面板出站策略 | `apps/desktop/electron/main/plugin-panel-host.ts:113` |
| 内置插件发现 | `apps/desktop/electron/main/host-process.ts:56` |
| 原版功能说明书 | 本插件目录 `README.md`（第 5–25 行功能清单、136–153 行运行与数据） |
| 逆向还原报告 | `D:\workbuddy-work\2026-11-13-11-56-06\MiniMax-Bot-逆向还原报告.md` |

## 附录 B · 术语白话

| 术语 | 大白话 |
|---|---|
| utilityProcess | Electron 开的独立后台 Node 进程，插件跑在里面，崩了不拖垮主界面 |
| `pi.*` 代理 | 宿主给插件的能力清单，插件说「我要读文件」，宿主查权限后再代做 |
| `agent.complete` | 宿主代跑的一次性模型问答，明确不带工具，走宿主自己的账号和配额 |
| tools: [] | 模型这次调用挂的工具列表是空的，等于「只能动嘴不能动手」 |
| Agent 循环 | 模型说「我要调 X 工具」→ 程序执行 → 把结果告诉模型 → 再问，直到给出最终答复 |
| `agent.extension` | 插件把代码塞进 Agent 进程里跑，等于拿到 Agent 全套权限，属于高风险授权（本移植**未启用**） |
| `desktop.control` | 宿主开放的一组「控制桌面」操作，安装时确认一次；L3 用它建会话、发提示、读状态 |
| `agent/prompt` | 把一句话发给某个会话的 Agent，触发一个**带全套工具**的真实回合；返回只代表「已受理」，不代表跑完 |
| durable session | 宿主持久化的会话，关掉面板也还在；L3 给每个 Bot 建一条，等于原版的独立 sessionId |
| `desktop:turnEnded` | 宿主发的「这一回合真的结束了」回执，比 `agent_end` / `turn_end` 可靠，L3 只认它收口 |
| `session/collaboration/spawn` | 让宿主新开一个独立 Agent 会话去干活，但只能在特定调用窗口里用 |
| scope（权限范围） | 声明「这个插件只能碰哪些路径」，宿主按它裁决每次读写 |
| `net.domains` | 出站白名单，面板 iframe 和插件网络请求都受它管 |
| iframe 同源 | 面板里嵌的小网页和服务在同一个地址下，原版页面的 `/api/*` 请求不用改一行 |
| SSE | 服务器主动推送，页面不刷新就能收到新消息 |
| MCP | 给 AI 挂外部工具的标准接口，本插件自带 21 个工具 |

## 与官方宿主的差距（2026-11-13 逐项核对）

**先把结论说死：miniapp 源码零差异。** 与官方缓存
`E:\UserData\minimax\v2\plugin-cache\official\sha256-tree-v1-d7cd...` 逐文件比对，
47 个文件（engine / mcp / team / server / client 全套）**MD5 全部一致**。
「和原版比差远了」的差距 100% 在我们的 `host/` 适配层，不在插件源码。

差距的根源是官方契约里的一句话（`miniapp/node/miniapp-api.ts` 的 `MiniAppAgentClient.run`）：

> Runs one turn with that Agent's full capabilities (files, shell, Skills,
> **MCP including this Mini App's own**), and resolves when the turn ends.

| 能力 | 官方宿主 | PI-Desktop 宿主 | 我们的适配层现状 |
|---|---|---|---|
| 工具调用形态 | 原生函数调用（结构化 tool_calls） | 只有一次性补全 `pi.agent.complete` | loop：让模型口述 JSON 再自己解析 |
| 步数 | 不设上限 | native 也不限 | loop 原为 **4** → 已放到 **12** |
| 并行工具调用 | 原生支持 | 无 | loop 已支持 `{"tool_calls":[...]}` 打包执行 |
| 插件自带 MCP | 契约要求注入（`mcpEndpoints`） | **全仓库无消费方**，不注入 | loop 用 `bot_tool` 走 HTTP 直连兜底 |
| 限流 | 无 | `agent.complete` 8 次/60 秒 | 原自压 6 → 已对齐 **8**，等待上限 180 秒 |
| 结构化提问（questionnaire） | 有 | native 有 / complete 无 | 未实现（`pendingQuestion` 走不到） |
| 人格 instructions | 由宿主拼 | native 不拼（只发用户文本） | loop 从 `buildStandingBrief` 拼进提示 |

**因此 native 档不能当默认**：宿主拿不到插件 MCP，`create_bot` / `create_group` /
`remember` / `dispatch_tasks` 全部失效，人格也传不过去。要「建群」这类核心能力，
只能走 loop。

**缺口里最难追平的一条**：原生函数调用是模型级能力，我们用「JSON 文本 + 自己解析」
模拟，遇到弱模型（如 `catpaw-tools/longcat-2.5`）成功率明显低于原版。想接近原版，
换强模型比改代码更有效。
