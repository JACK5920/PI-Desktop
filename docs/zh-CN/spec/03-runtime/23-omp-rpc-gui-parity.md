# OMP RPC 图形界面对齐

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/23-omp-rpc-gui-parity) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。

> 范围：PI-Desktop 对 OMP `rpc-ui` 的集成。本规格记录已测试的 RPC 合同及其 GUI 等价呈现；不宣称与 OMP 终端 TUI 在像素或操作流程上完全相同。

## 版本与事实来源

- 当前对齐基线为 OMP **19.2.0**，由 `omp-rpc-native-integration.test.mjs` 使用的隔离可执行文件核实。
- 运行时在 OMP 提供时协商公开 RPC v2。桌面端测试中固定的命令和出站事件清单是可执行的兼容性门槛；只有核对发布源码并用隔离原生二进制验证后，才能更新清单。
- 兼容性测试不会启用或替换用户受管的引擎。本次核验中的开发版 profile 活动引擎，与隔离使用的 19.2.0 测试二进制相互独立。
- 验收不使用真实账号、凭据、服务商请求、模型生成或用户会话。

## 19.2.0 新增能力的 GUI 等价呈现

| 原生能力 | 桌面呈现 | 合同与回归覆盖 |
| --- | --- | --- |
| `get_model_picker` | 主输入框模型选择器；`@role` 查询交由 OMP 原生角色排序，并显示角色和该角色的思考强度。选择时发送原生 provider/model、role 与 thinking-level 字段。 | `omp-thinking-level-refresh.test.mjs`；基于隔离 profile 的快捷角色 RPC 冒烟。 |
| `abort_and_deliver_queue` | OMP 会话控制；仅在任务运行且有 steering/follow-up 排队文本时显示。中止和交付结果以 OMP 返回为准。 | `omp-session-controls.test.mjs`；隔离空队列响应验证。 |
| `resume` | OMP 会话控制；仅对非运行且已有原生消息的会话显示。请求发给 OMP，空会话或不可恢复会话的错误仍由引擎返回。 | `omp-session-controls.test.mjs`；隔离空会话拒绝验证。 |
| Retry fallback 事件 | 主对话状态显示原模型、回退模型及引擎提供的原因，分别呈现 `retry_fallback_applied` 与 `retry_fallback_succeeded`。 | `omp-rpc-frame-parity.test.mjs`；`omp-rpc-native-integration.test.mjs`。 |
| Agent Loop 错误元数据 | Transcript 将 OMP `errorFromAgentLoop` 标为不可重试的 Agent Loop 错误，与服务商传输/请求错误区分。 | `omp-rpc-native-integration.test.mjs`。 |
| 子代理等待/重试/模型元数据 | 主对话卡片和详情面板区分等待、重试间隔/失败、实际解析模型以及是否使用回退模型；仅在 OMP 提供相应进度字段时呈现。 | `omp-subagent-progress.test.mjs`、`omp-subagent-turn-group.test.mjs`、`omp-subagent-roster.test.mjs`。 |
| 配置/顾问状态事件 | 会话状态区域提示配置警告已变化，并显示 advisor 成本/让出控制权通知；当前 RPC 事件不含警告内容，因此不会宣称能逐条显示警告详情。这些投影不会持久化原始服务商或工作区数据。 | `omp-rpc-native-integration.test.mjs`；`omp-extension-state.test.mjs`。 |

`omp-rpc-command-parity.test.mjs` 清单包含经 19.2.0 核实的 77 条公开命令，并检查每条命令都被显式 IPC allowlist 及更窄的提供商管理 allowlist 处理。清单并不授权向 renderer 暴露任意 RPC 或文件访问。没有独立可见控件的命令，只能由既有专用界面、内部运行时流程处理，或明确返回不支持；不得静默回退到 PI Agent Runtime 或 PI Host 工具。

## 不变量

- OMP 负责自己的模型目录、会话历史、扩展执行、工具、认证和权限语义。PI 展示交互并镜像可见事件，不得把 OMP 请求转给另一套引擎执行。
- 成功的 `set_model` 不因后续能力/状态刷新失败而被报告为模型切换失败；旧模型的思考选项会被清空，并显示刷新失败提示。
- 会话排队操作和恢复是明确的用户操作。GUI 不得把“命令已发出”当作成功；必须以 OMP 响应为准，并保留原生会话及队列语义。
- OMP Agent Loop 错误不得误标为服务商错误。回退与子代理状态是 OMP 事件/进度的投影；缺失字段不得凭空补造。
- 显示事件状态和模型字符串前均需限制长度。切换会话或 RPC 子进程退出时，应清理临时状态。

## 仅限 TUI、不宣称 GUI 对齐的能力

桌面端不嵌入终端，也不模拟任意终端输出。原始 TUI 按键、依赖终端尺寸的布局、仅限终端的 widget，以及没有公开 RPC 表达方式的交互流程均不在本对齐合同内。它们必须明确列为限制，不能因为转发了一个同名命令就宣称已经实现。如果后续 OMP 版本新增公开 RPC 方法，应更新命令/事件清单、分类其语义、实现合适的 GUI 或可见的不支持状态，并先用隔离二进制验证后再宣称支持。

## 验收要求

对每次 OMP 升级：

1. 对照上游 RPC 类型、命令和事件合同与固定测试清单，记录新增、移除和语义变化。
2. 运行命令、事件、事件适配器、会话控制、模型选择器、扩展、子代理和 transcript 回归测试。
3. 有相同版本的可执行文件时，使用临时 profile 和数据目录验证协议协商、状态/模型读取、新增或变化的 RPC 命令、扩展事件与错误形态。不得使用活动受管 profile 或发起真实模型请求。
4. 运行 i18n 校验、桌面类型检查、桌面构建和 `git diff --check`；分别记录测试二进制的版本与哈希、受管活动引擎的版本。
