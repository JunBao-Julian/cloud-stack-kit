$ErrorActionPreference='Stop'
function Write-Json($Path,$Value) {
    [IO.File]::WriteAllText($Path,($Value | ConvertTo-Json -Depth 30),[Text.UTF8Encoding]::new($false))
}
function Protect-Directory($Path) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $Path /inheritance:r /grant:r "*$($sid):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if($LASTEXITCODE -ne 0){throw 'Unable to protect the state directory ACL'}
}
function Quote-Args($Values) {
    # All paths are file paths without embedded quotes; doubled trailing slashes obey CommandLineToArgvW.
    return (($Values | ForEach-Object {
        if($_ -match '["\r\n]'){throw 'Argument contains unsupported quote or newline'}
        '"'+([string]$_ -replace '(\\+)$','$1$1')+'"'
    }) -join ' ')
}
function Start-Hidden($File,$Arguments) {
    Start-Process -FilePath $File -ArgumentList (Quote-Args $Arguments) -WindowStyle Hidden -PassThru
}
function Test-LocalPort([int]$Port) {
    $client=[Net.Sockets.TcpClient]::new()
    try { $t=$client.ConnectAsync('127.0.0.1',$Port); if(!$t.Wait(700)){return $false}; return $client.Connected } catch {return $false} finally {$client.Dispose()}
}
function Get-ExitIP([int]$Port) {
    $result=& curl.exe --silent --show-error --fail --max-time 15 --noproxy 'localhost,127.0.0.1' --proxy "http://127.0.0.1:$Port" https://api.ipify.org
    if($LASTEXITCODE -ne 0){throw 'Proxy egress probe failed'}
    return ([string]$result).Trim()
}
function Start-Helpers($StateDir) {
    foreach($mode in @('Tunnel','AuxProxy')) {
        Start-Hidden powershell.exe @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $StateDir 'Watch.ps1'),'-StateDir',$StateDir,'-Mode',$mode) | Out-Null
    }
}
function Refresh-InternetSettings {
    if(-not ('CloudStack.WinInet' -as [type])) {
        Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; namespace CloudStack { public class WinInet { [DllImport("wininet.dll")] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l); }}'
    }
    [void][CloudStack.WinInet]::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0)
    [void][CloudStack.WinInet]::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0)
}
function Set-SystemProxy([int]$Port) {
    $key='HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
    Set-ItemProperty $key ProxyEnable 1 -Type DWord
    Set-ItemProperty $key ProxyServer "127.0.0.1:$Port"
    Set-ItemProperty $key ProxyOverride '<local>;localhost;127.*;10.*;192.168.*;172.16.*;172.17.*;172.18.*;172.19.*;172.2?*;172.30.*;172.31.*'
    Refresh-InternetSettings
}
