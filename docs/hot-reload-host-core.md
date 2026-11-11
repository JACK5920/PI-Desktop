# 热替换 host-core（不重启 Electron）

改完 `crates/host-core/` 里的 Rust 代码后，要让运行中的 dev 桌面用上新代码。
**不要重启整个程序**——那会杀掉当前会话。

```powershell
pwsh -File scripts/swap-host-core-detached.ps1
```

等几秒，宿主自己就换好了。想看日志：`Get-Content .artifacts\host-core-swap.log`。

> **如果你正坐在一个 agent 会话里：这一步会切断当前 turn。**
> 原因见下面的进程树——agent 的 shell 是 host-core 的后代，host-core 一停，
> 这个 shell 就没了，命令执行到一半会断。
>
> 两个选择：
> - **在你自己开的 PowerShell 窗口里跑**上面的命令（推荐），
>   然后回来发一句话让 agent 接上；
> - 或者让 agent 改完代码后停下，由你手动跑一次 swap，再发一句话接续。
>
> `swap-host-core-detached.ps1` 里的 "detached" 指的是**换文件的动作**跑在
> 你的会话之外（所以文件能换完），**不是**让你的会话活下来。

---

## 为什么不能直接 `cargo build`

两件事同时挡着。

**一、运行中的二进制占着文件。** `cargo build` 要把新产物写回
`target\debug\pi-desktop-host-core.exe`，而运行中的 host-core 正映射着这个文件。
Windows 不允许替换被打开的可执行文件，于是构建在最后一步失败：

```
error: failed to remove file `...\target\debug\pi-desktop-host-core.exe`
Caused by: Access is denied. (os error 5)
```

**二、构建期和运行期抢同一个目录。** `cargo` 会重建整个 `target`，
包括 host-core 自己依赖的东西。

所以构建走**另一个 target 目录**（默认 `target2`），构建完再把产物搬过去。

---

## 为什么不直接 `Stop-Process`

**进程树是这样的：**

```
electron (Main)
└── pi-desktop-host-core.exe          ← 桌面侧的主 host
    └── pi-desktop-host-core.exe --internal-tool-runner
        └── powershell                ← agent 的 Bash 工具跑在这里
            └── 你的命令
```

agent 的 shell 是 host-core 的**后代**。在那个 shell 里杀 host-core，
shell 自己先死——命令执行到一半就没了，文件换不成。

**Electron Main 和 sidecar 是 Electron 的子进程，不是 host-core 的。**
所以只重启 host-core，桌面窗口本身不会崩；dev 的 RuntimeSupervisor
会在半秒内把 host-core 拉起来（退避 0.5s → 1s → 2s，2 分钟窗口内最多 3 次）。

**结论：只有 host-core 能安全地重启，代价是当前 turn 会断。**
（实测：停掉 host-core 之后，监督器拉起新实例并接管了后续请求，
所以"改完代码 → 手动 swap → 用户发一句话接续"是可行的流程。）

---

## `Invoke-CimMethod Win32_Process::Create` 为什么行

`Start-Process` 不行——子进程留在同一个 job object 里，跟着一起死。

`Invoke-CimMethod -ClassName Win32_Process -MethodName Create` 是**向 Windows
进程子系统要一个新进程**，不是 fork。新进程落在 agent 的 job object 之外，
所以它停掉 host-core 之后自己还活着，能把文件换完再退出。

实测：换完之后 agent 的 turn 照常继续。

---

## 三个必须遵守的点

**1. 构建和替换要分两个目录**

```
cargo build -p host-core --target-dir target2      # 构建到别处
Move-Item target2\debug\... target\debug\...       # 再搬过去
```

**2. 替换动作必须脱离会话**

用 `scripts/swap-host-core-detached.ps1`，它内部用
`Invoke-CimMethod Win32_Process::Create` 启动自己。
手工做的话：

```powershell
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = 'powershell -NoProfile -ExecutionPolicy Bypass -File "E:\PI-Desktop-dev\scripts\swap-host-core.ps1"'
}
```

**3. 先删后移，不能直接覆盖**

运行中的进程仍然映射着旧文件，名字要先让出来：

```powershell
Stop-Process -Id <host-core pid> -Force
Remove-Item target\debug\pi-desktop-host-core.exe -Force
Move-Item target\debug\pi-desktop-host-core.next.exe target\debug\pi-desktop-host-core.exe -Force
```

只 stop 不删，下一次 move 会失败；只删不 stop，删除会失败。

---

## 排错

| 现象 | 原因 |
|---|---|
| `failed to remove file ... Access is denied` | 构建写回了 `target\debug`，改用 `--target-dir target2` |
| 命令执行到一半 shell 消失 | 在 agent 的 shell 里直接 stop 了 host-core，改用 detached |
| `THE BINARY IS GONE` | 删除成功但 move 失败，检查是否有别的进程占着文件 |
| host-core 没回来 | 监督器退避用尽了，看 `logs/host/runtime.log` |
| 换完还是旧行为 | 看 `.artifacts\host-core-swap.log` 的 binary timestamp |

---

## 不用这个脚本的情况

**改了 `packages/*/src`**（TypeScript）——那是 Electron 侧，dev watcher 会自动重建并重启
Electron，不需要手动换。注意重启 Electron 会切断当前 turn，所以**批量改完再让用户接话**。

**只改了插件代码**——插件在 dev 环境的私有目录里，改完在插件中心重载即可。

**要改宿主的 Rust 但想同时看日志**——用前台版本：

```powershell
pwsh -File scripts/swap-host-core.ps1
```

它会打印每一步，但 host-core 被停掉时你的 shell 一样会死——所以只能在
**不承载 agent 会话**的终端里跑（比如你自己开的 PowerShell 窗口）。
