const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),cp=require('node:child_process'),YAML=require('yaml');
const {validateInvite,configFor,sshConfig,sshArgs}=require('../lib/guest.cjs');
const {plist,quote}=require('../lib/guest-mac.cjs');
const {render,macBrowsers}=require('../lib/config.cjs');
const {installProfile}=require('../lib/client.cjs');
function fixtures(){
 const data=Buffer.concat([Buffer.from('0000000b7373682d6564323535313900000020','hex'),Buffer.alloc(32,7)]);
 const i={schemaVersion:1,id:'alice',address:'8.8.4.4',sshPort:2222,username:'csg-alice',keyFile:'guest_key',hostPublicKey:'ssh-ed25519 '+data.toString('base64'),hostFingerprint:'SHA256:'+crypto.createHash('sha256').update(data).digest('base64').replace(/=+$/,''),groupId:42};
 const s={kind:'guest',schemaVersion:1,instanceId:'guest-alice',serverAddress:i.address,server:{address:i.address,sshPort:2222,proxyPort:24443,apiPort:8080,suiPort:2095,subPort:2096},sshUser:i.username,ssServerKey:Buffer.alloc(16,1).toString('base64'),ssUserKey:Buffer.alloc(16,2).toString('base64'),sub2apiApiKey:'fixture-only-guest-api-value',groupId:42};
 return {i,s};
}
test('guest invitation rejects traversal, root access, substituted host keys and nonliteral hosts',()=>{
 const {i}=fixtures();assert.equal(validateInvite(i),i);
 for(const patch of [{id:'../../root'},{username:'root'},{sshPort:22.5},{address:'vps;id'},{hostFingerprint:'SHA256:wrong'},{keyFile:'../owner_key'}])assert.throws(()=>validateInvite({...i,...patch}));
});
test('guest export binds server, identity and group and rejects owner secrets',()=>{
 const {i,s}=fixtures();const c=configFor(i,s);assert.equal(c.region.enabled,false);assert.equal(c.server.sshUser,'csg-alice');
 for(const patch of [{groupId:3},{sshUser:'root'},{serverAddress:'1.1.1.1'},{suiPassword:'do-not-export'},{ssUserKey:'bad'}])assert.throws(()=>configFor(i,{...s,...patch}));
});
test('SSH host pinning and guest arguments cannot silently accept another server',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guest-ssh-'));
 try{const {i}=fixtures();sshConfig(dir,i);assert.match(fs.readFileSync(path.join(dir,'known_hosts'),'utf8'),/^\[8\.8\.4\.4\]:2222 ssh-ed25519 /);assert.match(fs.readFileSync(path.join(dir,'ssh_config'),'utf8'),/StrictHostKeyChecking yes/);const args=sshArgs(dir,i);assert.equal(args.at(-1),'csg-alice@8.8.4.4');assert.ok(args.includes('BatchMode=yes'));}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Mac browser rules precede CN direct rules; STUN and IPv6 retain coverage',()=>{
 const {i,s}=fixtures(),c=configFor(i,s);c.local.platform='darwin';const p=render(c,s),cn=p.rules.indexOf('RULE-SET,cloud_cn_domain,DIRECT');
 for(const b of macBrowsers)assert.ok(p.rules.indexOf(`PROCESS-NAME,${b},CloudStack`)<cn);
 assert.equal(p.proxies[0].udp,true);assert.equal(p.ipv6,true);assert.ok(p.tun['inet6-address'].length);assert.equal(p.dns.ipv6,false);
});
test('guest installation preserves unrelated profiles and creates no admin subscription',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guest-profile-'));
 try{
  const {i,s}=fixtures(),c=configFor(i,s),root=path.join(dir,'state'),clash=path.join(dir,'clash');fs.mkdirSync(root);fs.mkdirSync(clash);fs.mkdirSync(path.join(root,'ruleset'));
  fs.writeFileSync(path.join(root,'client.json'),JSON.stringify(s));fs.writeFileSync(path.join(root,'proxy.json'),JSON.stringify(render(c,s)));
  for(const name of ['cloud_cn_domain','cloud_cn_ip'])fs.writeFileSync(path.join(root,'ruleset',name+'.mrs'),'fixture');
  fs.writeFileSync(path.join(clash,'profiles.yaml'),YAML.stringify({current:'other',items:[{uid:'other',type:'local',file:'other.yaml'}]}));
  installProfile(c,root,clash);installProfile(c,root,clash);
  const profiles=YAML.parse(fs.readFileSync(path.join(clash,'profiles.yaml'),'utf8'));assert.equal(profiles.items.length,2);assert.equal(profiles.items[1].type,'local');assert.equal(profiles.items[1].url,undefined);
  const config=path.join(root,'config.json');fs.writeFileSync(config,JSON.stringify(c));
  const result=cp.spawnSync(process.execPath,[path.join(__dirname,'../lib/client.cjs'),'prepare',config,root],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.equal(fs.existsSync(path.join(root,'panel-login.txt')),false);
  const settings=JSON.parse(fs.readFileSync(path.join(root,'claude-settings.json'),'utf8'));assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN,s.sub2apiApiKey);assert.match(settings.env.CLAUDE_CONFIG_DIR,/ClaudeCode$/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('launchd XML escapes user paths; KeepAlive only for persistent helpers',()=>{
 const text=plist('local.cloudstack.test',['/usr/bin/ssh','/Users/a & b/guest<key>'],"/tmp/a'&b");
 assert.ok(text.includes('a &amp; b'));assert.ok(text.includes('guest&lt;key&gt;'));assert.ok(text.includes('<key>KeepAlive</key><true/>'));
 assert.ok(plist('open',['/usr/bin/open','-a','Clash Verge.app'],'/tmp',false).includes('<key>KeepAlive</key><false/>'));
 assert.equal(quote("a'b"),"'a'\\''b'");
 if(process.platform==='darwin'){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guest-plist-'));try{const f=path.join(dir,'test.plist');fs.writeFileSync(f,text);assert.equal(cp.spawnSync('/usr/bin/plutil',['-lint',f]).status,0);}finally{fs.rmSync(dir,{recursive:true,force:true});}
 }
});
module.exports={fixtures};
