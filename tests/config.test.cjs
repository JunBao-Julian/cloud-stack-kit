const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),YAML=require('yaml');
const {validate,render,template,browsers}=require('../lib/config.cjs');const {installProfile}=require('../lib/client.cjs');
const example=()=>JSON.parse(fs.readFileSync(path.join(__dirname,'../config.example.json'),'utf8'));
test('example validates as a template but cannot deploy',()=>{assert.ok(validate(example()));assert.throws(()=>validate(example(),true))});
test('rejects ambiguous addresses, command injection, reserved ranges and colliding ports',()=>{
 for(const ip of ['example.com','8.8.8.8;id','127.0.0.1','100.64.1.1','198.19.1.1','224.0.0.1','255.255.255.255']){const c=example();c.server.address=ip;assert.throws(()=>validate(c,true),ip)}
 for(const id of ['../escape','name;whoami','UPPER']){const c=example();c.instanceId=id;assert.throws(()=>validate(c))}
 const c=example();c.local.apiPort=c.local.mainPort;assert.throws(()=>validate(c));
});
test('browser proxy precedes CN rules; nonbrowser CN destinations retain direct rules',()=>{
 const c=example(),p=render(c),i=p.rules.indexOf('RULE-SET,cloud_cn_domain,DIRECT');
 for(const b of browsers)assert.ok(p.rules.indexOf(`PROCESS-NAME,${b},CloudStack`)<i);
 assert.ok(p.rules.indexOf(`IP-CIDR,${c.server.address}/32,DIRECT,no-resolve`)<p.rules.indexOf('PROCESS-NAME,chrome.exe,CloudStack'));
 assert.equal(p.rules.at(-1),'MATCH,CloudStack');assert.deepEqual(p['proxy-groups'][0].proxies,['Personal--Cloud-'+c.instanceId]);
});
test('UDP, dual-stack capture, DNS and independent auxiliary route',()=>{
 const p=render(example()),aux=render(example(),{},true);
 assert.equal(p.ipv6,true);assert.equal(p.dns.ipv6,false);assert.equal(p.tun['strict-route'],true);
 assert.equal(p.proxies[0].udp,true);assert.ok(p.rules.some(x=>x.includes('DST-PORT,3478/5349/19302-19309')));
 assert.ok(!aux.rules.some(x=>x.startsWith('RULE-SET,')));assert.equal(aux.tun.enable,false);
 assert.ok(p.dns.nameserver.every(x=>x.endsWith('#CloudStack')));assert.ok(!p.dns['nameserver-policy']['rule-set:cloud_cn_domain']);
 const c=example();c.policy.browserMode='split';assert.ok(render(c).rules.includes('AND,((NETWORK,udp),(PROCESS-NAME,chrome.exe)),CloudStack'));
});
test('public subscription template contains no client keys',()=>{
 const t=template(example());assert.equal(t.proxies,undefined);assert.equal(t['proxy-groups'][0].filter,'.*');assert.ok(!JSON.stringify(t).includes('password'));
});
test('profile installation preserves unrelated profiles, is repeatable and enables strict TUN',()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cloud-stack-test-'));
 try{
  const root=path.join(tmp,'state'),clash=path.join(tmp,'clash');fs.mkdirSync(root);fs.mkdirSync(clash);fs.mkdirSync(path.join(root,'ruleset'));
  for(const name of ['cloud_cn_domain.mrs','cloud_cn_ip.mrs'])fs.writeFileSync(path.join(root,'ruleset',name),'fixture');
  fs.writeFileSync(path.join(root,'client.json'),JSON.stringify({subscriptionId:'TEST-PUBLIC-TOKEN'}));fs.writeFileSync(path.join(root,'proxy.json'),JSON.stringify(render(example())));
  fs.writeFileSync(path.join(clash,'profiles.yaml'),YAML.stringify({current:'other',items:[{uid:'other',type:'local',name:'Preserve',file:'other.yaml'}]}));
  fs.writeFileSync(path.join(clash,'config.yaml'),YAML.stringify({secret:'TEST-ONLY',mode:'global'}));
  installProfile(example(),root,clash);installProfile(example(),root,clash);
  const p=YAML.parse(fs.readFileSync(path.join(clash,'profiles.yaml'),'utf8')),b=YAML.parse(fs.readFileSync(path.join(clash,'config.yaml'),'utf8'));
  assert.equal(p.items.length,2);assert.equal(p.items[0].name,'Preserve');assert.equal(p.current,'cs-my-us-vps');assert.equal(b.secret,'TEST-ONLY');assert.equal(b.tun.enable,true);assert.equal(b.mode,'rule');
 }finally{fs.rmSync(tmp,{recursive:true,force:true})}
});
test('STUN parser validates transaction ID and decodes XOR IPv4',()=>{
 const {mapped}=require('../lib/stun.cjs');const id=Buffer.alloc(12,7),b=Buffer.alloc(32);b.writeUInt16BE(0x101);b.writeUInt16BE(12,2);b.writeUInt32BE(0x2112a442,4);id.copy(b,8);b.writeUInt16BE(0x20,20);b.writeUInt16BE(8,22);b[25]=1;
 [8,8,4,4].forEach((v,i)=>b[28+i]=v^b[4+i]);assert.equal(mapped(b,id),'8.8.4.4');assert.throws(()=>mapped(b,Buffer.alloc(12)));
});
