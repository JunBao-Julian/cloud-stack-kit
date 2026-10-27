# 重启后启动与恢复

以下适用于通过本仓库 `Windows` 和 `Activate` 阶段配置的电脑。

## 平时重启

1. 登录原来的 Windows 用户，接通网络，等待约 30–60 秒。
2. Clash 与 SSH/辅助代理守护程序由启动文件夹自动启动。须保留 `local.autoStart: true`，且没有在任务管理器中禁用对应启动项。
3. 在仓库目录运行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup.ps1 -Phase Check`。
4. 打开 `%LOCALAPPDATA%\CloudStack\<instanceId>` 下的 `Browser.lnk`、`Panel.lnk` 或 `Claude.lnk`。

不需要重新执行 `Server`、`Windows` 或 `Activate`，不需要重新输入服务器密码。SSH 隧道使用本机受限密钥，掉线后自动重试。用户尚未登录时，本地守护程序不会启动。

## 启动不全或断网后恢复

双击实例目录的 `Recover.lnk`。它补启动 SSH 和辅助代理；如果 Clash 未运行，也会启动 Clash。不会停止已经运行的代理。

然后重新运行 `Check`。若仍失败，查看实例目录的 `Tunnel.error.log`、`Tunnel.stderr.log`、`AuxProxy.error.log`，对照 [排错说明](troubleshooting.md)。日志可能含地址和凭据片段，不要完整公开上传。

`Recover` 不修复被手动关闭的 TUN、被删除的服务或已损坏的配置。先恢复 Clash 的 TUN/系统代理开关；确需重新激活时再运行管理员 `Activate`，并接受短暂重连。

## 四种连接分别负责什么

| 连接 | 用途 | 默认本机端口 |
| --- | --- | --- |
| Clash 主代理 | 系统代理、浏览器 UDP、TUN 分流 | 7897 |
| 独立辅助代理 | 专用浏览器和恢复链路 | 17897 |
| SSH → Sub2API | 本机 API 调用与网关面板 | 18080 |
| SSH → S-UI | 代理管理与订阅 | 12095 / 12096 |

端口以自己的配置为准。SSH 连接断开时，API/面板可能不可用，但 Shadowsocks 代理不一定断开；反过来也一样。

## 回退与停用

回退最近一次激活（同一用户管理员 PowerShell）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup.ps1 -Phase Rollback
```

暂停此实例的 SSH/辅助代理并移除工具创建的启动链接：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup.ps1 -Phase Suspend
```

`Suspend` 保留 Clash，API 隧道会断开。它不是卸载器。之后执行 `Windows` 重新准备自启动，或用 `Recover.lnk` 临时启动守护程序。
