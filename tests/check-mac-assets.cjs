// CI-only: inspect the real upstream DMG and parse a Mac TUN config without enabling it.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {download,run,repo}=require('../lib/guest.cjs');
const {render}=require('../lib/config.cjs');
if(process.platform!=='darwin')throw Error('This asset check requires macOS');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cloudstack-mac-assets-'));
const mount=path.join(dir,'mount');fs.mkdirSync(mount);
let mounted=false;
try{
 const arm=process.arch==='arm64',name=`Clash.Verge_2.4.7_${arm?'aarch64':'x64'}.dmg`,file=path.join(dir,name);
 download(`https://github.com/clash-verge-rev/clash-verge-rev/releases/download/v2.4.7/${name}`,file,arm?'b4967eeefccc9688c100810fdfefa99147030c23949d1f278d5a5536aa86abf3':'89b32dd2aec2bccad52507ccc994cbdf67335a29de6ff794ebe844eb7c387792');
 run('/usr/bin/hdiutil',['attach','-nobrowse','-readonly','-mountpoint',mount,file]);mounted=true;
 const app=path.join(mount,'Clash Verge.app'),core=path.join(app,'Contents/MacOS/verge-mihomo');
 for(const rel of ['Contents/MacOS/clash-verge','Contents/MacOS/verge-mihomo','Contents/Resources/resources/clash-verge-service-install'])if(!fs.existsSync(path.join(app,rel)))throw Error('Unexpected macOS app layout: '+rel);
 const c=JSON.parse(fs.readFileSync(path.join(repo,'config.example.json'),'utf8'));c.local.platform='darwin';
 const config=render(c);config.tun.enable=true;
 fs.mkdirSync(path.join(dir,'ruleset'));
 for(const [name,source]of [['cloud_cn_domain','geosite'],['cloud_cn_ip','geoip']])download(`https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/${source}/cn.mrs`,path.join(dir,'ruleset',name+'.mrs'));
 const p=path.join(dir,'mac-tun.json');fs.writeFileSync(p,JSON.stringify(config));run(core,['-t','-d',dir,'-f',p]);
 console.log('MAC_ASSET_LAYOUT_AND_CONFIG_VALID (TUN not activated)');
}finally{
 if(mounted)run('/usr/bin/hdiutil',['detach',mount]);
 fs.rmSync(dir,{recursive:true,force:true});
}
