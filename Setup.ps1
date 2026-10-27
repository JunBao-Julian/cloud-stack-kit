# Windows PowerShell 5.1 / PowerShell 7. Run from an interactive terminal.
[CmdletBinding()]
param(
    [ValidateSet('Init','Validate','Server','Attach','AttachLegacy','Windows','Activate','Gateway','Check','Rollback','Suspend','All')][string]$Phase='Validate',
    [string]$Config=(Join-Path $PSScriptRoot 'config.json'),
    [string]$ExistingAdminKey,
    [switch]$InstallDependencies
)
. (Join-Path $PSScriptRoot 'windows\Common.ps1')
Set-StrictMode -Version 2
if($Phase -eq 'Init') {
    if(Test-Path $Config){throw 'Configuration exists; edit it without replacing it'}
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'config.example.json') -Destination $Config
    Write-Host "Edit $Config : instanceId, server.address and region. No secrets belong in this file."
    exit 0
}
if(!(Test-Path $Config)){throw 'Run .\Setup.ps1 -Phase Init first'}
$Config=(Resolve-Path -LiteralPath $Config).Path
$c=Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json
if($InstallDependencies) {
    if(!(Get-Command node.exe -ErrorAction SilentlyContinue)) {
        & winget.exe install --id OpenJS.NodeJS.LTS --exact --source winget --accept-source-agreements --accept-package-agreements
        if($LASTEXITCODE -ne 0){throw 'Node.js installation failed'}
        $env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')
    }
    if($Phase -notin @('Validate','Server','Attach','AttachLegacy','Gateway')) {
        & winget.exe install --id ClashVergeRev.ClashVergeRev --version 2.4.7 --exact --source winget --accept-source-agreements --accept-package-agreements
        if($LASTEXITCODE -ne 0){Write-Warning 'If Clash is already installed, confirm its version and set local.clashExe. Otherwise install it before Windows/Activate.'}
    }
}
if(!(Get-Command node.exe -ErrorAction SilentlyContinue)){throw 'Install Node.js 20+ or rerun with -InstallDependencies'}
if([version]((& node.exe -p 'process.versions.node')) -lt [version]'20.0.0'){throw 'Node.js 20+ is required'}
$validationArgs=@((Join-Path $PSScriptRoot 'lib\config.cjs'),$Config)
if($Phase -ne 'Validate'){$validationArgs+='--deploy'}
& node.exe @validationArgs
if($LASTEXITCODE -ne 0){throw 'Configuration validation failed before dependency download or deployment'}
if(!(Test-Path (Join-Path $PSScriptRoot 'node_modules\yaml\package.json'))) {
    Push-Location $PSScriptRoot
    try {
        $npmArgs=@('ci','--ignore-scripts','--no-audit','--no-fund')
        if($c.bootstrapProxy){$npmArgs+="--proxy=$($c.bootstrapProxy)"}
        & npm.cmd @npmArgs
        if($LASTEXITCODE -ne 0){throw 'npm ci failed; set bootstrapProxy to an existing working proxy if required'}
    } finally {Pop-Location}
}
$client=Join-Path $PSScriptRoot 'lib\client.cjs'
function Invoke-Client([string]$Mode,[string]$Extra='') {
    & node.exe $client $Mode $Config $script:state $Extra
    if($LASTEXITCODE -ne 0){throw "Client step failed: $Mode"}
}
$script:state=Join-Path $env:LOCALAPPDATA ('CloudStack\'+$c.instanceId)
Invoke-Client validate
if($Phase -eq 'Validate'){Write-Host 'Template syntax is valid. Deployment additionally requires a real public server IP.';exit 0}
# Validate again before creating private deployment state.
Invoke-Client validate-deploy
Protect-Directory $state
$adminKey=Join-Path $state 'admin_key';$known=Join-Path $state 'known_hosts'
$sshConfig=Join-Path $state 'ssh_config'
$hostFile=$known.Replace('\','/')
[IO.File]::WriteAllText($sshConfig,"Host *`n    UserKnownHostsFile `"$hostFile`"`n    IdentitiesOnly yes`n",[Text.UTF8Encoding]::new($false))
$upload="/root/cloud-stack-upload/$($c.instanceId)"
function Invoke-SSH([string]$Command,[switch]$Initial) {
    $sshArgs=@('-F',$sshConfig,'-p',"$($c.server.sshPort)",'-o','ConnectTimeout=20','-o','ServerAliveInterval=20','-o','ServerAliveCountMax=3')
    if($Initial) {
        $sshArgs+=@('-o','StrictHostKeyChecking=ask')
        if($ExistingAdminKey){$sshArgs+=@('-i',(Resolve-Path -LiteralPath $ExistingAdminKey).Path,'-o','IdentitiesOnly=yes')}
        else {$sshArgs+=@('-i',$adminKey)}
    } else {$sshArgs+=@('-i',$adminKey,'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes')}
    $old=$ErrorActionPreference;$ErrorActionPreference='Continue'
    try {& ssh.exe @sshArgs "root@$($c.server.address)" $Command;$script:sshExit=$LASTEXITCODE} finally {$ErrorActionPreference=$old}
    if($script:sshExit -ne 0 -and $script:sshExit -ne 3){throw "SSH step failed (exit $script:sshExit)"}
}
function Copy-Remote([string]$Source,[string]$Destination) {
    & scp.exe -q -F $sshConfig -P $c.server.sshPort -i $adminKey -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes $Source $Destination
    if($LASTEXITCODE -ne 0){throw 'SCP transfer failed'}
}
function Get-ClientCredentials {
    Copy-Remote "root@$($c.server.address):/var/lib/cloud-stack/client.json" (Join-Path $state 'client.json')
    Invoke-Client prepare
}
function Set-Server([switch]$Attach,[switch]$Legacy) {
    if(!(Get-Command ssh.exe -ErrorAction SilentlyContinue)){throw 'Install the Windows OpenSSH Client optional feature first'}
    Invoke-Client keygen $adminKey
    Invoke-Client keygen (Join-Path $state 'tunnel_key')
    $pub=(Get-Content -LiteralPath "$adminKey.pub" -Raw).Trim()
    if($pub -notmatch '^ssh-ed25519 ([A-Za-z0-9+/=]+)(?: .*)?$'){throw 'Invalid generated admin public key'}
    $pubBody=$Matches[1]
    $encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pub+"`n"))
    # Only a public key is sent in this command. Password entry stays with the SSH client.
    Invoke-SSH "set -eu; umask 077; mkdir -p /root/.ssh; touch /root/.ssh/authorized_keys; if ! grep -qF '$pubBody' /root/.ssh/authorized_keys; then echo $encoded | base64 -d >> /root/.ssh/authorized_keys; fi; chmod 700 /root/.ssh; chmod 600 /root/.ssh/authorized_keys" -Initial
    # Separate connection proves key authentication before disabling server password login.
    Invoke-SSH 'printf KEY_AUTH_OK'
    if($sshExit -ne 0){throw 'New SSH key has not been verified; no hardening performed'}
    Invoke-SSH "install -d -m 700 $upload"
    Invoke-Client server-config (Join-Path $state 'deployment.json')
    foreach($name in @('bootstrap.sh','server.py','backup.py')){Copy-Remote (Join-Path $PSScriptRoot "server\$name") "root@$($c.server.address):$upload/$name"}
    Copy-Remote (Join-Path $PSScriptRoot 'releases.lock.json') "root@$($c.server.address):$upload/releases.lock.json"
    Copy-Remote (Join-Path $state 'deployment.json') "root@$($c.server.address):$upload/deployment.json"
    Copy-Remote (Join-Path $state 'tunnel_key.pub') "root@$($c.server.address):$upload/tunnel.pub"
    $action=if($Legacy){'adopt-legacy'}elseif($Attach){'add-client'}else{'install'}
    Invoke-SSH "bash $upload/bootstrap.sh $action"
    if($sshExit -ne 0){throw 'Server operation did not finish'}
    Invoke-SSH 'printf HARDENED_SSH_OK'
    Get-ClientCredentials
    Write-Host "Server ready. Credentials are protected in $state\panel-login.txt"
}
function Find-Clash {
    $candidates=@($c.local.clashExe)
    $proc=Get-Process clash-verge -ErrorAction SilentlyContinue | Select-Object -First 1
    if($proc){$candidates+=$proc.Path}
    $candidates+=@("$env:ProgramFiles\Clash Verge\clash-verge.exe","$env:LOCALAPPDATA\Programs\Clash Verge\clash-verge.exe")
    $script:clashExe=$candidates | Where-Object {$_ -and (Test-Path -LiteralPath $_)} | Select-Object -First 1
    if(!$script:clashExe){throw 'Clash Verge was not found; set local.clashExe to its executable path'}
    $script:coreExe=Join-Path (Split-Path $clashExe) 'verge-mihomo.exe'
    if(!(Test-Path $coreExe)){throw 'Clash Mihomo core is missing'}
    $script:clashDir=Join-Path $env:APPDATA 'io.github.clash-verge-rev.clash-verge-rev'
}
function Set-Windows {
    Find-Clash
    if(!(Test-Path (Join-Path $state 'client.json'))){throw 'Run Server or Attach first'}
    Copy-Item -LiteralPath $Config -Destination (Join-Path $state 'config.json')
    foreach($f in @('Common.ps1','Watch.ps1','Launch.ps1')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot "windows\$f") -Destination (Join-Path $state $f)}
    Write-Json (Join-Path $state 'runtime.json') @{config=$c;coreExe=$coreExe;clashExe=$clashExe}
    Invoke-Client prepare
    & $coreExe -t -d $state -f (Join-Path $state 'aux.json')
    if($LASTEXITCODE -ne 0){throw 'Auxiliary proxy configuration did not validate'}
    $flag=Join-Path $state 'stop-helpers';if(Test-Path -LiteralPath $flag){Remove-Item -LiteralPath $flag}
    Start-Helpers $state
    $healthy=$false
    for($i=0;$i -lt 15;$i++){try {if((Get-ExitIP $c.local.auxPort) -eq $c.server.address){$healthy=$true;break}}catch{};Start-Sleep -Seconds 2}
    if(!$healthy){throw 'Auxiliary proxy failed. Existing system proxy was not changed. Check server firewall and AuxProxy logs.'}
    $tunnelReady=$false
    for($i=0;$i -lt 15;$i++){try {$h=Invoke-RestMethod "http://127.0.0.1:$($c.local.apiPort)/health" -TimeoutSec 2;if($h.status -eq 'ok'){$tunnelReady=$true;break}}catch{};Start-Sleep -Seconds 2}
    if(!$tunnelReady){throw 'SSH port forwarding did not become healthy. Inspect Tunnel stderr/error logs before proceeding.'}
    $rules=Join-Path $state 'ruleset';New-Item -ItemType Directory -Path $rules -Force | Out-Null
    foreach($pair in @(@('cloud_cn_domain','geosite'),@('cloud_cn_ip','geoip'))) {
        & curl.exe --silent --show-error --fail --location --max-time 90 --noproxy 'localhost,127.0.0.1' --proxy "http://127.0.0.1:$($c.local.auxPort)" "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/$($pair[1])/cn.mrs" --output (Join-Path $rules "$($pair[0]).mrs")
        if($LASTEXITCODE -ne 0){throw 'CN rule download failed'}
    }
    & $coreExe -t -d $state -f (Join-Path $state 'proxy.json')
    if($LASTEXITCODE -ne 0){throw 'Main proxy configuration did not validate'}
    if(!(Test-Path (Join-Path $clashDir 'profiles.yaml'))) {
        Start-Process -FilePath $clashExe -WindowStyle Hidden | Out-Null
        for($i=0;$i -lt 20;$i++){if(Test-Path (Join-Path $clashDir 'profiles.yaml')){break};Start-Sleep -Seconds 1}
        if(!(Test-Path (Join-Path $clashDir 'profiles.yaml'))){throw 'Open Clash Verge once to finish first-run initialization, then rerun Windows'}
    }
    $shell=New-Object -ComObject WScript.Shell
    foreach($mode in @('Browser','Panel','Claude','Recover')) {
        $shortcut=$shell.CreateShortcut((Join-Path $state "$mode.lnk"));$shortcut.TargetPath="$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
        $shortcut.Arguments=Quote-Args @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $state 'Launch.ps1'),'-StateDir',$state,'-Mode',$mode)
        $shortcut.WorkingDirectory=$env:USERPROFILE;$shortcut.Save()
    }
    if($c.local.autoStart) {
        $startup=[Environment]::GetFolderPath('Startup')
        $link=$shell.CreateShortcut((Join-Path $startup "CloudStack-$($c.instanceId).lnk"));$link.TargetPath="$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
        $link.Arguments=Quote-Args @('-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',(Join-Path $state 'Launch.ps1'),'-StateDir',$state,'-Mode','Recover');$link.WindowStyle=7;$link.Save()
    } else {
        foreach($name in @("CloudStack-$($c.instanceId).lnk","CloudStack-Clash-$($c.instanceId).lnk")){$owned=Join-Path ([Environment]::GetFolderPath('Startup')) $name;if(Test-Path -LiteralPath $owned){Remove-Item -LiteralPath $owned}}
    }
    Write-Host "Windows preparation complete. Open launchers in $state . Activate enables TUN and the system proxy."
}
function Assert-Admin {
    $principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if(!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Activate/Rollback require an administrator PowerShell for the SAME Windows user. Rerun this phase after elevation.'}
}
function Stop-MainClash {
    Get-Process clash-verge -ErrorAction SilentlyContinue | Stop-Process
    $svc=Get-Service clash_verge_service -ErrorAction SilentlyContinue
    if($svc){Stop-Service $svc.Name -Force}
    # Leave this kit auxiliary core and unrelated proxies running.
    Get-CimInstance Win32_Process -Filter "Name='verge-mihomo.exe'" | Where-Object {$_.CommandLine -and $_.CommandLine.Contains($clashDir)} | ForEach-Object {Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue}
    Start-Sleep -Seconds 2
}
function Start-MainClash {
    Start-Service clash_verge_service
    Start-Process -FilePath $clashExe -WindowStyle Hidden | Out-Null
}
function Restore-Previous {
    Assert-Admin;Find-Clash
    $pointer=Join-Path $state 'rollback.json'
    if(!(Test-Path $pointer)){throw 'No rollback pointer exists'}
    $backupName=(Get-Content $pointer -Raw -Encoding UTF8 | ConvertFrom-Json).directory
    if($backupName -notmatch '^rollback-[0-9a-f-]+$'){throw 'Invalid rollback directory'}
    $backup=Join-Path $state $backupName
    if(!(Test-Path (Join-Path $backup 'manifest.json'))){throw 'No completed pre-switch snapshot exists'}
    Stop-MainClash
    $snapshot=Get-Content (Join-Path $backup 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach($entry in $snapshot.files) {
        if($entry.path -notin @('profiles.yaml','verge.yaml','config.yaml','clash-verge.yaml',"profiles\cs-$($c.instanceId).yaml") -or $entry.name -notmatch '^file-[0-9]+\.bak$'){throw 'Unexpected path in rollback snapshot'}
        $dest=Join-Path $clashDir $entry.path
        if($entry.existed){Copy-Item -LiteralPath (Join-Path $backup $entry.name) -Destination $dest -Force}
        elseif(Test-Path -LiteralPath $dest){Remove-Item -LiteralPath $dest}
    }
    $key='HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
    foreach($entry in $snapshot.proxy) {
        if($entry.present){Set-ItemProperty $key $entry.name $entry.value}
        else {Remove-ItemProperty $key $entry.name -ErrorAction SilentlyContinue}
    }
    if($snapshot.region){Set-TimeZone -Id $snapshot.region.timeZone;Set-Culture $snapshot.region.culture;Set-WinHomeLocation -GeoId $snapshot.region.geoId}
    Refresh-InternetSettings
    if(Get-Service clash_verge_service -ErrorAction SilentlyContinue){Start-MainClash}else{Start-Process -FilePath $clashExe -WindowStyle Hidden | Out-Null}
    Write-Host 'Previous Clash files, proxy and region restored. Auxiliary recovery connection is still available.'
}
function Enable-Clash {
    Assert-Admin;Find-Clash
    if($c.region.enabled){[void][TimeZoneInfo]::FindSystemTimeZoneById($c.region.windowsTimeZone);[void][Globalization.CultureInfo]::GetCultureInfo($c.region.culture)}
    if((Get-ExitIP $c.local.auxPort) -ne $c.server.address){throw 'Auxiliary recovery route must pass before activation'}
    & $coreExe -t -d $state -f (Join-Path $state 'proxy.json')
    if($LASTEXITCODE -ne 0){throw 'Profile validation failed before switching'}
    $backupName='rollback-'+[Guid]::NewGuid().ToString('N');$backup=Join-Path $state $backupName;New-Item -ItemType Directory -Path $backup | Out-Null
    $files=@();$n=0
    foreach($rel in @('profiles.yaml','verge.yaml','config.yaml','clash-verge.yaml',"profiles\cs-$($c.instanceId).yaml")) {
        $src=Join-Path $clashDir $rel;$name="file-$n.bak";$exists=Test-Path -LiteralPath $src
        if($exists){Copy-Item -LiteralPath $src -Destination (Join-Path $backup $name) -Force}
        $files+=@{path=$rel;name=$name;existed=$exists};$n++
    }
    $key=Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
    $proxy=@();foreach($name in @('ProxyEnable','ProxyServer','ProxyOverride')){$property=$key.PSObject.Properties[$name];$proxy+=@{name=$name;present=($null -ne $property);value=$(if($property){$property.Value}else{$null})}}
    Write-Json (Join-Path $backup 'manifest.json') @{files=$files;proxy=$proxy;region=@{timeZone=(Get-TimeZone).Id;culture=(Get-Culture).Name;geoId=(Get-WinHomeLocation).GeoId}}
    Write-Json (Join-Path $state 'rollback.json') @{directory=$backupName}
    try {
        Stop-MainClash
        if(!(Get-Service clash_verge_service -ErrorAction SilentlyContinue)) {
            $installer=Join-Path (Split-Path $clashExe) 'resources\clash-verge-service-install.exe'
            if(!(Test-Path $installer)){throw 'Clash bundled service installer is missing'}
            $proc=Start-Process -FilePath $installer -WindowStyle Hidden -Wait -PassThru
            if($proc.ExitCode -ne 0){throw 'Clash service installation failed'}
        }
        Invoke-Client activate $clashDir
        Start-MainClash
        $ready=$false
        for($i=0;$i -lt 20;$i++) {
            Start-Sleep -Seconds 2
            try {Invoke-Client check-core $clashDir;if((Get-ExitIP $c.local.mainPort) -eq $c.server.address){$ready=$true;break}}catch{}
        }
        if(!$ready){throw 'Active TUN or proxy egress validation failed'}
        Set-SystemProxy $c.local.mainPort
        if($c.region.enabled){Set-TimeZone -Id $c.region.windowsTimeZone;Set-Culture $c.region.culture;Set-WinHomeLocation -GeoId $c.region.geoId}
        if($c.local.autoStart) {
            $shell=New-Object -ComObject WScript.Shell
            $link=$shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) "CloudStack-Clash-$($c.instanceId).lnk"));$link.TargetPath=$clashExe;$link.WindowStyle=7;$link.Save()
        }
        Write-Host 'Clash active: browser public traffic via server; other CN destinations direct; UDP and IPv6 captured by strict TUN.'
    } catch {
        $reason=$_.Exception.Message
        try {Restore-Previous}catch {Write-Warning "Automatic rollback failed: $($_.Exception.Message). Use the auxiliary browser launcher while repairing Clash."}
        throw "Activation failed: $reason"
    }
}
function Set-Gateway {
    Invoke-SSH "python3 $upload/server.py gateway"
    if($sshExit -eq 3){Write-Host "OWNER ACTION: read the notice at http://127.0.0.1:$($c.local.apiPort), then rerun Gateway. Login: $state\panel-login.txt";return}
    Get-ClientCredentials
    Write-Host 'Local API configuration is ready. Add your authorized upstream account personally in the Sub2API panel.'
}
function Test-Stack {
    Find-Clash
    Invoke-Client check-core $clashDir
    foreach($port in @($c.local.mainPort,$c.local.auxPort)){if((Get-ExitIP $port) -ne $c.server.address){throw "Unexpected IPv4 egress at local port $port"}}
    $h=Invoke-RestMethod "http://127.0.0.1:$($c.local.apiPort)/health" -TimeoutSec 5
    if($h.status -ne 'ok'){throw 'Sub2API health check failed'}
    Invoke-SSH "python3 $upload/server.py check"
    & node.exe (Join-Path $PSScriptRoot 'lib\stun.cjs') $c.server.address
    if($LASTEXITCODE -ne 0){throw 'Native UDP check failed'}
    Write-Host 'TCP, native UDP, strict dual-stack TUN and panel health passed. Verify WebRTC in your actual browser at ip.net.coffee.'
}
switch($Phase) {
    Server {Set-Server}
    Attach {Set-Server -Attach}
    AttachLegacy {Set-Server -Legacy}
    Windows {Set-Windows}
    Activate {Enable-Clash}
    Gateway {Set-Gateway}
    Check {Test-Stack}
    Rollback {Restore-Previous}
    Suspend {
        [IO.File]::WriteAllText((Join-Path $state 'stop-helpers'),'requested')
        foreach($name in @("CloudStack-$($c.instanceId).lnk","CloudStack-Clash-$($c.instanceId).lnk")){$owned=Join-Path ([Environment]::GetFolderPath('Startup')) $name;if(Test-Path -LiteralPath $owned){Remove-Item -LiteralPath $owned}}
        Write-Host 'This instance helpers will stop within a few seconds; its startup shortcuts were removed. Clash remains running until you switch profiles.'
    }
    All {Set-Server;Set-Windows;Enable-Clash;Set-Gateway;Test-Stack}
}
