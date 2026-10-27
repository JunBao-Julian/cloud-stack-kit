[CmdletBinding()]
param(
    [ValidateSet('Apply','Restore','Status')][string]$Mode='Status',
    [string]$Language='en-US',
    [string]$StateDir=(Join-Path $env:LOCALAPPDATA 'CloudStack\preferences')
)
. (Join-Path $PSScriptRoot 'Common.ps1')
$backup=Join-Path $StateDir 'language-before.json'
function Get-LanguageState {
    $list=Get-WinUserLanguageList
    return [ordered]@{
        version=1
        culture=(Get-Culture).Name
        uiOverride=[string](Get-WinUILanguageOverride)
        systemLocale=(Get-WinSystemLocale).Name
        languages=@(foreach($item in $list){[ordered]@{tag=$item.LanguageTag;inputMethodTips=@($item.InputMethodTips);spellchecking=$item.Spellchecking;handwriting=$item.Handwriting}})
    }
}
if($Mode -eq 'Status'){Get-LanguageState | ConvertTo-Json -Depth 6;exit 0}
$previous=Get-WinUserLanguageList
$previousCulture=(Get-Culture).Name
if($Mode -eq 'Apply') {
    [void][Globalization.CultureInfo]::GetCultureInfo($Language)
    $target=New-WinUserLanguageList -Language $Language
    foreach($item in $previous) {
        if($item.LanguageTag -eq $Language){$target[0]=$item}
        else {$target.Add($item)}
    }
    Protect-Directory $StateDir
    if(!(Test-Path -LiteralPath $backup)){Write-Json $backup (Get-LanguageState)}
    $culture=$Language
} else {
    if(!(Test-Path -LiteralPath $backup)){throw 'No original language backup exists'}
    $saved=Get-Content -LiteralPath $backup -Raw -Encoding UTF8 | ConvertFrom-Json
    if($saved.version -ne 1 -or !$saved.languages.Count){throw 'Invalid language backup'}
    $target=New-WinUserLanguageList -Language $saved.languages[0].tag
    $target.Clear()
    foreach($entry in $saved.languages) {
        $item=(New-WinUserLanguageList -Language $entry.tag)[0]
        $item.InputMethodTips.Clear()
        foreach($tip in $entry.inputMethodTips){$item.InputMethodTips.Add([string]$tip)}
        $item.Spellchecking=[bool]$entry.spellchecking
        $item.Handwriting=[bool]$entry.handwriting
        $target.Add($item)
    }
    $culture=$saved.culture
}
try {
    Set-WinUserLanguageList -LanguageList $target -Force
    Set-Culture -CultureInfo $culture
    $actual=Get-WinUserLanguageList
    if($actual[0].LanguageTag -ne $target[0].LanguageTag){throw 'Preferred language read-back failed'}
    foreach($item in $target) {
        if(!(@(foreach($entry in $actual){$entry.LanguageTag}) -contains $item.LanguageTag)){throw 'A requested language is missing'}
    }
} catch {
    Set-WinUserLanguageList -LanguageList $previous -Force
    Set-Culture -CultureInfo $previousCulture
    throw
}
Get-LanguageState | ConvertTo-Json -Depth 6
Write-Host "Backup: $backup. Windows display language and system locale were not changed."
