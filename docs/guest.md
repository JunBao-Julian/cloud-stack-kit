# 朋友接入现有服务器（Windows / macOS）

支持本工具包部署的原生 S-UI 1.6.5 / Sub2API 0.2.18，以及兼容的旧版原生目录布局。**不重新安装服务、重建数据库或改公共订阅模板。** Docker、自定义路径和其他版本请先人工确认兼容性。

管理员先创建朋友的受限登录凭据，朋友再运行一键入口。原部署已关闭 SSH 密码登录，云面板显示的旧 root 密码无法用于登录；不要把管理员私钥交给朋友。

## 管理员：生成凭据

Windows 双击 **`Create-Guest.cmd`**；Mac 双击 **`Create-Guest.command`**。输入服务器公网 IPv4、SSH 端口、管理员 root SSH 私钥路径、朋友 ID（例如 `friend01`）。首次连接由 OpenSSH 提示核对主机指纹；私钥口令也由 OpenSSH 输入，脚本不记录。

脚本会增加独立 SS2022 客户端、新建 `Guest-friend01` 分组和 API Key，不复制已有上游，不设置其他分组为回退。新增 `csg-friend01` SSH 用户只能读取自己的配置、转发 API 端口；禁止 shell、管理面板、远程转发、Unix socket、代理转发和 PTY。SSH 主机密钥绑定到邀请文件，朋友连接时严格核对。

| 管理员电脑 | 凭据目录 |
| --- | --- |
| Windows | `%LOCALAPPDATA%\CloudStack\Invitations\friend01` |
| Mac | `~/Library/Application Support/CloudStack/Invitations/friend01` |

通过私密渠道只发送 **`invitation.json` 和 `guest_key`** 两个文件，放在同一文件夹。不要发送管理私钥、整个 CloudStack 目录，也不要上传凭据到 GitHub。每位朋友、每台需独立撤销的电脑使用不同 ID。同一 ID 会复用凭据，已撤销 ID 不可复用。

## 朋友：一键接入

1. 下载完整工具包并解压，保留目录结构。
2. Windows 双击 **`Join-Windows.cmd`**；macOS 双击 **`Join-Mac.command`**。
3. 输入 `invitation.json` 完整路径；同目录必须有 `guest_key`。
4. 批准 Clash 安装及 TUN 服务权限，切换时可能短暂重连。

无需管理员密码或私钥。Node.js 不足 22.13 时下载固定 22.22.0 用户级运行时；Clash 安装包固定 2.4.7 并校验 SHA256；Claude Code 使用官方 stable 安装入口。初始网络须能访问 Node.js、GitHub、npm 和 Claude 官方下载，初次下载前不会关闭已有代理。

Windows 要求 Windows 10/11、OpenSSH Client，以及当前用户可批准管理员权限。Mac 要求 **macOS 13+**，支持 Intel / Apple Silicon。如果首次运行被系统拦截，请按“隐私与安全性”提示允许后重试；脚本不关闭 Gatekeeper。`.command` 未保留执行权限时，在终端进入解压目录执行：

```bash
bash Join-Mac.command
```

脚本先在独立端口验证代理出口和 SSH API 健康，再切换主 Clash。失败会尝试恢复之前的配置，并保留辅助通道。不要同时运行两套 VPN/TUN；企业管理策略可能阻止安装。

## 朋友自己的上游

接通 API 网关不代表已有模型可用。管理员在 Sub2API 面板为朋友发起账号接入，**朋友本人完成授权**，然后仅关联到 `Guest-friend01` 分组。不要把你的上游加入该分组，也不要设置其他分组回退。

客户端不包含面板管理密码。API Key 由管理员账户持有，按独立 Key/分组统计；它不是独立的 Sub2API 面板账号。面板若启用余额、并发或费用限制，管理员需配置相应额度。管理员能够管理上游凭据与请求日志，这不构成对管理员的账号隔离。

脚本不代替本人授权，不自动登录 Claude，也不能保证账号不会被封禁。请遵守上游地区、订阅和使用规则。

## 配置范围

- 普通浏览器公网 TCP/UDP 走服务器；其他应用国内目标直连，其余代理，局域网保留直连。
- STUN 常见端口优先代理，TUN 接管 IPv4/IPv6；Mac 加入 Safari/WebKit、Chrome、Edge、Firefox、Brave、Arc 等进程规则。
- Mac 使用 TUN，不覆盖系统代理认证信息；为避免局域网 DNS 绕过，会将已启用网络服务的 DNS 改为 `1.1.1.1` / `8.8.8.8`，先保存原值，回退入口可恢复。企业 DNS 管理设备不适合此默认设置。
- Claude 启动器设置本机 API URL、专用 API Key 和独立 `CLAUDE_CONFIG_DIR`。普通终端 `claude`、桌面 Claude 和 IDE 插件不被全局替换。
- 不自动清理账号，不修改时区/语言，不关闭 Windows 更新。现有 Windows 清理入口仍独立运行，不适用于 Mac。

## 重启、回退、撤销

重启并登录后，Windows 启动项 / Mac 用户 LaunchAgents 自动启动 Clash、辅助代理和 SSH 重连。网络恢复后重试；睡眠期间不保证连接，唤醒后恢复，未登录时不启动用户隧道。

桌面生成 `CloudStack-Claude`、`CloudStack-Recover`、`CloudStack-Rollback`，分别用于启动 Claude、恢复连接、恢复上次切换前的 Clash 设置。回退可能需要管理员权限，Mac 同时恢复 DNS 并移除本工具 Clash 自启动任务；SSH/辅助代理保留。回退不是卸载，不删除服务器账号。

取消访问：管理员在原生成邀请的电脑运行 **`Revoke-Guest.cmd` / `Revoke-Guest.command`**，输入同一服务器及 ID。它撤销 SSH、断开该受限用户会话、删除朋友的 SS 客户端和 API Key。上游及分组保留，由管理员处理。原电脑丢失时，可在面板删除 `Guest-<ID>` 的客户端与 Key，并清空 `/var/lib/cloud-stack-access/<ID>/authorized_keys`、断开该用户 SSH 会话。

自动测试覆盖凭据边界、主机密钥绑定、规则顺序和启动文件；macOS 真机 GUI 权限、TUN 和重启恢复仍需验收。首次安装后在常用浏览器检查 [ip.net.coffee](https://ip.net.coffee/)，不要把脚本成功等同于所有应用均无泄漏。
