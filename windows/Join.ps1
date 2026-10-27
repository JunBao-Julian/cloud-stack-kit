param([ValidateSet('join','invite','revoke')][string]$Mode='join')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
$repo=Split-Path $PSScriptRoot
$cache=Join-Path $env:LOCALAPPDATA 'CloudStack\Tools'
Protect-Directory $cache
$node=Get-Command node.exe -ErrorAction SilentlyContinue
if(!$node -or [version]((& $node.Source -p 'process.versions.node')) -lt [version]'22.13.0') {
    $arch=if($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64'){'arm64'}else{'x64'}
    $sha=if($arch -eq 'arm64'){'5b44fd410df7b4cd0a1891a05a7b606f8fb7d8786a94997b996a372e82478d7a'}else{'c97fa376d2becdc8863fcd3ca2dd9a83a9f3468ee7ccf7a6d076ec66a645c77a'}
    $name="node-v22.22.0-win-$arch"
    $zip=Join-Path $cache "$name.zip"
    Write-Host 'Downloading verified Node.js runtime...'
    & curl.exe --fail --show-error --location --retry 2 --connect-timeout 20 --max-time 600 "https://nodejs.org/dist/v22.22.0/$name.zip" --output $zip
    if($LASTEXITCODE -ne 0){throw 'Node download failed. Keep your existing working network/proxy enabled and retry.'}
    if((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha){throw 'Node checksum mismatch'}
    Expand-Archive -LiteralPath $zip -DestinationPath $cache -Force
    $node=Get-Item (Join-Path $cache "$name\node.exe")
    $nodePath=$node.FullName
} else {$nodePath=$node.Source}
$env:Path=(Split-Path $nodePath)+';'+$env:Path
if(!(Get-Command ssh.exe -ErrorAction SilentlyContinue)){throw 'Enable the Windows OpenSSH Client optional feature, then retry.'}
Push-Location $repo
try {
    & (Join-Path (Split-Path $nodePath) 'npm.cmd') ci --ignore-scripts --no-audit --no-fund
    if($LASTEXITCODE -ne 0){throw 'Dependency download failed; keep your existing proxy connected and retry'}
    & $nodePath (Join-Path $repo 'lib\guest.cjs') $Mode
    exit $LASTEXITCODE
} finally {Pop-Location}
