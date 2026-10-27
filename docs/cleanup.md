# 部署前清理 Claude 本地旧数据

如果这台电脑曾登录已停用或被封禁的旧账号，并且你已决定删除它的本地登录与会话数据，建议在部署前、登录其他账号或配置新 API 之前运行清理工具。已有正常配置且不需要清理的用户可以跳过。

清理是本地数据维护，不会解除封禁或删除平台服务端记录，也不能保证新旧账号无法关联。它无法识别账号是否被封禁，**已识别位置中的当前账号登录、保存的密码和本地会话同样会被删除**。

## 一键入口

1. 安装 Node.js LTS（清理工具要求 **22.13+**），下载并解压本项目。
2. 双击根目录 **`Cleanup-Claude.cmd`**；首次会按锁文件安装依赖，不执行依赖安装脚本。网络无法访问 npm 时先配置可用网络。
3. 查看列出的具体文件与操作。保存工作并关闭浏览器、Claude、VS Code/Cursor/Windsurf 等编辑器，包括后台进程。
4. 确认愿意失去本地记录后输入 **`CLEAN`**。其他输入取消；应用未退出时停止清理，不强制结束进程。
5. 查看结果。出现失败或未识别路径时，不应视为“已全部清除”；修复占用/权限问题后再运行。

只预览，不关闭应用或修改应用数据：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\Clean-Claude.ps1 -Preview
```

清理不需要管理员权限。请使用需要清理的 Windows 用户运行，不要切换为另一个管理员账号。它不自动随 `Setup.ps1` 部署执行，避免误删后来建立的新登录。

## 自动处理范围

| 位置 | 操作 |
| --- | --- |
| 默认 Claude Code | 清理用户目录 `.claude.json` 及备份、`.claude` 下已知凭据、对话历史、会话、日志、缓存；移除全局 settings.json 的认证字段 |
| Chrome、Edge、Brave、Vivaldi、Opera/GX 的标准配置目录 | 按 Claude/Anthropic 域名删除 Cookie、保存的站点密码、相关历史、Local/Session Storage、IndexedDB 和站点偏好 |
| Chromium 共享缓存 | 清空页面/代码/GPU 缓存与 Service Worker 离线数据；**其他网站可能需要重新下载页面、恢复离线功能或重新注册通知**，但不批量删除它们的 Cookie、密码或书签 |
| 名称可识别的 Claude/Anthropic 浏览器扩展 | 清理该扩展专属的本地/同步存储目录；保留扩展安装文件 |
| Firefox 标准 Profiles | 清理 Claude Cookie、已保存登录、非书签历史和目标站点 storage 目录；保留书签 |
| Claude 桌面端 | 清理已知标准、第三方和 Store 外部配置布局中的登录存储、会话、日志、缓存；保留 MCP 配置、Cowork 工作目录设置和实际工作文件 |
| VS Code、Insiders、VSCodium、Cursor、Windsurf | 清理 Claude Code 专属全局/工作区状态、对应数据库备份、扩展存储与日志；保留其他扩展状态及安装文件 |
| Windows 当前用户环境变量 | 删除已列明的 Claude/Anthropic 认证变量和旧 API 地址；仅显示变量名，不显示值 |

域名匹配限制在 `claude.ai`、`claude.com`、`anthropic.com`、`claudeusercontent.com`、`claudemcpcontent.com` 及子域，避免误处理相似名称的网站。

脚本拒绝链接、目录联接和硬链接目标；路径被占用、数据库版本不兼容或权限不足时会报告失败。预览只列出将检查/处理的存储位置，不读取或打印 Cookie、令牌或会话正文。实际数据库删除是按站点筛选，不是删除整份浏览器数据库。

## 保留和需要人工核对的范围

- 代码项目、项目级 `.claude` 配置、MCP 自定义服务、插件脚本、Clash、SSH 密钥、Sub2API，以及 `%LOCALAPPDATA%\CloudStack` 内新部署实例不作为删除目标。
- 自定义 `CLAUDE_CONFIG_DIR`、自定义 `--user-data-dir`、便携浏览器、Arc、WSL、其他 Windows 用户、JetBrains、无法识别的第三方插件需人工检查。当前环境中的自定义 Claude 目录只提示，不直接删除。
- Windows 凭据管理器、机器级环境变量、系统密钥库、终端命令历史、编辑器通用历史、浏览器标签恢复文件、书签和下载的文件不被批量清空。不要把这些位置仍存在的线索误认为脚本已处理。
- Google/Microsoft/Apple 等共享 SSO、密码管理器、浏览器云同步、扩展同步、外部备份和系统还原点保留。同步可能再次恢复数据，需要本人在对应服务中处理。
- 部分 Store Claude 的未知 LocalState 或 Cowork 虚拟机布局会提示人工核对；`local-agent-mode-sessions` 保留，避免删除虚拟机或工作文件。不通过重置整个应用包来清空未知目录。
- 当前 Chromium 配置中的共享 Service Worker 缓存会删除，但未知的新存储格式仍可能不在覆盖范围。Firefox 旧版存储格式、分区容器和扩展内部加密账号状态需要额外核验。

工具不会备份旧凭据，也不提供恢复已删除对话的入口；需要保留的对话请事先自行导出。SQLite/LevelDB 压缩不是磁盘空闲空间的取证级擦除。

优先使用应用提供的退出登录功能；此工具清理本地残留，不会自动登录账号或代为撤销服务端会话。官方说明：[Claude Code 认证](https://code.claude.com/docs/en/authentication)、[配置位置与优先级](https://code.claude.com/docs/en/settings)。
