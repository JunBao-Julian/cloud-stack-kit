// Interactive guest enrollment. Never copies an owner's key or panel password to a guest.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),net=require('node:net'),crypto=require('node:crypto');
const readline=require('node:readline/promises');
const {validate}=require('./config.cjs');
const repo=path.resolve(__dirname,'..');
const win=process.platform==='win32';
const executable=name=>name+(win?'.exe':'');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
function run(file,args,options={}){
 const result=cp.spawnSync(file,args,{stdio:'inherit',windowsHide:true,...options});
 if(result.error||result.status!==0)throw Error(`${path.basename(file)} failed (${result.status??result.error?.code}); no success assumed`);
 return result.stdout;
}
function privateDir(dir){
 fs.mkdirSync(dir,{recursive:true,mode:0o700});
 if(win){const sid=run('whoami.exe',['/user','/fo','csv','/nh'],{stdio:'pipe',encoding:'utf8'}).match(/S-1-5-[0-9-]+/)?.[0];if(!sid)throw Error('Cannot identify current Windows user');run('icacls.exe',[dir,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`,'*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F'],{stdio:'pipe'});}
 else fs.chmodSync(dir,0o700);
}
function write(file,value){fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value,null,2),{mode:0o600});}
function baseDir(){return win?path.join(process.env.LOCALAPPDATA,'CloudStack'):path.join(os.homedir(),'Library','Application Support','CloudStack');}
function validateInvite(i){
 if(i.schemaVersion!==1||!/^[a-z][a-z0-9-]{1,18}$/.test(i.id)||i.username!=='csg-'+i.id||net.isIP(i.address)!==4||!Number.isInteger(i.sshPort)||i.sshPort<1||i.sshPort>65535||!Number.isSafeInteger(i.groupId)||i.groupId<1||i.keyFile!=='guest_key')throw Error('Invalid invitation');
 if(!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(i.hostPublicKey||''))throw Error('Invitation lacks a pinned SSH host key');
 const fp='SHA256:'+crypto.createHash('sha256').update(Buffer.from(i.hostPublicKey.split(' ')[1],'base64')).digest('base64').replace(/=+$/,'');
 if(fp!==i.hostFingerprint)throw Error('SSH host fingerprint mismatch in invitation');
 return i;
}
function configFor(i,s){
 validateInvite(i);
 if(s.kind!=='guest'||s.schemaVersion!==1||s.instanceId!=='guest-'+i.id||s.serverAddress!==i.address||s.server?.address!==i.address||s.server.sshPort!==i.sshPort||s.sshUser!==i.username||s.groupId!==i.groupId)throw Error('Export does not match this guest invitation');
 for(const key of ['ssServerKey','ssUserKey'])if(!/^[A-Za-z0-9+/]{22}==$/.test(s[key]||''))throw Error('Invalid SS2022 key');
 if(typeof s.sub2apiApiKey!=='string'||s.sub2apiApiKey.length<20||/[\r\n]/.test(s.sub2apiApiKey))throw Error('Invalid API key');
 for(const key of ['suiPassword','sub2apiAdminPassword','jwt','root_recovery_password'])if(key in s)throw Error('Refusing owner credentials in a guest export');
 const c=read(path.join(repo,'config.example.json'));
 c.instanceId=s.instanceId;c.server={...s.server,sshUser:s.sshUser};c.region.enabled=false;c.local.platform=process.platform;
 return validate(c,true);
}
function sshConfig(dir,i){
 const knownHost=i.sshPort===22?i.address:`[${i.address}]:${i.sshPort}`;
 write(path.join(dir,'known_hosts'),`${knownHost} ${i.hostPublicKey}\n`);
 const p=path.join(dir,'known_hosts').replace(/\\/g,'/');
 if(/["\r\n]/.test(p))throw Error('Unsupported path');
 write(path.join(dir,'ssh_config'),`Host *\n  UserKnownHostsFile "${p}"\n  IdentitiesOnly yes\n  StrictHostKeyChecking yes\n  HostKeyAlgorithms ssh-ed25519\n`);
}
function sshArgs(dir,i){return ['-F',path.join(dir,'ssh_config'),'-p',String(i.sshPort),'-i',path.join(dir,'tunnel_key'),'-o','BatchMode=yes','-o','ConnectTimeout=20',`${i.username}@${i.address}`];}
function download(url,file,sha,proxy){
 const args=['--fail','--show-error','--location','--retry','2','--connect-timeout','20','--max-time','600'];
 if(proxy)args.push('--proxy',proxy,'--noproxy','localhost,127.0.0.1');
 run(executable('curl'),[...args,url,'--output',file]);
 if(sha&&crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==sha)throw Error('Download checksum mismatch: '+path.basename(file));
}
function askInterface(){
 const rl=readline.createInterface({input:process.stdin,output:process.stdout});
 return {close:()=>rl.close(),ask:async(q,def='')=>{const v=(await rl.question(q+(def?` [${def}]`:'')+': ')).trim();return v||def;}};
}
async function invite(mode,details){
 let address,port,key,id;
 if(details){({address,port,key,id}=details);}else{
 const ui=askInterface();try{
  console.log('Owner only: create/revoke a restricted guest. Existing server services are reused.');
  address=await ui.ask('Server public IPv4');port=Number(await ui.ask('SSH port','22'));
  key=path.resolve((await ui.ask('Owner SSH private key path (root access; never sent to guest)')).replace(/^"|"$/g,''));
  id=await ui.ask('Guest ID, 2-19 lowercase letters/digits/hyphens');
 }finally{ui.close();}}
 if(net.isIP(address)!==4||!Number.isInteger(port)||port<1||port>65535||!/^[a-z][a-z0-9-]{1,18}$/.test(id)||!fs.statSync(key).isFile())throw Error('Invalid owner connection details');
 const dir=path.join(baseDir(),'Invitations',id);privateDir(dir);
 const guestKey=path.join(dir,'guest_key');
 if(mode!=='revoke'&&!fs.existsSync(guestKey))run(executable('ssh-keygen'),['-q','-t','ed25519','-N','','-C','cloud-guest-'+id,'-f',guestKey]);
 const publicKey=fs.readFileSync(guestKey+'.pub','utf8').trim();
 write(path.join(dir,'request.json'),{id,address,sshPort:port,publicKey});
 // OpenSSH owns interactive key passphrase entry; no password is read by this script.
 const known=path.join(dir,'owner_known_hosts');
 const args=['-p',String(port),'-i',key,'-o','IdentitiesOnly=yes','-o','ConnectTimeout=20','-o','ServerAliveInterval=20','-o','ServerAliveCountMax=3','-o','StrictHostKeyChecking=ask','-o',`UserKnownHostsFile=${known}`];
 const upload='/root/cloud-stack-guest-tools';
 run(executable('ssh'),[...args,`root@${address}`,`umask 077; mkdir -p ${upload}`]);
 const copy=['-P',String(port),'-i',key,'-o','IdentitiesOnly=yes','-o','ConnectTimeout=20','-o','StrictHostKeyChecking=yes','-o',`UserKnownHostsFile=${known}`];
 for(const name of ['server.py','guest.py'])run(executable('scp'),[...copy,path.join(repo,'server',name),`root@${address}:${upload}/${name}`]);
 run(executable('scp'),[...copy,path.join(dir,'request.json'),`root@${address}:${upload}/${id}.json`]);
 const output=run(executable('ssh'),[...args,`root@${address}`,`python3 ${upload}/guest.py ${mode==='revoke'?'revoke':'create'} ${upload}/${id}.json`],{stdio:['inherit','pipe','inherit'],encoding:'utf8'});
 const result=JSON.parse(output.trim());
 if(mode==='revoke'){console.log(`Guest ${id} revoked (SSH, proxy client and API key).`);return;}
 validateInvite(result);write(path.join(dir,'invitation.json'),result);
 write(path.join(dir,'READ-ME.txt'),`Give the friend ONLY invitation.json and guest_key, using a private channel.\nDo not send owner_known_hosts or other owner files.\nGuest: ${result.username}\nServer: ${address}:${port}\nHost key: ${result.hostFingerprint}\nUpstream group: Guest-${id} (ID ${result.groupId})\nOwner must attach ONLY this friend's authorized upstream to that group.\n`);
 console.log(`Guest prepared. Send these TWO private files:\n${path.join(dir,'invitation.json')}\n${guestKey}\nSeparate upstream group: Guest-${id} (ID ${result.groupId}). It has no upstream until the owner attaches one.\nSSH fingerprint: ${result.hostFingerprint}`);
}
async function freePort(preferred){
 for(let p=preferred;p<preferred+100;p++){
  const free=await new Promise(resolve=>{const s=net.createServer();s.once('error',()=>resolve(false));s.listen(p,'127.0.0.1',()=>s.close(()=>resolve(true)));});
  if(free)return p;
 }throw Error('No free local ports near '+preferred);
}
async function join(){
 if(!['win32','darwin'].includes(process.platform))throw Error('Guest joining supports Windows and macOS only');
 const ui=askInterface();let file;
 try{console.log('Enter the invitation supplied by your server owner. Keep guest_key beside it.');file=path.resolve((await ui.ask('Path to invitation.json')).replace(/^"|"$/g,''));}finally{ui.close();}
 const i=validateInvite(read(file)),sourceKey=path.join(path.dirname(file),i.keyFile);
 const dir=path.join(baseDir(),'guest-'+i.id);privateDir(dir);
 const key=path.join(dir,'tunnel_key');
 if(fs.existsSync(key)&&!fs.readFileSync(key).equals(fs.readFileSync(sourceKey)))throw Error('This guest ID has a different local SSH key. Use a different guest ID.');
 fs.copyFileSync(sourceKey,key);if(!win)fs.chmodSync(key,0o600);
 sshConfig(dir,i);
 const pub=run(executable('ssh-keygen'),['-y','-P','','-f',key],{stdio:'pipe',encoding:'utf8'}).trim();
 if(!pub.startsWith('ssh-ed25519 '))throw Error('Expected a dedicated Ed25519 guest key');
 const raw=run(executable('ssh'),[...sshArgs(dir,i),'cloud-stack-export'],{stdio:['ignore','pipe','inherit'],encoding:'utf8'});
 const s=JSON.parse(raw),c=configFor(i,s);
 const oldConfig=path.join(dir,'config.json');
 if(fs.existsSync(oldConfig)){const old=validate(read(oldConfig));c.local={...old.local,platform:process.platform};}
 else{
  for(const name of ['auxPort','auxDnsPort','apiPort','suiPort','subPort'])c.local[name]=await freePort(c.local[name]);
 }
 write(path.join(dir,'client.json'),s);write(oldConfig,c);
 if(win)require('./guest-windows.cjs').setup(c,dir);else await require('./guest-mac.cjs').setup(c,dir);
 console.log(`Client prepared: ${dir}\nClaude uses the server gateway. The owner must add your own authorized upstream to Guest-${i.id}.\nUse the generated Claude launcher; ordinary direct 'claude' commands keep their previous settings.`);
}
if(require.main===module)(async()=>{const mode=process.argv[2];if(mode==='join')await join();else if(['invite','revoke'].includes(mode))await invite(mode);else throw Error('Use join, invite or revoke');})().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={run,privateDir,write,read,baseDir,validateInvite,configFor,sshConfig,sshArgs,download,repo,freePort,invite};
