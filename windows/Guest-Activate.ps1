param([string]$StateDir,[string]$ExpectedSid,[ValidateSet('Activate','Rollback')][string]$Phase='Activate')
$ErrorActionPreference='Stop'
if([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne $ExpectedSid){throw 'Elevation must use the SAME Windows user. No network change made.'}
$env:Path=(Join-Path $StateDir 'bin')+';'+$env:Path
& (Join-Path (Split-Path $PSScriptRoot) 'Setup.ps1') -Phase $Phase -Config (Join-Path $StateDir 'config.json')
exit $LASTEXITCODE
