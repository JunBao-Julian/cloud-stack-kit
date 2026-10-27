const fs=require('node:fs'),path=require('node:path');
const {run,download,repo}=require('./guest.cjs');
function setup(c,dir){
 const arm=process.arch==='arm64',name=`Clash.Verge_2.4.7_${arm?'arm64':'x64'}-setup.exe`;
 const installer=path.join(dir,name);
 download(`https://github.com/clash-verge-rev/clash-verge-rev/releases/download/v2.4.7/${name}`,installer,arm?'7f522be46e6abae89a4905ba4914ad7a9d08a8b07c7c97ee45c6607f0abd02e5':'6642881b212bcd4766e81d56aec7497063ba5198c287f7d00a2ecf13b6f8b61a');
 // Keep a small, complete runtime for recovery even if the downloaded ZIP is removed.
 const kit=path.join(dir,'Kit');fs.mkdirSync(kit,{recursive:true});
 for(const rel of ['Setup.ps1','lib/client.cjs','lib/config.cjs','windows/Common.ps1','windows/Watch.ps1','windows/Launch.ps1','windows/Guest-Activate.ps1']){
  const target=path.join(kit,rel);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(repo,rel),target);
 }
 fs.cpSync(path.join(repo,'node_modules/yaml'),path.join(kit,'node_modules/yaml'),{recursive:true});
 fs.mkdirSync(path.join(dir,'bin'),{recursive:true});fs.copyFileSync(process.execPath,path.join(dir,'bin/node.exe'));
 run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(repo,'windows/Guest-Client.ps1'),'-StateDir',dir,'-Installer',installer]);
}
module.exports={setup};
