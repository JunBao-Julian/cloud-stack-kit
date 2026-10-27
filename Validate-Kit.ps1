param([string]$CoreExe,[string]$RulesDir,[string]$Proxy)
$ErrorActionPreference='Stop'
$errors=@()
Get-ChildItem -LiteralPath $PSScriptRoot -Recurse -Filter *.ps1 | Where-Object {$_.FullName -notmatch '\\node_modules\\'} | ForEach-Object {
    $tokens=$null;$parseErrors=$null
    [void][Management.Automation.Language.Parser]::ParseFile($_.FullName,[ref]$tokens,[ref]$parseErrors)
    $errors+=@($parseErrors)
}
if($errors.Count){$errors | Format-List;throw 'PowerShell syntax check failed'}
Push-Location $PSScriptRoot
try {
    & npm.cmd test
    if($LASTEXITCODE -ne 0){throw 'Node tests failed'}
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Setup.ps1 -Phase Validate -Config .\config.example.json
    if($LASTEXITCODE -ne 0){throw 'Windows entrypoint validation failed'}
    if($CoreExe) {
        & node.exe .\lib\validation-fixtures.cjs
        if($LASTEXITCODE -ne 0){throw 'Fixture generation failed'}
        $output=Join-Path $PSScriptRoot 'test-output';$rules=Join-Path $output 'ruleset'
        New-Item -ItemType Directory -Path $rules -Force | Out-Null
        foreach($pair in @(@('cloud_cn_domain','geosite'),@('cloud_cn_ip','geoip'))) {
            $dest=Join-Path $rules "$($pair[0]).mrs"
            if($RulesDir){Copy-Item -LiteralPath (Join-Path $RulesDir "$($pair[0]).mrs") -Destination $dest}
            elseif(!(Test-Path $dest)) {
                $arguments=@('--fail','--silent','--show-error','--location','--max-time','90')
                if($Proxy){$arguments+=@('--proxy',$Proxy,'--noproxy','localhost,127.0.0.1')}
                & curl.exe @arguments "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/$($pair[1])/cn.mrs" --output $dest
                if($LASTEXITCODE -ne 0){throw 'Rule fixture download failed'}
            }
        }
        foreach($name in @('main','aux','tun')) {
            & $CoreExe -t -d $output -f (Join-Path $output "$name.json")
            if($LASTEXITCODE -ne 0){throw "Mihomo rejected $name"}
        }
    }
    Write-Host 'KIT_VALIDATION_OK (no active proxy, region or server services were changed)'
} finally {Pop-Location}
