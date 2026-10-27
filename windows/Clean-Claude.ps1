[CmdletBinding()]
param([switch]$Preview)
$ErrorActionPreference='Stop'
$kit=Split-Path $PSScriptRoot
. (Join-Path $PSScriptRoot 'Common.ps1')
if(!(Get-Command node.exe -ErrorAction SilentlyContinue)){throw 'Install Node.js LTS (22.13 or newer), then rerun Cleanup-Claude.cmd.'}
if([version](& node.exe -p 'process.versions.node') -lt [version]'22.13.0'){throw 'Cleanup requires Node.js 22.13 or newer.'}
if(!(Test-Path -LiteralPath (Join-Path $kit 'node_modules\classic-level\package.json'))){
    Write-Host 'Installing locked tool dependencies; no application data is being cleaned yet.'
    Push-Location $kit
    try {
        & npm.cmd ci --ignore-scripts --no-audit --no-fund
        if($LASTEXITCODE -ne 0){throw 'Dependency installation failed. Configure npm network access and rerun.'}
    } finally {Pop-Location}
}
$cleaner=Join-Path $kit 'lib\claude-cleanup.cjs'
Write-Host '=== Claude local data cleanup: preview ==='
& node.exe $cleaner --preview
if($LASTEXITCODE -ne 0){throw 'Preview failed. No cleanup was performed.'}
$envNames=@('ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_API_KEY')
$userVariables=@($envNames | Where-Object {$null -ne [Environment]::GetEnvironmentVariable($_,'User')})
$machineVariables=@($envNames | Where-Object {$null -ne [Environment]::GetEnvironmentVariable($_,'Machine')})
Write-Host ('User-level authentication variables to remove: '+($userVariables -join ', '))
if($machineVariables.Count){Write-Warning ('Machine-level variables require manual review: '+($machineVariables -join ', '))}
if($env:CLAUDE_CONFIG_DIR){Write-Warning 'A custom CLAUDE_CONFIG_DIR is set. Custom directories are not automatically cleaned.'}
if($Preview){Write-Host 'Preview only. Browser databases were not opened or modified.';exit 0}

Write-Host ''
Write-Host 'This removes recognized Claude logins, saved site passwords, history, local conversations and caches.'
Write-Host 'It cannot distinguish banned, old or new accounts. Current recognized logins will also be removed.'
Write-Host 'Shared Chromium caches/service workers are cleared: other sites may reload or lose offline caches.'
Write-Host 'Other site cookies/passwords, bookmarks, code projects and CloudStack instances are retained.'
Write-Host 'No credential backup is made. Deleted local history cannot be restored by this tool.'
Write-Host 'Save your work. Close browsers, Claude and VS Code/Cursor/Windsurf, including background processes.'
Write-Host 'Cloud records, browser sync, shared SSO, custom profiles and device/account association are outside this cleanup.'
Write-Host 'This is local data hygiene, not a guarantee against account restrictions.'
$answer=Read-Host 'Type CLEAN to confirm saved work, closing the listed apps, and irreversible cleanup; anything else cancels'
if($answer -cne 'CLEAN'){Write-Host 'Cancelled. No application data was removed.';exit 0}

# Ask windows to close gracefully. Do not kill applications or discard unsaved documents.
$names=@('chrome','msedge','firefox','brave','vivaldi','opera','Arc','claude','Code','Code - Insiders','VSCodium','Cursor','Windsurf')
$session=(Get-Process -Id $PID).SessionId
$open=@(Get-Process -Name $names -ErrorAction SilentlyContinue | Where-Object {$_.SessionId -eq $session})
foreach($p in $open){if($p.MainWindowHandle -ne 0){[void]$p.CloseMainWindow()}}
for($i=0;$i -lt 10;$i++) {
    $remaining=@(Get-Process -Name $names -ErrorAction SilentlyContinue | Where-Object {$_.SessionId -eq $session})
    if(!$remaining.Count){break}
    Start-Sleep -Seconds 1
}
if($remaining.Count){throw ('Close these applications and background processes, then rerun: '+(($remaining.ProcessName | Sort-Object -Unique)-join ', '))}

# Capture only counts and generic labels. Do not keep copies of credentials or raw database entries.
Write-Host 'Cleaning approved local data. Large caches can take several minutes; keep this window open.'
$output=& node.exe $cleaner --apply --confirm-delete-local-data
$nodeExit=$LASTEXITCODE
if($output){$output | Write-Host}
if($nodeExit -ne 0){throw 'Some cleanup operations failed. Review the report; do not assume all local data is cleared.'}
foreach($name in $userVariables){[Environment]::SetEnvironmentVariable($name,$null,'User')}
foreach($name in $envNames){Remove-Item -LiteralPath ('Env:'+ $name) -ErrorAction SilentlyContinue}
Write-Host 'Recognized local data cleanup completed. Restart terminals so removed user environment values take effect.'
Write-Host 'Review docs/cleanup.md for locations that still require manual inspection.'
