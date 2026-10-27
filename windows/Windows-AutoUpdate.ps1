param(
    [ValidateSet('Disable','Restore','Status')][string]$Mode='Status',
    [string]$StateDir=(Join-Path $env:LOCALAPPDATA 'CloudStack\windows-update'),
    [switch]$AcknowledgeSecurityUpdatesDisabled,
    [switch]$Elevated
)
$ErrorActionPreference='Stop'
if($Mode -eq 'Disable' -and !$AcknowledgeSecurityUpdatesDisabled){throw 'Disabling Windows Update also blocks system security updates. Rerun with -AcknowledgeSecurityUpdatesDisabled only if intended.'}
$registry='HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU'
$backup=Join-Path $StateDir 'before.json'
$resultPath=Join-Path $StateDir 'last-result.json'
function Save-Json($Path,$Data){[IO.File]::WriteAllText($Path,($Data|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))}
function Read-Status {
    $key=Get-Item -LiteralPath $registry -ErrorAction SilentlyContinue
    $present=$key -and ($key.GetValueNames() -contains 'NoAutoUpdate')
    $value=if($present){[int]$key.GetValue('NoAutoUpdate')}else{$null}
    $service=Get-Service -Name wuauserv
    $notification=$null;$readOnly=$null;$agentError=$null
    try {if($service.StartType -ne 'Disabled'){
        $agent=New-Object -ComObject Microsoft.Update.AutoUpdate
        $settings=$agent.Settings;$settings.Refresh()
        $notification=[int]$settings.NotificationLevel;$readOnly=[bool]$settings.ReadOnly
    }} catch {$agentError=$_.Exception.Message}
    return [ordered]@{NoAutoUpdatePresent=[bool]$present;NoAutoUpdate=$value;serviceStartType=$service.StartType.ToString();serviceStatus=$service.Status.ToString();notificationLevel=$notification;settingsReadOnly=$readOnly;agentError=$agentError;restartPending=(Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired')}
}
if($Mode -eq 'Status'){Read-Status | ConvertTo-Json;exit 0}
$principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if(!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    if($Elevated){throw 'Administrator elevation did not succeed'}
    $argsLine='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$PSCommandPath+'" -Mode '+$Mode+' -StateDir "'+$StateDir+'" -Elevated'
    if($AcknowledgeSecurityUpdatesDisabled){$argsLine+=' -AcknowledgeSecurityUpdatesDisabled'}
    try {$p=Start-Process -FilePath powershell.exe -Verb RunAs -ArgumentList $argsLine -WindowStyle Hidden -PassThru;$p.WaitForExit()}
    catch {throw ('Windows administrator approval was not completed: '+$_.Exception.Message)}
    if(Test-Path -LiteralPath $resultPath){Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8}
    if($p.ExitCode -ne 0){throw "Update setting operation failed (exit $($p.ExitCode))"}
    exit 0
}
New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
try {
    if($Mode -eq 'Disable') {
        if(!(Test-Path -LiteralPath $backup)) {
            $key=Get-Item -LiteralPath $registry -ErrorAction SilentlyContinue
            $present=$key -and ($key.GetValueNames() -contains 'NoAutoUpdate')
            if($present -and $key.GetValueKind('NoAutoUpdate').ToString() -ne 'DWord'){throw 'Unexpected existing policy value type; no change performed'}
            Save-Json $backup ([ordered]@{version=1;savedAtUtc=[DateTime]::UtcNow.ToString('o');present=[bool]$present;value=$(if($present){[int]$key.GetValue('NoAutoUpdate')}else{$null})})
        }
        $saved=Get-Content -LiteralPath $backup -Raw -Encoding UTF8 | ConvertFrom-Json
        if(!$saved.PSObject.Properties['serviceStartType']){
            $service=Get-Service -Name wuauserv
            $saved | Add-Member -NotePropertyName serviceStartType -NotePropertyValue $service.StartType.ToString()
            $saved | Add-Member -NotePropertyName serviceWasRunning -NotePropertyValue ($service.Status -eq 'Running')
            Save-Json $backup $saved
        }
        New-Item -Path $registry -Force | Out-Null
        New-ItemProperty -LiteralPath $registry -Name NoAutoUpdate -PropertyType DWord -Value 1 -Force | Out-Null
        Set-Service -Name wuauserv -StartupType Disabled
        Stop-Service -Name wuauserv -ErrorAction Stop
    } else {
        if(!(Test-Path -LiteralPath $backup)){throw 'No original policy backup is available'}
        $saved=Get-Content -LiteralPath $backup -Raw -Encoding UTF8 | ConvertFrom-Json
        if($saved.version -ne 1 -or $saved.present -isnot [bool]){throw 'Invalid backup format'}
        if($saved.present) {
            if($saved.value -notin @(0,1)){throw 'Unexpected original policy value'}
            New-Item -Path $registry -Force | Out-Null
            New-ItemProperty -LiteralPath $registry -Name NoAutoUpdate -PropertyType DWord -Value ([int]$saved.value) -Force | Out-Null
        } elseif(Test-Path -LiteralPath $registry) {Remove-ItemProperty -LiteralPath $registry -Name NoAutoUpdate -ErrorAction SilentlyContinue}
        if($saved.PSObject.Properties['serviceStartType']){
            if($saved.serviceStartType -notin @('Automatic','Manual','Disabled')){throw 'Unexpected original service startup type'}
            Set-Service -Name wuauserv -StartupType $saved.serviceStartType
            if($saved.serviceWasRunning -and $saved.serviceStartType -ne 'Disabled'){Start-Service -Name wuauserv}
        }
    }
    $state=Read-Status
    if($Mode -eq 'Disable' -and $state.NoAutoUpdate -ne 1){throw 'Policy read-back failed'}
    if($Mode -eq 'Disable' -and ($state.serviceStartType -ne 'Disabled' -or $state.serviceStatus -ne 'Stopped')){throw 'Windows Update service disable verification failed'}
    Save-Json $resultPath ([ordered]@{success=$true;mode=$Mode;completedUtc=[DateTime]::UtcNow.ToString('o');status=$state;backup=$backup})
} catch {
    Save-Json $resultPath ([ordered]@{success=$false;mode=$Mode;error=$_.Exception.Message;completedUtc=[DateTime]::UtcNow.ToString('o')})
    exit 1
}
