#!/usr/bin/env python3
"""Dedicated Ubuntu host bootstrap. No production action occurs on import."""
import argparse, base64, hashlib, http.cookiejar, ipaddress, json, os, pathlib
import platform, secrets, shutil, sqlite3, subprocess, tarfile, tempfile, time
import urllib.error, urllib.parse, urllib.request
from zoneinfo import ZoneInfo
from contextlib import closing

STATE = pathlib.Path('/var/lib/cloud-stack')
HERE = pathlib.Path(__file__).resolve().parent

def run(args, data=None, capture=False, cwd=None):
    p = subprocess.run(args, input=data, text=True, cwd=cwd,
                       stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                       stderr=subprocess.PIPE)
    if p.returncode:
        raise RuntimeError(f'Command failed: {pathlib.Path(args[0]).name} (exit {p.returncode}); inspect local service logs')
    return p.stdout if capture else ''

def save(p, value):
    p = pathlib.Path(p); p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name+'.new')
    tmp.write_text(json.dumps(value, indent=2), encoding='utf-8'); tmp.chmod(0o600); tmp.replace(p)

def validate(c):
    import re
    if c.get('schemaVersion') != 1 or not re.fullmatch(r'[a-z][a-z0-9-]{1,24}', c.get('instanceId','')):
        raise ValueError('Invalid deployment ID')
    ip = ipaddress.ip_address(c['server']['address'])
    if ip.version != 4 or not ip.is_global: raise ValueError('A public IPv4 address is required')
    for section, fields in [('server',['sshPort','proxyPort','apiPort','suiPort','subPort']),
                            ('local',['mainPort','auxPort','dnsPort','auxDnsPort','apiPort','suiPort','subPort'])]:
        ports=[c[section][f] for f in fields]
        if any(type(p) is not int or not 0 < p < 65536 for p in ports) or len(set(ports)) != len(ports):
            raise ValueError('Invalid or overlapping ports')
    ZoneInfo(c['region']['ianaTimeZone'])
    if c['policy']['browserMode'] not in ('proxy','split'): raise ValueError('Invalid browser policy')
    return c

def extract(archive, dest):
    dest=pathlib.Path(dest); dest.mkdir(parents=True,exist_ok=True)
    with tarfile.open(archive) as t:
        for member in t.getmembers():
            p=pathlib.PurePosixPath(member.name)
            if p.is_absolute() or '..' in p.parts or member.isdev(): raise ValueError('Unsafe archive member')
        t.extractall(dest, filter='data')

def artifact(kind, arch, lock):
    meta=lock[kind]; a=meta['assets'][arch]
    url=f"https://github.com/{meta['repository']}/releases/download/{meta['tag']}/{a['name']}"
    output=STATE/'downloads'/a['name']; output.parent.mkdir(parents=True,exist_ok=True)
    if not output.exists() or hashlib.sha256(output.read_bytes()).hexdigest()!=a['sha256']:
        req=urllib.request.Request(url,headers={'User-Agent':'CloudStack-Kit/1.0'})
        with urllib.request.urlopen(req,timeout=90) as src, output.open('wb') as dst: shutil.copyfileobj(src,dst)
    if hashlib.sha256(output.read_bytes()).hexdigest()!=a['sha256']: raise RuntimeError('Release SHA256 mismatch: '+kind)
    return output

class Panel:
    def __init__(self,c,s):
        self.c,self.s=c,s; self.token=None
        self.jar=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def sui(self,endpoint,data=None):
        base=f"http://127.0.0.1:{self.c['server']['suiPort']}"
        req=urllib.request.Request(base+'/app/api/'+endpoint,
            data=urllib.parse.urlencode(data).encode() if data is not None else None,
            headers={'Origin':base,'Referer':base+'/app/'})
        with self.jar.open(req,timeout=25) as r: value=json.load(r)
        if not value.get('success'): raise RuntimeError('S-UI operation failed: '+endpoint)
        return value.get('obj')
    def api(self,endpoint,data=None):
        h={'Content-Type':'application/json'}
        if self.token: h['Authorization']='Bearer '+self.token
        req=urllib.request.Request(f"http://127.0.0.1:{self.c['server']['apiPort']}/api/v1"+endpoint,
            data=json.dumps(data).encode() if data is not None else None,headers=h)
        with urllib.request.urlopen(req,timeout=25) as r: value=json.load(r)
        if value.get('code',0)!=0: raise RuntimeError('Sub2API operation failed: '+endpoint)
        return value.get('data',value)

