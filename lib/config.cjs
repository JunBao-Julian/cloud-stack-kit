const net=require('net');
const browsers=['msedge.exe','chrome.exe','firefox.exe','brave.exe','opera.exe','vivaldi.exe','Arc.exe'];
const macBrowsers=['Safari','com.apple.WebKit.Networking','Google Chrome','Google Chrome Helper','Microsoft Edge','Microsoft Edge Helper','Firefox','firefox','Brave Browser','Brave Browser Helper','Arc','Arc Helper','Opera','Opera Helper','Vivaldi','Vivaldi Helper'];
function validate(c,deploy=false){
 if(c.schemaVersion!==1||!/^[a-z][a-z0-9-]{1,24}$/.test(c.instanceId||''))throw new Error('Invalid schemaVersion or instanceId');
 if(net.isIP(c.server?.address)!==4)throw new Error('server.address must be a literal public IPv4 address');
 const [a,b]=c.server.address.split('.').map(Number);
 if(deploy&&(a>=224||(a===100&&b>=64&&b<=127)||(a===198&&[18,19].includes(b))||/^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|192\.0\.0\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(c.server.address)))throw new Error('Replace the example/private server address before deployment');
 for(const [section,names]of [[c.server,['sshPort','proxyPort','apiPort','suiPort','subPort']],[c.local,['mainPort','auxPort','dnsPort','auxDnsPort','apiPort','suiPort','subPort']]]){
  const values=names.map(k=>section?.[k]);if(values.some(p=>!Number.isInteger(p)||p<1||p>65535)||new Set(values).size!==values.length)throw new Error('Ports must be distinct integers from 1 to 65535 within each machine');
 }
 if(!['proxy','split'].includes(c.policy?.browserMode))throw new Error('browserMode must be proxy or split');
 if(typeof c.region?.enabled!=='boolean'||typeof c.local.autoStart!=='boolean')throw new Error('region.enabled and local.autoStart must be booleans');
 if(typeof c.local.clashExe!=='string'||/["\r\n]/.test(c.local.clashExe))throw new Error('Invalid Clash executable path');
 if(c.server.apiPort<1024||['proxyPort','apiPort','suiPort','subPort'].some(k=>[5432,6379].includes(c.server[k])))throw new Error('Application ports must not conflict with PostgreSQL/Redis; API port must be >=1024');
 if(!/^[A-Za-z_]+\/[A-Za-z0-9_+\-/]+$/.test(c.region?.ianaTimeZone||''))throw new Error('Invalid IANA time zone');
 if(!/^[A-Za-z][A-Za-z0-9 -]+$/.test(c.region.windowsTimeZone)||!/^[a-z]{2,3}-[A-Z]{2}$/.test(c.region.culture)||!Number.isInteger(c.region.geoId))throw new Error('Invalid Windows region settings');
 if(c.bootstrapProxy){const u=new URL(c.bootstrapProxy);if(!['http:','https:','socks5:','socks5h:'].includes(u.protocol)||u.username||u.password)throw new Error('bootstrapProxy must not contain credentials');}
 return c;
}
function render(c,secret={},aux=false){
 validate(c);const group='CloudStack',node='Personal--Cloud-'+c.instanceId;
 const local=['DOMAIN,localhost,DIRECT','DOMAIN-SUFFIX,lan,DIRECT','DOMAIN-SUFFIX,local,DIRECT',`IP-CIDR,${c.server.address}/32,DIRECT,no-resolve`,...['127.0.0.0/8','10.0.0.0/8','172.16.0.0/12','192.168.0.0/16','169.254.0.0/16','224.0.0.0/4'].map(x=>`IP-CIDR,${x},DIRECT,no-resolve`),...['::1/128','fc00::/7','fe80::/10','ff00::/8'].map(x=>`IP-CIDR6,${x},DIRECT,no-resolve`)];
 const foreign=['https://1.1.1.1/dns-query#CloudStack','https://8.8.8.8/dns-query#CloudStack'];
 const cn=['https://dns.alidns.com/dns-query#DIRECT','https://doh.pub/dns-query#DIRECT'];
 const rules=[...local,'AND,((NETWORK,udp),(DST-PORT,3478/5349/19302-19309)),CloudStack'];
 for(const n of [...browsers,...(c.local.platform==='darwin'?macBrowsers:[])])rules.push(c.policy.browserMode==='proxy'?`PROCESS-NAME,${n},${group}`:`AND,((NETWORK,udp),(PROCESS-NAME,${n})),${group}`);
 const protectedDomains=['anthropic.com','claude.ai','claude.com','claudeusercontent.com','claudemcpcontent.com'];
 for(const d of protectedDomains)rules.push(`DOMAIN-SUFFIX,${d},${group}`);
 if(!aux)rules.push('RULE-SET,cloud_cn_domain,DIRECT','RULE-SET,cloud_cn_ip,DIRECT,no-resolve');rules.push('MATCH,'+group);
 const providers={};if(!aux)for(const [name,behavior,source]of [['cloud_cn_domain','domain','geosite'],['cloud_cn_ip','ipcidr','geoip']])providers[name]={type:'http',behavior,format:'mrs',path:`./ruleset/${name}.mrs`,url:`https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/${source}/cn.mrs`,interval:86400,proxy:group};
 return {'mixed-port':aux?c.local.auxPort:c.local.mainPort,'allow-lan':false,'bind-address':'127.0.0.1',mode:'rule','log-level':'warning',ipv6:!aux,'find-process-mode':'strict','unified-delay':true,'tcp-concurrent':true,
  dns:{enable:true,listen:`127.0.0.1:${aux?c.local.auxDnsPort:c.local.dnsPort}`,ipv6:false,'enhanced-mode':'fake-ip','fake-ip-range':'198.18.0.1/16','fake-ip-filter':['*.lan','*.local','localhost'],'respect-rules':true,'default-nameserver':['223.5.5.5','119.29.29.29'],nameserver:foreign,'proxy-server-nameserver':cn,'direct-nameserver':cn,'nameserver-policy':{...Object.fromEntries(protectedDomains.map(d=>['+.'+d,foreign])),...(!aux&&c.policy.browserMode==='split'?{'rule-set:cloud_cn_domain':cn}:{})}},
  tun:{enable:false,stack:'gvisor','auto-route':true,'strict-route':true,'auto-detect-interface':true,'dns-hijack':['any:53','tcp://any:53'],'inet6-address':['fdfe:dcba:9876::1/126'],'route-exclude-address':[c.server.address+'/32']},
  proxies:[{name:node,type:'ss',server:c.server.address,port:c.server.proxyPort,cipher:'2022-blake3-aes-128-gcm',password:(secret.ssServerKey||'AAAAAAAAAAAAAAAAAAAAAA==')+':'+(secret.ssUserKey||'AAAAAAAAAAAAAAAAAAAAAA=='),udp:true}],
  'proxy-groups':[{name:group,type:'select',proxies:[node]}],'rule-providers':providers,rules};
}
function template(c){const p=render(c);delete p.proxies;delete p['proxy-groups'][0].proxies;p['proxy-groups'][0].filter='.*';return p;}
module.exports={validate,render,template,browsers,macBrowsers};
if(require.main===module){try{validate(JSON.parse(require('fs').readFileSync(process.argv[2],'utf8').replace(/^\uFEFF/,'')),process.argv.includes('--deploy'));console.log('CONFIG_VALID')}catch(e){console.error(e.message);process.exitCode=1}}
