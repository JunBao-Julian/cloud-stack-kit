param([Parameter(Mandatory)][string]$StateDir,[Parameter(Mandatory)][string]$Installer)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
$config=Join-Path $StateDir 'config.json'
$c=Get-Content -LiteralPath $config -Raw -Encoding UTF8 | ConvertFrom-Json
$clash=@($c.local.clashExe)
$running=Get-Process clash-verge -ErrorAction SilentlyContinue | Select-Object -First 1
if($running){$clash+=$running.Path}
$clash+=@("$env:ProgramFiles\Clash Verge\clash-verge.exe","$env:LOCALAPPDATA\Programs\Clash Verge\clash-verge.exe")
$found=$clash | Where-Object {$_ -and (Test-Path -LiteralPath $_)} | Select-Object -First 1
if(!$found){
    Write-Host 'Installing Clash Verge. Windows will ask for administrator approval.'
    $p=Start-Process -FilePath $Installer -ArgumentList '/S' -Verb RunAs -WindowStyle Hidden -Wait -PassThru
    if($p.ExitCode -ne 0){throw 'Clash installation failed or was canceled'}
    $found=$clash | Where-Object {$_ -and (Test-Path -LiteralPath $_)} | Select-Object -First 1
}
if(!$found){throw 'Clash executable not found after installation'}
$c.local.clashExe=$found
Write-Json $config $c
$kit=Join-Path $StateDir 'Kit'
$env:Path=(Join-Path $StateDir 'bin')+';'+$env:Path
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $kit 'Setup.ps1') -Phase Windows -Config $config
if($LASTEXITCODE -ne 0){throw 'Preparation failed; existing system proxy was not switched'}
$claude=Join-Path $env:USERPROFILE '.local\bin\claude.exe'
if(!(Test-Path -LiteralPath $claude) -and !(Get-Command claude.exe,claude.cmd -ErrorAction SilentlyContinue)){
    $installerScript=Join-Path $StateDir 'install-claude.ps1'
    $env:HTTP_PROXY="http://127.0.0.1:$($c.local.auxPort)";$env:HTTPS_PROXY=$env:HTTP_PROXY;$env:NO_PROXY='localhost,127.0.0.1,::1'
    & curl.exe --fail --show-error --location --max-time 90 --proxy $env:HTTP_PROXY https://claude.ai/install.ps1 --output $installerScript
    if($LASTEXITCODE -ne 0){throw 'Claude installer download failed; proxy preparation is saved for retry'}
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installerScript stable
    if($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $claude)){throw 'Official Claude installer did not finish'}
}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$activation=Join-Path $kit 'windows\Guest-Activate.ps1'
$args=@('-NoProfile','-ExecutionPolicy','Bypass','-File',$activation,'-StateDir',$StateDir,'-ExpectedSid',$sid)
$shell=New-Object -ComObject WScript.Shell
$desktop=[Environment]::GetFolderPath('Desktop')
foreach($mode in @('Claude','Recover')){
    Copy-Item -LiteralPath (Join-Path $StateDir "$mode.lnk") -Destination (Join-Path $desktop "CloudStack-$mode.lnk") -Force
}
$restore=$shell.CreateShortcut((Join-Path $desktop 'CloudStack-Rollback.lnk'))
$restore.TargetPath="$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
# The launcher elevates only this owned activation helper, using the current user.
$rollback=Join-Path $StateDir 'Rollback.ps1'
$escaped=$activation.Replace("'","''");$stateEscaped=$StateDir.Replace("'","''")
[IO.File]::WriteAllText($rollback,"`$a=@('-NoProfile','-ExecutionPolicy','Bypass','-File','`"$escaped`"','-StateDir','`"$stateEscaped`"','-ExpectedSid','$sid','-Phase','Rollback'); Start-Process powershell.exe -Verb RunAs -ArgumentList `$a -Wait",[Text.UTF8Encoding]::new($false))
$restore.Arguments=Quote-Args @('-NoProfile','-ExecutionPolicy','Bypass','-File',$rollback);$restore.Save()
Write-Host 'Testing the auxiliary connection succeeded. Enabling TUN may briefly reconnect existing traffic.'
$p=Start-Process powershell.exe -Verb RunAs -ArgumentList (Quote-Args $args) -Wait -PassThru
if($p.ExitCode -ne 0){throw 'Activation failed or was canceled. Recovery and rollback shortcuts are on the Desktop.'}
Write-Host 'Guest network ready. Open CloudStack-Claude on the Desktop to use your API gateway.'
