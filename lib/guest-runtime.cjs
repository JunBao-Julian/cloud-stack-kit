// Persistent launchers use only Node built-ins, so deleting the downloaded kit is safe.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),http=require('node:http');
function health(port){return new Promise((resolve,reject)=>{const r=http.get(`http://127.0.0.1:${port}/health`,res=>{let body='';res.on('data',d=>body+=d);res.on('end',()=>{try{if(res.statusCode!==200||JSON.parse(body).status!=='ok')throw Error();resolve();}catch{reject(Error('Gateway health check failed'));}});});r.setTimeout(5000,()=>r.destroy(Error('Gateway timeout')));r.on('error',reject);});}
async function main(){
 const [mode,dir,...args]=process.argv.slice(2),r=JSON.parse(fs.readFileSync(path.join(dir,'runtime.json'),'utf8'));
 if(mode==='recover'){
  const domain=`gui/${process.getuid()}`;
  for(const label of r.labels){const file=path.join(os.homedir(),'Library/LaunchAgents',label+'.plist');const result=cp.spawnSync('launchctl',['print',`${domain}/${label}`],{stdio:'ignore'});if(result.status!==0)cp.spawnSync('launchctl',['bootstrap',domain,file],{stdio:'inherit'});}
  const p=cp.spawnSync('open',['-a',r.clashApp],{stdio:'inherit'});if(p.status!==0)throw Error('Could not open Clash');
  console.log('Reconnect jobs and Clash started.');return;
 }
 if(mode!=='claude')throw Error('Unknown launcher');
 await health(r.config.local.apiPort);
 const settings=path.join(dir,'claude-settings.json');const env={...process.env};
 delete env.ANTHROPIC_API_KEY;delete env.CLAUDE_CODE_OAUTH_TOKEN;
 Object.assign(env,JSON.parse(fs.readFileSync(settings,'utf8')).env);
 const cli=path.join(os.homedir(),'.local/bin/claude');
 if(!fs.existsSync(cli))throw Error('Claude Code is missing. Rerun the guest setup to install it.');
 const p=cp.spawnSync(cli,['--settings',settings,...args],{stdio:'inherit',env,cwd:process.cwd()});
 if(p.error)throw p.error;process.exitCode=p.status??1;
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={health};
