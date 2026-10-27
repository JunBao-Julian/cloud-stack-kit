const fs=require('node:fs'),path=require('node:path'),{render}=require('./config.cjs');
const root=path.resolve(__dirname,'..'),out=path.join(root,'test-output');fs.mkdirSync(out,{recursive:true});
const c=JSON.parse(fs.readFileSync(path.join(root,'config.example.json'),'utf8'));
for(const [name,aux]of [['main',false],['aux',true]])fs.writeFileSync(path.join(out,name+'.json'),JSON.stringify(render(c,{},aux),null,2));
const tun=render(c);tun.tun.enable=true;fs.writeFileSync(path.join(out,'tun.json'),JSON.stringify(tun,null,2));