def export(c,s):
    fields=['instanceId','serverAddress','ssServerKey','ssUserKey','subscriptionId','sub2apiAdminEmail',
            'sub2apiAdminPassword','suiUser','suiPassword','sub2apiApiKey']
    save(STATE/'client.json',{k:s[k] for k in fields if k in s})

def configure_proxy(c,s):
    panel=Panel(c,s); panel.sui('login',{'user':s['suiUser'],'pass':s['suiPassword']})
    tag=s.get('inboundTag','Cloud-'+c['instanceId']); rows=panel.sui('inbounds')['inbounds']
    found=next((x for x in rows if x.get('tag')==tag),None)
    if not found:
        item={'type':'shadowsocks','tag':tag,'listen':'0.0.0.0','listen_port':c['server']['proxyPort'],
              'method':'2022-blake3-aes-128-gcm','password':s['ssServerKey'],'tls_id':0,
              'out_json':{'type':'shadowsocks','server':c['server']['address'],'server_port':c['server']['proxyPort'],'method':'2022-blake3-aes-128-gcm'},
              'addrs':[{'server':c['server']['address'],'server_port':c['server']['proxyPort'],'remark':''}]}
        panel.sui('save',{'object':'inbounds','action':'new','data':json.dumps(item)})
        found=next(x for x in panel.sui('inbounds')['inbounds'] if x['tag']==tag)
    clients=panel.sui('clients')['clients']
    if not any(x.get('name')==s['subscriptionId'] for x in clients):
        item={'enable':True,'name':s['subscriptionId'],'remark':'Personal-','inbounds':[found['id']],
              'volume':0,'expiry':0,'config':{'shadowsocks16':{'name':'personal','password':s['ssUserKey']}},'links':[]}
        panel.sui('save',{'object':'clients','action':'new','data':json.dumps(item)})
    settings={'subClashExt':json.dumps(c['clashTemplate']),'subClashNoDefGrp':'true','subClashUdp':'true',
              'subUpdates':'24','subURI':f"http://127.0.0.1:{c['local']['subPort']}/sub/"}
    panel.sui('save',{'object':'settings','action':'set','data':json.dumps(settings)})

def gateway(c,s):
    panel=Panel(c,s)
    panel.token=panel.api('/auth/login',{'email':s['sub2apiAdminEmail'],'password':s['sub2apiAdminPassword']})['access_token']
    if panel.api('/admin/compliance').get('required'):
        print('OWNER_ACTION_REQUIRED: read and accept the panel compliance notice personally, then rerun Gateway.'); return 3
    if 'sub2apiGroupId' not in s:
        groups=panel.api('/admin/groups')
        rows=groups if isinstance(groups,list) else groups.get('items',groups.get('groups',[]))
        group=next((g for g in rows if g.get('name')=='Personal-Claude'),None)
        if not group: group=panel.api('/admin/groups',{'name':'Personal-Claude','description':'Private use','platform':'anthropic','rate_multiplier':1,'subscription_type':'standard'})
        s['sub2apiGroupId']=group['id']; save(STATE/'credentials.json',s)
    if 'sub2apiApiKey' not in s:
        key=panel.api('/keys',{'name':'CloudStack-'+c['instanceId'],'group_id':s['sub2apiGroupId'],'ip_whitelist':['127.0.0.1/32','::1/128']})
        s['sub2apiApiKey']=key['key']; s['sub2apiKeyId']=key['id']; save(STATE/'credentials.json',s)
    export(c,s); print('GATEWAY_KEY_READY: upstream account authorization remains an owner action.'); return 0

