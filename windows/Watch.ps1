param([Parameter(Mandatory)][string]$StateDir,[ValidateSet('Tunnel','AuxProxy')][string]$Mode)
. (Join-Path $PSScriptRoot 'Common.ps1')
$r=Get-Content (Join-Path $StateDir 'runtime.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$c=$r.config
$guest=$c.server.PSObject.Properties['sshUser']
$mutex=[Threading.Mutex]::new($false,"Local\CloudStack-$($c.instanceId)-$Mode")
try {$locked=$mutex.WaitOne(0)} catch [Threading.AbandonedMutexException] {$locked=$true}
if(!$locked){$mutex.Dispose();exit 0}
$child=$null
try {
    while(!(Test-Path (Join-Path $StateDir 'stop-helpers'))) {
        try {
            if($Mode -eq 'Tunnel') {
                $names=if($guest){@('apiPort')}else{@('apiPort','suiPort','subPort')}
                $ports=@($names | ForEach-Object {$c.local.$_})
                if(@($ports | Where-Object {Test-LocalPort $_}).Count){throw 'A tunnel port is already occupied; no unrelated process will be stopped'}
                $file="$env:WINDIR\System32\OpenSSH\ssh.exe"
                $arguments=@('-N','-T','-F',(Join-Path $StateDir 'ssh_config'),'-p',"$($c.server.sshPort)",'-i',(Join-Path $StateDir 'tunnel_key'),'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=15','-o','ServerAliveInterval=20','-o','ServerAliveCountMax=3')
                foreach($name in $names){$arguments+=@('-L',"127.0.0.1:$($c.local.$name):127.0.0.1:$($c.server.$name)")}
                $user=if($guest){$c.server.sshUser}else{'gateway-tunnel'}
                $arguments+="$user@$($c.server.address)"
            } else {
                if(Test-LocalPort $c.local.auxPort){throw 'The auxiliary proxy port is occupied'}
                $file=$r.coreExe;$arguments=@('-d',$StateDir,'-f',(Join-Path $StateDir 'aux.json'))
            }
            $child=Start-Process -FilePath $file -ArgumentList (Quote-Args $arguments) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $StateDir "$Mode.stdout.log") -RedirectStandardError (Join-Path $StateDir "$Mode.stderr.log")
            while(!$child.WaitForExit(1000)) {
                if(Test-Path (Join-Path $StateDir 'stop-helpers')) { $child.Kill();$child.WaitForExit();break }
            }
        } catch { [IO.File]::WriteAllText((Join-Path $StateDir "$Mode.error.log"),([DateTime]::UtcNow.ToString('o')+' '+$_.Exception.Message)) }
        Start-Sleep -Seconds 5
    }
} finally {if($child -and !$child.HasExited){$child.Kill()};$mutex.ReleaseMutex();$mutex.Dispose()}
