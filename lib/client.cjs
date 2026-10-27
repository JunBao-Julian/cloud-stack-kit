const fs=require('fs'),path=require('path'),cp=require('child_process'),crypto=require('crypto'),http=require('http'),YAML=require('yaml');
const {validate,render,template}=require('./config.cjs');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const write=(p,x)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(x,null,2));};
function api(clash,route){return new Promise((resolve,reject)=>{const c=YAML.parse(fs.readFileSync(path.join(clash,'config.yaml'),'utf8'));const req=http.get({socketPath:'\\\\.\\pipe\\verge-mihomo',path:route,headers:c.secret?{Authorization:'Bearer '+c.secret}:{}},res=>{let t='';res.on('data',d=>t+=d);res.on('end',()=>{if(res.statusCode!==200)return reject(new Error('Mihomo API HTTP '+res.statusCode));try{resolve(JSON.parse(t))}catch(e){reject(e)}})});req.setTimeout(5000,()=>req.destroy(new Error('Mihomo API timeout')));req.on('error',reject);});}
function installProfile(c,root,clash){
 const get=f=>{try{return YAML.parse(fs.readFileSync(path.join(clash,f),'utf8'))||{}}catch(e){if(e.code==='ENOENT')return {};throw e}};
 const p=get('profiles.yaml'),v=get('verge.yaml'),b=get('config.yaml'),uid='cs-'+c.instanceId;
 const cred=read(path.join(root,'client.json')),file=uid+'.yaml';p.items=p.items||[];
 const item=cred.kind==='guest'?{uid,type:'local',name:'CloudStack-'+c.instanceId,file,updated:Math.floor(Date.now()/1000)}:{uid,type:'remote',name:'CloudStack-'+c.instanceId,file,url:`http://127.0.0.1:${c.local.subPort}/sub/${cred.subscriptionId}?format=clash`,updated:Math.floor(Date.now()/1000),option:{update_interval:1440,with_proxy:false,self_proxy:false}};
 p.items=p.items.filter(x=>x.uid!==uid);p.items.push(item);p.current=uid;
 const cfg=read(path.join(root,'proxy.json'));Object.assign(b,{'mixed-port':c.local.mainPort,mode:'rule',ipv6:true,tun:{...cfg.tun,enable:true}});b.secret=b.secret||crypto.randomBytes(24).toString('hex');
 Object.assign(v,{enable_tun_mode:true,enable_system_proxy:true,enable_auto_launch:true,enable_proxy_guard:true,enable_dns_settings:false,auto_close_connection:false});
 fs.mkdirSync(path.join(clash,'profiles'),{recursive:true});fs.copyFileSync(path.join(root,'proxy.json'),path.join(clash,'profiles',file));
 fs.mkdirSync(path.join(clash,'ruleset'),{recursive:true});for(const f of ['cloud_cn_domain.mrs','cloud_cn_ip.mrs'])fs.copyFileSync(path.join(root,'ruleset',f),path.join(clash,'ruleset',f));
 for(const [name,data]of [['profiles.yaml',p],['verge.yaml',v],['config.yaml',b]])fs.writeFileSync(path.join(clash,name),YAML.stringify(data));
}
async function main(){
 const [mode,configPath,root,extra]=process.argv.slice(2);const c=validate(read(configPath),mode!=='validate');
 if(mode==='validate'||mode==='validate-deploy'){console.log('CONFIG_VALID');return;}
 if(mode==='server-config'){write(extra,{...c,clashTemplate:template(c)});return;}
 if(mode==='keygen'){if(!fs.existsSync(extra)){fs.mkdirSync(path.dirname(extra),{recursive:true});const p=cp.spawnSync('ssh-keygen.exe',['-q','-t','ed25519','-N','','-C','cloud-stack-'+c.instanceId,'-f',extra],{stdio:'inherit',windowsHide:true});if(p.status!==0)throw new Error('ssh-keygen failed');}return;}
 if(mode==='prepare'){
  const s=read(path.join(root,'client.json'));if(s.instanceId!==c.instanceId||s.serverAddress!==c.server.address)throw new Error('Client credentials belong to another deployment');
  write(path.join(root,'proxy.json'),render(c,s));write(path.join(root,'aux.json'),render(c,s,true));
  if(s.sub2apiApiKey)write(path.join(root,'claude-settings.json'),{env:{ANTHROPIC_BASE_URL:`http://127.0.0.1:${c.local.apiPort}`,ANTHROPIC_AUTH_TOKEN:s.sub2apiApiKey,CLAUDE_CONFIG_DIR:path.join(root,'ClaudeCode'),HTTP_PROXY:`http://127.0.0.1:${c.local.auxPort}`,HTTPS_PROXY:`http://127.0.0.1:${c.local.auxPort}`,NO_PROXY:'127.0.0.1,localhost,::1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}});
  if(s.kind!=='guest')fs.writeFileSync(path.join(root,'panel-login.txt'),`Sub2API: http://127.0.0.1:${c.local.apiPort}\nEmail: ${s.sub2apiAdminEmail}\nPassword: ${s.sub2apiAdminPassword}\nS-UI: http://127.0.0.1:${c.local.suiPort}/app/\nUser: ${s.suiUser}\nPassword: ${s.suiPassword}\n`);
  const pref=path.join(root,'EdgeProfile','Default','Preferences');if(!fs.existsSync(pref))write(pref,{intl:{accept_languages:c.region.culture+',en',selected_languages:c.region.culture+',en'}});
  console.log('CLIENT_CONFIG_PREPARED');return;
 }
 if(mode==='activate'){installProfile(c,root,extra);console.log('CLASH_PROFILE_SAVED');return;}
 if(mode==='check-core'){
  const live=await api(extra,'/configs');if(!live.tun?.enable||!live.ipv6||!live.tun['strict-route'])throw new Error('Dual-stack strict TUN is not active');
  const rules=(await api(extra,'/rules')).rules||[];const processRules=rules.filter(x=>x.type==='ProcessName'&&x.proxy==='CloudStack');if(c.policy.browserMode==='proxy'&&processRules.length<7)throw new Error('Browser process rules not active');
  console.log(JSON.stringify({tun:true,ipv6:true,browserMode:c.policy.browserMode,processRules:processRules.length}));return;
 }
 throw new Error('Unknown client operation');
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1});
module.exports={installProfile};
