const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),http=require('node:http'),crypto=require('node:crypto'),YAML=require('yaml');
const {run,write,read,download,repo}=require('./guest.cjs');
const {render}=require('./config.cjs');
const {installProfile}=require('./client.cjs');
const {health}=require('./guest-runtime.cjs');
const app='/Applications/Clash Verge.app';
const clashDir=()=>path.join(os.homedir(),'Library/Application Support/io.github.clash-verge-rev.clash-verge-rev');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const quote=s=>"'"+s.replace(/'/g,"'\\''")+"'";
const xml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
function plist(label,args,dir,keepAlive=true){
 return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array>${args.map(x=>`<string>${xml(x)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><${keepAlive?'true':'false'}/><key>ThrottleInterval</key><integer>10</integer><key>ProcessType</key><string>Background</string><key>StandardOutPath</key><string>${xml(path.join(dir,label+'.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(dir,label+'.error.log'))}</string></dict></plist>\n`;
}
function loadJob(label,args,dir,keepAlive=true){
 const folder=path.join(os.homedir(),'Library/LaunchAgents');fs.mkdirSync(folder,{recursive:true});
 const file=path.join(folder,label+'.plist');write(file,plist(label,args,dir,keepAlive));
 run('/usr/bin/plutil',['-lint',file]);
 const domain=`gui/${process.getuid()}`;
 cp.spawnSync('/bin/launchctl',['bootout',`${domain}/${label}`],{stdio:'ignore'});
 run('/bin/launchctl',['bootstrap',domain,file]);
}
function exitIP(port){return run('/usr/bin/curl',['--fail','--silent','--show-error','--max-time','12','--proxy',`http://127.0.0.1:${port}`,'--noproxy','localhost,127.0.0.1','https://api.ipify.org'],{stdio:'pipe',encoding:'utf8'}).trim();}
async function retry(fn,n=20){let error;for(let i=0;i<n;i++){try{return await fn();}catch(e){error=e;await pause(1500);}}throw error;}
function api(route){
 const config=YAML.parse(fs.readFileSync(path.join(clashDir(),'config.yaml'),'utf8'));
 const socket=config['external-controller-unix']||'/tmp/verge/verge-mihomo.sock';
 return new Promise((resolve,reject)=>{const req=http.get({socketPath:socket,path:route,headers:{Authorization:'Bearer '+config.secret}},res=>{let t='';res.on('data',x=>t+=x);res.on('end',()=>{try{if(res.statusCode!==200)throw Error('Mihomo API not ready');resolve(JSON.parse(t));}catch(e){reject(e);}});});req.setTimeout(4000,()=>req.destroy(Error('Mihomo API timeout')));req.on('error',reject);});
}
function dnsSnapshot(){
 const services=run('/usr/sbin/networksetup',['-listallnetworkservices'],{stdio:'pipe',encoding:'utf8'}).trim().split(/\r?\n/).slice(1).filter(x=>x&&!x.startsWith('*'));
 return services.map(service=>{const text=run('/usr/sbin/networksetup',['-getdnsservers',service],{stdio:'pipe',encoding:'utf8'}).trim();const addresses=text.split(/\r?\n/).filter(x=>require('node:net').isIP(x));return {service,addresses};});
}
async function quitClash(){
 const binary=path.join(app,'Contents/MacOS/clash-verge');
 const list=()=>cp.spawnSync('/usr/bin/pgrep',['-f',binary.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')],{encoding:'utf8'}).stdout.trim();
 if(!list())return;
 run('/usr/bin/osascript',['-e','tell application "Clash Verge" to quit']);
 await retry(()=>{if(list())throw Error('Clash has not exited; close it and retry');},10);
}
async function rollback(dir){
 const snapshot=read(path.join(dir,'mac-rollback.json'));
 if(!/^rollback-[a-f0-9]{32}$/.test(snapshot.folder))throw Error('Invalid rollback directory');
 const allowed=['profiles.yaml','verge.yaml','config.yaml','clash-verge.yaml',`profiles/cs-${read(path.join(dir,'config.json')).instanceId}.yaml`];
 for(const item of snapshot.files)if(!allowed.includes(item.name)||!/^file-\d+\.bak$/.test(item.backup))throw Error('Invalid rollback file');
 await quitClash();
 for(const item of snapshot.files){const dest=path.join(clashDir(),item.name);if(item.exists){fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(dir,snapshot.folder,item.backup),dest);}else if(fs.existsSync(dest))fs.unlinkSync(dest);}
 run('/usr/bin/sudo',['-v']);
 for(const item of snapshot.dns)run('/usr/bin/sudo',['/usr/sbin/networksetup','-setdnsservers',item.service,...(item.addresses.length?item.addresses:['Empty'])]);
 const label='local.cloudstack.'+read(path.join(dir,'config.json')).instanceId+'.clash';
 cp.spawnSync('/bin/launchctl',['bootout',`gui/${process.getuid()}/${label}`],{stdio:'ignore'});
 const job=path.join(os.homedir(),'Library/LaunchAgents',label+'.plist');if(fs.existsSync(job))fs.unlinkSync(job);
 if(snapshot.hadClash)run('/usr/bin/open',['-a',app]);
 console.log('Previous Clash files and DNS restored. Auxiliary proxy and SSH remain for recovery.');
}
async function setup(c,dir){
 if(Number(os.release().split('.')[0])<22)throw Error('Claude Code requires macOS 13 or later');
 const installed=fs.existsSync(app),arm=process.arch==='arm64';
 if(!installed){
  const name=`Clash.Verge_2.4.7_${arm?'aarch64':'x64'}.dmg`,dmg=path.join(dir,name);
  download(`https://github.com/clash-verge-rev/clash-verge-rev/releases/download/v2.4.7/${name}`,dmg,arm?'b4967eeefccc9688c100810fdfefa99147030c23949d1f278d5a5536aa86abf3':'89b32dd2aec2bccad52507ccc994cbdf67335a29de6ff794ebe844eb7c387792');
  const mount=path.join(dir,'mount-'+crypto.randomBytes(8).toString('hex'));fs.mkdirSync(mount);
  run('/usr/bin/hdiutil',['attach','-nobrowse','-readonly','-mountpoint',mount,dmg]);
  try{run('/usr/bin/sudo',['/usr/bin/ditto',path.join(mount,'Clash Verge.app'),app]);}finally{run('/usr/bin/hdiutil',['detach',mount]);}
 }
 const core=path.join(app,'Contents/MacOS/verge-mihomo');
 const installer=path.join(app,'Contents/Resources/resources/clash-verge-service-install');
 if(!fs.existsSync(core)||!fs.existsSync(installer))throw Error('Unsupported Clash application layout');
 c.local.clashExe=path.join(app,'Contents/MacOS/clash-verge');write(path.join(dir,'config.json'),c);
 const s=read(path.join(dir,'client.json'));write(path.join(dir,'proxy.json'),render(c,s));write(path.join(dir,'aux.json'),render(c,s,true));
 run(process.execPath,[path.join(repo,'lib/client.cjs'),'prepare',path.join(dir,'config.json'),dir]);
 run(core,['-t','-d',dir,'-f',path.join(dir,'aux.json')]);
 const labels=['tunnel','aux','clash'].map(x=>'local.cloudstack.'+c.instanceId+'.'+x);
 const bin=path.join(dir,'bin');fs.mkdirSync(bin,{recursive:true});const node=path.join(bin,'node');fs.copyFileSync(process.execPath,node);fs.chmodSync(node,0o700);
 // Runtime libraries are private copies, independent of the downloaded source folder.
 const kit=path.join(dir,'Kit');fs.mkdirSync(kit,{recursive:true});
 for(const name of ['guest-runtime.cjs','guest-mac.cjs','guest.cjs','config.cjs','client.cjs','stun.cjs']){fs.mkdirSync(path.join(kit,'lib'),{recursive:true});fs.copyFileSync(path.join(repo,'lib',name),path.join(kit,'lib',name));}
 fs.copyFileSync(path.join(repo,'config.example.json'),path.join(kit,'config.example.json'));
 fs.cpSync(path.join(repo,'node_modules/yaml'),path.join(kit,'node_modules/yaml'),{recursive:true});
 write(path.join(dir,'runtime.json'),{config:c,clashApp:app,coreExe:core,labels});
 loadJob(labels[0],['/usr/bin/ssh','-N','-T','-F',path.join(dir,'ssh_config'),'-i',path.join(dir,'tunnel_key'),'-p',String(c.server.sshPort),'-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=15','-o','ServerAliveInterval=20','-o','ServerAliveCountMax=3','-L',`127.0.0.1:${c.local.apiPort}:127.0.0.1:${c.server.apiPort}`,`${c.server.sshUser}@${c.server.address}`],dir);
 loadJob(labels[1],[core,'-d',dir,'-f',path.join(dir,'aux.json')],dir);
 await retry(()=>{if(exitIP(c.local.auxPort)!==c.server.address)throw Error('Auxiliary proxy egress differs from server');});await retry(()=>health(c.local.apiPort));
 const proxy=`http://127.0.0.1:${c.local.auxPort}`;
 fs.mkdirSync(path.join(dir,'ruleset'),{recursive:true});
 for(const [name,source]of [['cloud_cn_domain','geosite'],['cloud_cn_ip','geoip']])download(`https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/${source}/cn.mrs`,path.join(dir,'ruleset',name+'.mrs'),null,proxy);
 run(core,['-t','-d',dir,'-f',path.join(dir,'proxy.json')]);
 if(!fs.existsSync(path.join(os.homedir(),'.local/bin/claude'))){const file=path.join(dir,'install-claude.sh');download('https://claude.ai/install.sh',file,null,proxy);run('/bin/bash',[file,'stable'],{env:{...process.env,HTTP_PROXY:proxy,HTTPS_PROXY:proxy,NO_PROXY:'localhost,127.0.0.1,::1'}});if(!fs.existsSync(path.join(os.homedir(),'.local/bin/claude')))throw Error('Claude installer did not finish');}
 const desktop=path.join(os.homedir(),'Desktop');fs.mkdirSync(desktop,{recursive:true});
 for(const mode of ['Claude','Recover','Rollback']){
  const file=path.join(desktop,'CloudStack-'+mode+'.command');
  const lib=mode==='Rollback'?'guest-mac.cjs':'guest-runtime.cjs';
  write(file,`#!/bin/bash\ncd "$HOME"\nexec ${quote(node)} ${quote(path.join(kit,'lib',lib))} ${mode.toLowerCase()} ${quote(dir)} "$@"\n`);fs.chmodSync(file,0o700);
 }
 const folder='rollback-'+crypto.randomBytes(16).toString('hex'),backup=path.join(dir,folder);fs.mkdirSync(backup,{mode:0o700});
 const snapshot={folder,hadClash:installed,dns:dnsSnapshot(),files:[]};
 await quitClash();
 fs.mkdirSync(clashDir(),{recursive:true});
 for(const [n,name]of ['profiles.yaml','verge.yaml','config.yaml','clash-verge.yaml',`profiles/cs-${c.instanceId}.yaml`].entries()){
  const src=path.join(clashDir(),name),exists=fs.existsSync(src),file=`file-${n}.bak`;
  if(exists)fs.copyFileSync(src,path.join(backup,file));snapshot.files.push({name,exists,backup:file});
 }
 write(path.join(dir,'mac-rollback.json'),snapshot);
 try{
  // Official installer needs the logged-in user's group for service IPC permissions.
  run('/usr/bin/sudo',['/usr/bin/env',`CLASH_VERGE_SERVICE_GID=${process.getgid()}`,installer]);
  installProfile(c,dir,clashDir());
  const vf=path.join(clashDir(),'verge.yaml'),v=YAML.parse(fs.readFileSync(vf,'utf8'));
  // TUN carries all applications. Do not overwrite existing macOS proxy credentials.
  v.enable_system_proxy=false;v.enable_proxy_guard=false;v.enable_auto_launch=false;write(vf,YAML.stringify(v));
  run('/usr/bin/open',['-a',app]);
  await retry(async()=>{const active=await api('/configs');if(!active.tun?.enable||!active.ipv6)throw Error('Dual-stack TUN not active; approve Clash in macOS if requested');if(exitIP(c.local.mainPort)!==c.server.address)throw Error('Main proxy egress mismatch');});
  // macOS cannot intercept LAN DNS. Public resolvers are caught by the TUN DNS rule.
  for(const item of snapshot.dns)run('/usr/bin/sudo',['/usr/sbin/networksetup','-setdnsservers',item.service,'1.1.1.1','8.8.8.8']);
  run(node,[path.join(kit,'lib/stun.cjs'),c.server.address]);
  loadJob(labels[2],['/usr/bin/open','-a',app],dir,false);
 }catch(error){try{await rollback(dir);}catch(e){console.error('Rollback needs attention: '+e.message);}throw error;}
 console.log('macOS TUN, TCP egress, native UDP and API tunnel verified. Desktop launchers created.');
}
if(require.main===module){if(process.argv[2]!=='rollback')throw Error('Use rollback only');rollback(process.argv[3]).catch(e=>{console.error(e.message);process.exitCode=1;});}
module.exports={setup,rollback,plist,quote};
