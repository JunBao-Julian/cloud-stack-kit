param([string]$Destination)
$ErrorActionPreference='Stop'
if(!$Destination) {
    $version=(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
    $Destination=Join-Path (Split-Path $PSScriptRoot) ("cloud-stack-kit-$version.zip")
}
& node.exe (Join-Path $PSScriptRoot 'lib\check-public.cjs')
if($LASTEXITCODE -ne 0){throw 'Public source check failed'}
$files=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'package-files.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$dist=Join-Path $PSScriptRoot 'dist';New-Item -ItemType Directory -Path $dist -Force | Out-Null
$stage=Join-Path $dist ('stage-'+[Guid]::NewGuid().ToString('N'))
$package=Join-Path $stage 'cloud-stack-kit';New-Item -ItemType Directory -Path $package -Force | Out-Null
try {
    $manifest=@()
    foreach($rel in $files) {
        $src=Join-Path $PSScriptRoot $rel
        $text=[IO.File]::ReadAllText($src)
        if($text -match '-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----|sk-ant-[A-Za-z0-9_-]{20,}') {throw "Possible embedded credential: $rel"}
        $dest=Join-Path $package $rel;New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
        Copy-Item -LiteralPath $src -Destination $dest
        $manifest+=@{file=$rel.Replace('\','/');sha256=(Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLowerInvariant()}
    }
    [IO.File]::WriteAllText((Join-Path $package 'manifest.sha256.json'),($manifest|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zipStream=[IO.File]::Open($Destination,[IO.FileMode]::Create)
    $zip=[IO.Compression.ZipArchive]::new($zipStream,[IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach($rel in ($files+@('manifest.sha256.json'))) {
            $entry=[IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,(Join-Path $package $rel),('cloud-stack-kit/'+$rel.Replace('\','/')),[IO.Compression.CompressionLevel]::Optimal)
            # Preserve executable bits for Finder/Terminal entrypoints on macOS.
            if($rel -match '\.(command|sh)$'){$entry.ExternalAttributes=([int]493 -shl 16)}
        }
    } finally {$zip.Dispose();$zipStream.Dispose()}
    $hash=(Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText(($Destination+'.sha256'),($hash+'  '+[IO.Path]::GetFileName($Destination)+"`n"),[Text.UTF8Encoding]::new($false))
    Write-Host "PACKAGE_READY: $Destination"
    Write-Host "SHA256: $hash"
} finally {
    $resolved=[IO.Path]::GetFullPath($stage)
    $allowed=[IO.Path]::GetFullPath($dist)+[IO.Path]::DirectorySeparatorChar
    if(!$resolved.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase) -or (Split-Path $resolved -Leaf) -notmatch '^stage-[0-9a-f]{32}$'){throw 'Refusing unsafe staging cleanup'}
    if(Test-Path -LiteralPath $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
