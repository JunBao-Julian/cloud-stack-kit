# 可选 Windows 设置

这些工具不由 `Setup.ps1` 自动执行。它们与 VPS 部署和正常代理运行无关，请按本人需求选择。

## 首选语言

将美式英语置于首选列表，同时保留其他语言及输入法：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\Preferred-Language.ps1 -Mode Apply -Language en-US
```

检查或恢复首次运行前的语言列表与格式：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\Preferred-Language.ps1 -Mode Status
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\Preferred-Language.ps1 -Mode Restore
```

不会修改 Windows 显示语言、非 Unicode 程序区域，也不安装语言包或注销用户。家庭单语言版的显示语言受许可证限制。首选语言不等于系统界面语言。

## Windows 自动更新

默认保留 Windows 更新。若主动停用，**Windows 系统安全更新也会被阻止**，需要先恢复再手动更新。关闭更新不能防止账号封禁。

仅检查：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\Windows-AutoUpdate.ps1 -Mode Status
```

明确选择停用（Windows 会弹 UAC，附加参数用于确认理解安全更新也会停止）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\Windows-AutoUpdate.ps1 -Mode Disable -AcknowledgeSecurityUpdatesDisabled
```

恢复首次操作前的自动更新策略及 Windows Update 服务启动类型：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\Windows-AutoUpdate.ps1 -Mode Restore
```

只修改 `NoAutoUpdate` 策略与 `wuauserv` 服务，不删除任务、不改服务权限、不操作 Defender，也不会强制重启。系统后续维护可能重设服务；此工具不承诺永久锁定。

备份分别位于 `%LOCALAPPDATA%\CloudStack\preferences` 与 `%LOCALAPPDATA%\CloudStack\windows-update`。保留这些目录才能恢复原值。不要把旧电脑的备份用于新电脑。
