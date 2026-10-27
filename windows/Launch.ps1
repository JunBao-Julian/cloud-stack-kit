param([Parameter(Mandatory)][string]$StateDir,[ValidateSet('Browser','Panel','Claude','Recover')][string]$Mode='Recover',[Parameter(ValueFromRemainingArguments=$true)][string[]]$CliArgs)
. (Join-Path $PSScriptRoot 'Common.ps1')
$r=Get-Content (Join-Path $StateDir 'runtime.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$c=$r.config
$flag=Join-Path $StateDir 'stop-helpers'
if(Test-Path -LiteralPath $flag){Remove-Item -LiteralPath $flag}
Start-Helpers $StateDir
if($Mode -eq 'Recover') {
    if(!(Get-Process clash-verge -ErrorAction SilentlyContinue)) {
        if(!(Test-Path -LiteralPath $r.clashExe)){throw 'Configured Clash executable is missing'}
        Start-Process -FilePath $r.clashExe -WindowStyle Hidden | Out-Null
    }
    Write-Host 'Clash and reconnect watchdogs started. Existing processes were left running.'
    exit 0
}
if($Mode -in @('Browser','Panel')) {
    $edge=@("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe","$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object {Test-Path $_} | Select-Object -First 1
    if(!$edge){throw 'Microsoft Edge is required for the isolated browser launcher'}
    if((Get-ExitIP $c.local.auxPort) -ne $c.server.address){throw 'Auxiliary proxy has not connected yet. Retry shortly.'}
    $url=if($Mode -eq 'Panel'){"http://127.0.0.1:$($c.local.apiPort)"}else{'https://ip.net.coffee/'}
    # This is an explicitly requested interactive browser window.
    Start-Process -FilePath $edge -ArgumentList (Quote-Args @("--user-data-dir=$(Join-Path $StateDir 'EdgeProfile')","--proxy-server=http://127.0.0.1:$($c.local.auxPort)","--lang=$($c.region.culture)","--accept-lang=$($c.region.culture),en",$url)) | Out-Null
    exit 0
}
$settings=Join-Path $StateDir 'claude-settings.json'
if(!(Test-Path $settings)){throw 'Run Gateway after personally completing the panel notice and upstream account authorization'}
$health=Invoke-RestMethod "http://127.0.0.1:$($c.local.apiPort)/health" -TimeoutSec 5
if($health.status -ne 'ok'){throw 'Sub2API SSH tunnel is unavailable'}
$cli=Get-Command claude.exe,claude.cmd -ErrorAction SilentlyContinue | Select-Object -First 1
if(!$cli){$cli=Get-ChildItem "$env:USERPROFILE\.vscode\extensions\anthropic.claude-code-*\resources\native-binary\claude.exe" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1}
if(!$cli){throw 'Install Claude Code from its official distribution first'}
Remove-Item Env:ANTHROPIC_API_KEY,Env:CLAUDE_CODE_OAUTH_TOKEN -ErrorAction SilentlyContinue
$settingsData=Get-Content $settings -Raw -Encoding UTF8 | ConvertFrom-Json
foreach($item in $settingsData.env.PSObject.Properties){[Environment]::SetEnvironmentVariable($item.Name,[string]$item.Value,'Process')}
$exe=if($cli.Path){$cli.Path}else{$cli.FullName}
& $exe --settings $settings @CliArgs
exit $LASTEXITCODE