def ssh_access(c):
    pub=(HERE/'tunnel.pub').read_text().strip()
    if not pub.startswith('ssh-ed25519 ') or '\n' in pub: raise ValueError('Invalid tunnel public key')
    subprocess.run(['id','gateway-tunnel'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode and run(['useradd','-m','-s','/usr/sbin/nologin','gateway-tunnel'])
    directory=pathlib.Path('/home/gateway-tunnel/.ssh'); directory.mkdir(mode=0o700,exist_ok=True)
    file=directory/'authorized_keys'; previous=file.read_text() if file.exists() else ''
    restrictions=','.join(['restrict','port-forwarding']+[f'permitopen="127.0.0.1:{c["server"][k]}"' for k in ['apiPort','suiPort','subPort']])
    if pub.split()[1] not in previous: file.write_text(previous.rstrip()+'\n'+restrictions+' '+pub+'\n')
    directory.chmod(0o700); file.chmod(0o600);run(['chown','-R','gateway-tunnel:gateway-tunnel',str(directory)])
    # The Windows entrypoint verifies the new admin key in a separate connection before reaching this step.
    ssh=pathlib.Path('/etc/ssh/sshd_config.d/00-cloud-stack.conf')
    old=ssh.read_text() if ssh.exists() else None
    ssh.write_text('PubkeyAuthentication yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\nMaxAuthTries 3\nMatch User gateway-tunnel\n    AllowTcpForwarding local\n    X11Forwarding no\n    PermitTTY no\n    AllowAgentForwarding no\nMatch all\n')
    try: run(['sshd','-t'])
    except Exception:
        ssh.write_text(old) if old is not None else ssh.unlink(); raise
    run(['systemctl','reload','ssh'])

def install(c,lock):
    release=pathlib.Path('/etc/os-release').read_text()
    if 'ID=ubuntu' not in release or not any(f'VERSION_ID="{v}"' in release for v in ['24.04','26.04']):
        raise RuntimeError('This kit supports dedicated Ubuntu 24.04/26.04 hosts only')
    arch={'x86_64':'amd64','aarch64':'arm64'}.get(platform.machine())
    if not arch: raise RuntimeError('Unsupported server architecture')
    statefile=STATE/'credentials.json'
    if not statefile.exists() and any(pathlib.Path(p).exists() for p in ['/opt/sub2api/sub2api','/usr/local/s-ui/sui','/etc/sub2api.env']):
        raise RuntimeError('Existing unowned deployment found; automatic overwrite refused')
    if statefile.exists():
        s=json.loads(statefile.read_text())
        if s.get('legacyAdopted'):raise RuntimeError('Adopted deployment: use add-client/gateway/check; reinstall and upgrades require a separate migration')
        if s['instanceId']!=c['instanceId'] or s['serverAddress']!=c['server']['address']: raise RuntimeError('Existing deployment identity differs')
        previous=STATE/'config.json'
        if previous.exists() and json.loads(previous.read_text())['server']!=c['server']:
            raise RuntimeError('Server ports cannot be changed by rerunning install; use an explicit migration')
    else:
        STATE.mkdir(parents=True,exist_ok=True,mode=0o700)
        s={'instanceId':c['instanceId'],'serverAddress':c['server']['address'],'sub2apiAdminEmail':'owner@localhost.local',
           'sub2apiAdminPassword':secrets.token_urlsafe(28),'suiUser':'owner','suiPassword':secrets.token_urlsafe(28),
           'dbPassword':secrets.token_hex(24),'jwt':secrets.token_hex(32),'totp':secrets.token_hex(32),
           'ssServerKey':base64.b64encode(secrets.token_bytes(16)).decode(),'ssUserKey':base64.b64encode(secrets.token_bytes(16)).decode(),
           'subscriptionId':secrets.token_urlsafe(24)}
        save(statefile,s)
    STATE.chmod(0o700)
    save(STATE/'config.json',c)
    os.environ['DEBIAN_FRONTEND']='noninteractive'
    print('Installing dependencies...',flush=True)
    run(['apt-get','update']);run(['apt-get','install','-y','ca-certificates','curl','openssl','python3','postgresql','redis-server','ufw'])
    run(['systemctl','enable','--now','postgresql','redis-server'])
    for kind,dest in [('sub2api','/opt/sub2api'),('sui','/usr/local')]:
        binary=pathlib.Path('/opt/sub2api/sub2api' if kind=='sub2api' else '/usr/local/s-ui/sui')
        if not binary.exists(): extract(artifact(kind,arch,lock),dest)
        binary.chmod(0o755)
    if subprocess.run(['id','sub2api'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:
        run(['useradd','--system','--home','/opt/sub2api','--shell','/usr/sbin/nologin','sub2api'])
    pathlib.Path('/opt/sub2api').chmod(0o755)
    pathlib.Path('/opt/sub2api/data').mkdir(parents=True,exist_ok=True)
    run(['chown','-R','sub2api:sub2api','/opt/sub2api/data'])
    role=run(['runuser','-u','postgres','--','psql','-Atqc',"SELECT 1 FROM pg_roles WHERE rolname='sub2api'"],capture=True).strip()
    if not role: run(['runuser','-u','postgres','--','psql','-v','ON_ERROR_STOP=1'],data="CREATE ROLE sub2api LOGIN PASSWORD '"+s['dbPassword']+"';\n")
    db=run(['runuser','-u','postgres','--','psql','-Atqc',"SELECT 1 FROM pg_database WHERE datname='sub2api'"],capture=True).strip()
    if not db:run(['runuser','-u','postgres','--','createdb','-O','sub2api','sub2api'])
    env={'AUTO_SETUP':'true','DATA_DIR':'/opt/sub2api/data','SERVER_HOST':'127.0.0.1','SERVER_PORT':str(c['server']['apiPort']),
         'SERVER_MODE':'release','RUN_MODE':'standard','DATABASE_HOST':'127.0.0.1','DATABASE_PORT':'5432','DATABASE_USER':'sub2api',
         'DATABASE_PASSWORD':s['dbPassword'],'DATABASE_DBNAME':'sub2api','DATABASE_SSLMODE':'disable','DATABASE_MAX_OPEN_CONNS':'10',
         'DATABASE_MAX_IDLE_CONNS':'2','REDIS_HOST':'127.0.0.1','REDIS_PORT':'6379','REDIS_POOL_SIZE':'20','REDIS_MIN_IDLE_CONNS':'2',
         'ADMIN_EMAIL':s['sub2apiAdminEmail'],'ADMIN_PASSWORD':s['sub2apiAdminPassword'],'JWT_SECRET':s['jwt'],'TOTP_ENCRYPTION_KEY':s['totp'],
         'TZ':c['region']['ianaTimeZone'],'GOMEMLIMIT':'256MiB','GOMAXPROCS':'1','SECURITY_URL_ALLOWLIST_ALLOW_INSECURE_HTTP':'false','SECURITY_URL_ALLOWLIST_ALLOW_PRIVATE_HOSTS':'false'}
    envfile=pathlib.Path('/etc/sub2api.env');envfile.write_text(''.join(k+'='+v+'\n' for k,v in env.items()));envfile.chmod(0o600)
    run(['systemctl','stop','s-ui'],capture=True) if pathlib.Path('/etc/systemd/system/s-ui.service').exists() else None
    run(['/usr/local/s-ui/sui','admin','-username',s['suiUser'],'-password',s['suiPassword']],cwd='/usr/local/s-ui')
    with closing(sqlite3.connect('/usr/local/s-ui/db/s-ui.db')) as db, db:
        for k,v in {'webListen':'127.0.0.1','subListen':'127.0.0.1','webPort':str(c['server']['suiPort']),'subPort':str(c['server']['subPort']),
                    'timeLocation':c['region']['ianaTimeZone'],'sessionMaxAge':'120','trafficAge':'7'}.items():
            db.execute('DELETE FROM settings WHERE key=?',(k,));db.execute('INSERT INTO settings (key,value) VALUES (?,?)',(k,v))
    pathlib.Path('/etc/systemd/system/sub2api.service').write_text('''[Unit]
Description=CloudStack Sub2API
After=network-online.target postgresql.service redis-server.service
Wants=network-online.target postgresql.service redis-server.service
[Service]
User=sub2api
Group=sub2api
WorkingDirectory=/opt/sub2api
EnvironmentFile=/etc/sub2api.env
ExecStart=/opt/sub2api/sub2api
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/sub2api/data
LimitNOFILE=65536
[Install]
WantedBy=multi-user.target
''')
    shutil.copyfile('/usr/local/s-ui/s-ui.service','/etc/systemd/system/s-ui.service')
    drop=pathlib.Path('/etc/systemd/system/s-ui.service.d');drop.mkdir(exist_ok=True)
    (drop/'resource.conf').write_text('[Service]\nEnvironment=GOMEMLIMIT=128MiB\nEnvironment=GOMAXPROCS=1\nUMask=0077\n')
    run(['systemctl','daemon-reload']);run(['systemctl','enable','sub2api','s-ui']);run(['systemctl','restart','sub2api','s-ui'])
    for _ in range(60):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{c['server']['apiPort']}/health",timeout=3) as r:
                if json.load(r).get('status')=='ok':break
        except (OSError,ValueError):pass
        time.sleep(2)
    else:raise RuntimeError('Sub2API did not become healthy')
    configure_proxy(c,s)
    # Add SSH allow rule before enabling the firewall. Do not reset existing allow rules.
    for port,protocol in [(c['server']['sshPort'],'tcp'),(c['server']['proxyPort'],'tcp'),(c['server']['proxyPort'],'udp')]:run(['ufw','allow',f'{port}/{protocol}'])
    run(['ufw','default','deny','incoming']);run(['ufw','default','allow','outgoing']);run(['ufw','--force','enable'])
    ssh_access(c)
    install_backup(c)
    export(c,s); print('SERVER_READY: credentials exported to /var/lib/cloud-stack/client.json')

def install_backup(c):
    shutil.copyfile(HERE/'backup.py',STATE/'backup.py');(STATE/'backup.py').chmod(0o700)
    pathlib.Path('/etc/systemd/system/cloud-stack-backup.service').write_text('[Unit]\nDescription=CloudStack local backup\nAfter=postgresql.service\n[Service]\nType=oneshot\nUMask=0077\nExecStart=/usr/bin/python3 /var/lib/cloud-stack/backup.py\n')
    pathlib.Path('/etc/systemd/system/cloud-stack-backup.timer').write_text('[Unit]\nDescription=Daily CloudStack backup\n[Timer]\nOnCalendar=*-*-* 03:20:00 '+c['region']['ianaTimeZone']+'\nPersistent=true\nRandomizedDelaySec=120\n[Install]\nWantedBy=timers.target\n')
    run(['systemctl','daemon-reload']);run(['systemctl','enable','--now','cloud-stack-backup.timer'])

def read_legacy(c, source=pathlib.Path('/root/deployment/credentials.json'), dbpath=pathlib.Path('/usr/local/s-ui/db/s-ui.db'), envpath=pathlib.Path('/etc/sub2api.env')):
    """Read-only validation for the native deployment used before this kit. Never infer credentials."""
    old=json.loads(source.read_text())
    mapping={'sub2apiAdminEmail':'sub2api_email','sub2apiAdminPassword':'sub2api_password','suiUser':'sui_user','suiPassword':'sui_password',
             'dbPassword':'db_password','jwt':'jwt','totp':'totp','ssServerKey':'ss_server_key','ssUserKey':'ss_user_key','subscriptionId':'subscription_id'}
    s={k:old[v] for k,v in mapping.items()}
    for k,v in {'sub2apiApiKey':'sub2api_key','sub2apiKeyId':'sub2api_key_id','sub2apiGroupId':'sub2api_group_id'}.items():
        if v in old:s[k]=old[v]
    s.update(instanceId=c['instanceId'],serverAddress=c['server']['address'],legacyAdopted=True)
    if not dbpath.is_file():raise RuntimeError('Legacy S-UI database not found')
    with closing(sqlite3.connect(dbpath.as_uri()+'?mode=ro',uri=True)) as db:
        settings=dict(db.execute('SELECT key,value FROM settings'))
        expected={'webListen':'127.0.0.1','subListen':'127.0.0.1','webPort':str(c['server']['suiPort']),'subPort':str(c['server']['subPort'])}
        if any(settings.get(k)!=v for k,v in expected.items()):raise RuntimeError('Legacy panel ports/listen addresses do not match the supplied configuration')
        candidates=[]
        for row in db.execute('SELECT id,type,tag,options,out_json,addrs FROM inbounds'):
            options=json.loads(row[3]);out=json.loads(row[4]);addrs=json.loads(row[5] or '[]')
            address_matches=out.get('server')==c['server']['address'] or any(x.get('server')==c['server']['address'] and x.get('server_port')==c['server']['proxyPort'] for x in addrs)
            if row[1]=='shadowsocks' and options.get('listen_port')==c['server']['proxyPort'] and options.get('password')==s['ssServerKey'] and options.get('method')=='2022-blake3-aes-128-gcm' and address_matches:
                candidates.append((row[0],row[2]))
        if len(candidates)!=1:raise RuntimeError('Legacy proxy identity does not match uniquely; no adoption performed')
        inbound_id,s['inboundTag']=candidates[0]
        row=db.execute('SELECT config,inbounds FROM clients WHERE name=?',(s['subscriptionId'],)).fetchone()
        if not row or json.loads(row[0]).get('shadowsocks16',{}).get('password')!=s['ssUserKey'] or inbound_id not in json.loads(row[1]):
            raise RuntimeError('Legacy client key/subscription does not match the proxy')
    env=dict(line.split('=',1) for line in envpath.read_text().splitlines() if '=' in line and not line.startswith('#'))
    if env.get('SERVER_HOST')!='127.0.0.1' or env.get('SERVER_PORT')!=str(c['server']['apiPort']):raise RuntimeError('Legacy API listen address/port mismatch')
    return s

def adopt_legacy(c):
    if (STATE/'credentials.json').exists():raise RuntimeError('Deployment is already registered; use Attach instead of AttachLegacy')
    s=read_legacy(c)
    panel=Panel(c,s);panel.sui('login',{'user':s['suiUser'],'pass':s['suiPassword']})
    panel.api('/auth/login',{'email':s['sub2apiAdminEmail'],'password':s['sub2apiAdminPassword']})
    for service in ['sub2api','s-ui','postgresql','redis-server']:run(['systemctl','is-active','--quiet',service])
    STATE.mkdir(parents=True,exist_ok=True,mode=0o700);STATE.chmod(0o700)
    save(STATE/'credentials.json',s);save(STATE/'config.json',c)
    ssh_access(c);configure_proxy(c,s);install_backup(c);export(c,s)
    print('LEGACY_REGISTERED: existing nodes, account database and credentials preserved; use Attach on subsequent computers')

def main():
    p=argparse.ArgumentParser();p.add_argument('action',choices=['install','gateway','add-client','adopt-legacy','audit-legacy','check']);p.add_argument('--config',default=str(HERE/'deployment.json'));args=p.parse_args()
    os.umask(0o077)
    if os.geteuid()!=0:raise RuntimeError('Root is required')
    c=validate(json.loads(pathlib.Path(args.config).read_text(encoding='utf-8-sig')))
    if args.action=='install':install(c,json.loads((HERE/'releases.lock.json').read_text()));return 0
    if args.action=='audit-legacy':read_legacy(c);print('LEGACY_READ_ONLY_CHECK_OK');return 0
    if args.action=='adopt-legacy':adopt_legacy(c);return 0
    s=json.loads((STATE/'credentials.json').read_text())
    if s['instanceId']!=c['instanceId'] or s['serverAddress']!=c['server']['address']:raise RuntimeError('Deployment identity mismatch')
    if json.loads((STATE/'config.json').read_text())['server']!=c['server']:raise RuntimeError('Server port configuration differs from the deployed instance')
    if args.action=='gateway':return gateway(c,s)
    if args.action=='add-client':
        ssh_access(c);configure_proxy(c,s)
        if s.get('legacyAdopted'):install_backup(c)
        export(c,s);return 0
    for service in ['sub2api','s-ui','postgresql','redis-server']:run(['systemctl','is-active','--quiet',service])
    print('SERVER_SERVICES_OK');return 0

if __name__=='__main__':
    try:raise SystemExit(main())
    except (Exception,urllib.error.HTTPError) as e:
        # Never dump subprocess arguments, response bodies or credentials.
        print('ERROR:',str(e) if not isinstance(e,urllib.error.HTTPError) else f'Local panel HTTP {e.code}',flush=True);raise SystemExit(1)
