// Native UDP verifies interception by TUN, without explicitly selecting an HTTP/SOCKS proxy.
const dgram=require('node:dgram'),dns=require('node:dns').promises,crypto=require('node:crypto'),net=require('node:net');
function mapped(packet,transaction){
 if(packet.length<20||packet.readUInt16BE(0)!==0x101||packet.readUInt32BE(4)!==0x2112a442||!packet.subarray(8,20).equals(transaction))throw Error('Unrelated STUN reply');
 for(let i=20;i+4<=packet.length;){
  const type=packet.readUInt16BE(i),length=packet.readUInt16BE(i+2);const v=packet.subarray(i+4,i+4+length);i+=4+Math.ceil(length/4)*4;
  if(![0x20,1].includes(type)||v.length<8)continue;
  const bytes=Buffer.from(v.subarray(4));if(type===0x20){const mask=Buffer.concat([Buffer.from([0x21,0x12,0xa4,0x42]),transaction]);for(let j=0;j<bytes.length;j++)bytes[j]^=mask[j]}
  if(v[1]===1&&bytes.length===4)return [...bytes].join('.');
  if(v[1]===2&&bytes.length===16)return Array.from({length:8},(_,j)=>bytes.readUInt16BE(j*2).toString(16)).join(':');
 }
 throw Error('No mapped address');
}
async function probe(host,port,family){
 const address=(await dns.lookup(host,{family})).address,socket=dgram.createSocket(family===6?'udp6':'udp4');
 const id=crypto.randomBytes(12),packet=Buffer.alloc(20);packet.writeUInt16BE(1);packet.writeUInt32BE(0x2112a442,4);id.copy(packet,8);
 let timer,retry;
 try{return await new Promise((resolve,reject)=>{
  timer=setTimeout(()=>reject(Error('STUN timeout')),8000);socket.once('error',reject);
  socket.on('message',p=>{try{resolve(mapped(p,id))}catch{}});
  const send=()=>socket.send(packet,port,address,e=>{if(e)reject(e)});retry=setInterval(send,1500);send();
 })}finally{clearTimeout(timer);clearInterval(retry);socket.close()}
}
async function main(){
 const expected=process.argv[2];if(net.isIP(expected)!==4)throw Error('Supply expected server IPv4');
 for(const [host,port]of [['stun.l.google.com',19302],['stun.cloudflare.com',3478]])for(const family of [4,6]){
  try{const ip=await probe(host,port,family);console.log(JSON.stringify({host,family,ip,expected,pass:ip===expected}));if(ip!==expected)process.exitCode=1}
  catch(e){console.log(JSON.stringify({host,family,status:'no-candidate',reason:e.message}));if(family===4)process.exitCode=1}
 }
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1});
module.exports={mapped};
