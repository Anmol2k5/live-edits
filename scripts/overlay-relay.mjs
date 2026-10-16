import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat, readdir } from "node:fs/promises";
import { resolve, join, extname, basename, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT=resolve(fileURLToPath(new URL("..", import.meta.url)));
const MOMENTS=new Set(["wow","funny","sad"]);
const TEMPLATES=new Set(["wow-1","wow-2","funny-1","funny-2","sad-1","sad-2"]);
const ORIGINS=new Set(["http://localhost:1420","http://127.0.0.1:1420","http://tauri.localhost","tauri://localhost"]);
const MIME={".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".webp":"image/webp",".gif":"image/gif",".mp4":"video/mp4",".webm":"video/webm",".mp3":"audio/mpeg",".ogg":"audio/ogg",".wav":"audio/wav"};
const ALLOWED_EXT=new Set(Object.keys(MIME));
const POSITIONS=new Set(["center","fullscreen","top-left","top-right","bottom-left","bottom-right"]);
const QUEUES=new Set(["queue","interrupt","replace","ignore","coexist"]);
const MAX_CLIENTS=20;
const MAX_DEDUP=500;
const MAX_BODY=4096;
const MAX_FILE_BYTES=50*1024*1024;

function authorized(actual,expected){
  if(typeof actual!=="string")return false;
  const a=Buffer.from(actual),b=Buffer.from(expected);
  return a.length===b.length&&timingSafeEqual(a,b);
}
function json(res,status,body){
  res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});
  res.end(JSON.stringify(body));
}
function validMedia(name){
  return typeof name==="string"&&name.length<=128&&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)&&
    name!=="."&&name!==".."&&ALLOWED_EXT.has(extname(name).toLowerCase());
}
/** Defense in depth: even validated basenames must stay inside the directory. */
function insideDir(dir,file){
  const target=resolve(join(dir,file));
  return target===resolve(dir)||target.startsWith(resolve(dir)+sep) ? target : null;
}
function optString(value,min,max){
  return typeof value==="string"&&value.length>=min&&value.length<=max;
}
function parseTrigger(input){
  if(!input||typeof input!=="object"||!MOMENTS.has(input.moment))return null;
  let templateId=input.templateId??input.moment+"-1";
  if(input.effectId!==undefined){
    if(!optString(input.effectId,1,128)||!input.effectId.startsWith("effect-"))return null;
    const implied=input.effectId.slice("effect-".length);
    if(!TEMPLATES.has(implied))return null;
    if(input.templateId!==undefined&&input.templateId!==implied)return null;
    templateId=implied;
  }
  if(!TEMPLATES.has(templateId)||!templateId.startsWith(input.moment+"-"))return null;
  if(input.mediaFile!==undefined&&!validMedia(input.mediaFile))return null;
  if(input.triggerId!==undefined&&!optString(input.triggerId,1,128))return null;
  if(input.dedupKey!==undefined&&!optString(input.dedupKey,1,128))return null;
  if(input.expiresAt!==undefined&&(!Number.isInteger(input.expiresAt)||input.expiresAt<=0))return null;
  if(input.sequenceNumber!==undefined&&(!Number.isInteger(input.sequenceNumber)||input.sequenceNumber<0))return null;
  const durationMs=input.durationMs??2700;
  if(!Number.isInteger(durationMs)||durationMs<250||durationMs>30000)return null;
  let volume=input.volume??1;
  if(typeof volume!=="number"||!(volume>=0&&volume<=1))return null;
  volume=Math.min(1,Math.max(0,volume));
  let clipStartMs=input.clipStartMs;
  if(clipStartMs!==undefined&&(!Number.isInteger(clipStartMs)||clipStartMs<0||clipStartMs>600000))return null;
  let clipEndMs=input.clipEndMs;
  if(clipEndMs!==undefined&&(!Number.isInteger(clipEndMs)||clipEndMs<1||clipEndMs>600000))return null;
  if(clipStartMs!==undefined&&clipEndMs!==undefined&&clipEndMs<=clipStartMs)return null;
  let position=input.position??"center";
  if(!POSITIONS.has(position))return null;
  let queue=input.queue??"replace";
  if(!QUEUES.has(queue))return null;
  let priority=input.priority??50;
  if(!Number.isInteger(priority)||priority<0||priority>100)return null;
  return {moment:input.moment,templateId,mediaFile:input.mediaFile??null,durationMs,volume,
    clipStartMs:clipStartMs??null,clipEndMs:clipEndMs??null,position,queue,priority,
    effectId:input.effectId??null,
    triggerId:input.triggerId??null,dedupKey:input.dedupKey??null,
    expiresAt:input.expiresAt??null,
    sequenceNumber:input.sequenceNumber??null};
}
function rangeSlice(header,size){
  const match=/^bytes=(\d*)-(\d*)$/.exec((header||"").trim());
  if(!match)return null;
  let [,start,end]=match;
  if(start===""&&end==="")return null;
  let from=start===""?size-Number(end):Number(start);
  let to=end===""?size-1:Number(end);
  if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||to<from||from>=size)return {unsatisfiable:true};
  to=Math.min(to,size-1);
  return {from,to};
}
async function serve(res,fullPath,mime,rangeHeader){
  const info=await stat(fullPath).catch(()=>null);
  if(!info?.isFile()||info.size>MAX_FILE_BYTES)return json(res,404,{error:"not found"});
  const size=info.size;
  const range=rangeHeader?rangeSlice(rangeHeader,size):null;
  if(range?.unsatisfiable){
    res.writeHead(416,{"Content-Range":"bytes */"+size,"Accept-Ranges":"bytes"});
    return res.end();
  }
  const body=await readFile(fullPath);
  if(range){
    const slice=body.subarray(range.from,range.to+1);
    res.writeHead(206,{"Content-Type":mime,"Content-Length":slice.length,
      "Content-Range":"bytes "+range.from+"-"+range.to+"/"+size,
      "Accept-Ranges":"bytes","X-Content-Type-Options":"nosniff","Cache-Control":"private, max-age=60"});
    return res.end(slice);
  }
  res.writeHead(200,{"Content-Type":mime,"Content-Length":body.length,
    "Accept-Ranges":"bytes","X-Content-Type-Options":"nosniff","Cache-Control":"private, max-age=60"});
  res.end(body);
}
function broadcast(clients,event){
  const frame="id: "+event.sequence+"\nevent: reaction\ndata: "+JSON.stringify(event)+"\n\n";
  for(const client of [...clients]){
    try{client.write(frame);}
    catch{clients.delete(client);}
  }
}

/** Local-development bridge, bound to loopback. Not a cloud SaaS endpoint. */
export function createOverlayRelay({
  publishToken=randomBytes(24).toString("hex"),
  viewToken=randomBytes(24).toString("hex"),
  templatesDirectory=join(ROOT,"public","templates"),
  mediaDirectory=join(ROOT,"public","reactions"),
}={}){
  const bootId=randomBytes(8).toString("hex");
  const clients=new Set();
  const seenDedup=new Map();
  let sequence=0;
  const noteDedup=(key)=>{
    if(key==null)return true;
    if(seenDedup.has(key))return false;
    seenDedup.set(key,Date.now());
    if(seenDedup.size>MAX_DEDUP){
      const oldest=seenDedup.keys().next();
      if(!oldest.done)seenDedup.delete(oldest.value);
    }
    return true;
  };
  const server=createServer(async(req,res)=>{
    try{
      const url=new URL(req.url||"/","http://127.0.0.1");
      const origin=req.headers.origin;
      if(origin){
        if(!ORIGINS.has(origin))return json(res,403,{error:"origin denied"});
        res.setHeader("Access-Control-Allow-Origin",origin);
        res.setHeader("Vary","Origin");
        res.setHeader("Access-Control-Allow-Headers","Authorization, Content-Type");
        res.setHeader("Access-Control-Allow-Methods","GET, POST, OPTIONS");
      }
      if(req.method==="OPTIONS"){res.writeHead(204);return res.end();}
      if(req.method==="GET"&&url.pathname==="/api/health"){
        return json(res,200,{ok:true,bootId,sequence,connectedOverlays:clients.size});
      }
      if(req.method==="GET"&&url.pathname==="/api/media"){
        const queryToken=url.searchParams.get("token")??"";
        const bearer=(req.headers.authorization||"").replace(/^Bearer /,"");
        if(!authorized(queryToken,viewToken)&&!authorized(bearer,publishToken)&&!authorized(bearer,viewToken))
          return json(res,403,{error:"forbidden"});
        const entries=await readdir(mediaDirectory).catch(()=>[]);
        const items=[];
        for(const name of entries){
          if(!validMedia(name))continue;
          const full=insideDir(mediaDirectory,name);
          if(!full)continue;
          const info=await stat(full).catch(()=>null);
          if(!info?.isFile())continue;
          const ext=extname(name).toLowerCase();
          items.push({name,bytes:info.size,
            kind:MIME[ext]?.startsWith("video")?"video":MIME[ext]?.startsWith("audio")?"audio":"image"});
        }
        items.sort((a,b)=>a.name.localeCompare(b.name));
        return json(res,200,{media:items});
      }
      if(req.method==="GET"&&url.pathname==="/overlay"){
        if(!authorized(url.searchParams.get("token"),viewToken))return json(res,403,{error:"forbidden"});
        const body=await readFile(join(ROOT,"public","obs-overlay.html"));
        res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store",
          "Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff",
          "Content-Security-Policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; media-src 'self';"});
        return res.end(body);
      }
      if(req.method==="GET"&&url.pathname==="/events"){
        if(!authorized(url.searchParams.get("token"),viewToken))return json(res,403,{error:"forbidden"});
        if(clients.size>=MAX_CLIENTS)return json(res,503,{error:"too many overlays"});
        res.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache, no-transform","Connection":"keep-alive"});
        res.write("retry: 2000\n\n");
        res.write("id: "+sequence+"\nevent: hello\ndata: "+JSON.stringify({bootId,sequence})+"\n\n");
        clients.add(res);
        const pulse=setInterval(()=>{try{res.write(": ping\n\n");}catch{clearInterval(pulse);clients.delete(res);}},15000);
        req.on("close",()=>{clearInterval(pulse);clients.delete(res);});
        return;
      }
      if(req.method==="POST"&&url.pathname==="/api/trigger"){
        if(!authorized(req.headers.authorization?.replace(/^Bearer /,""),publishToken))return json(res,401,{error:"unauthorized"});
        let data="";
        for await(const chunk of req){
          data+=chunk.toString();
          if(data.length>MAX_BODY)return json(res,413,{error:"request too large"});
        }
        let input;
        try{input=JSON.parse(data)}catch{return json(res,400,{error:"invalid JSON"});}
        const payload=parseTrigger(input);
        if(!payload)return json(res,400,{error:"invalid reaction"});
        if(payload.expiresAt!=null&&Date.now()>payload.expiresAt)
          return json(res,400,{error:"expired"});
        const dedupKey=payload.dedupKey??payload.triggerId;
        if(!noteDedup(dedupKey))
          return json(res,202,{accepted:false,duplicate:true,connectedOverlays:clients.size});
        if(payload.mediaFile){
          const full=insideDir(mediaDirectory,payload.mediaFile);
          if(!full)return json(res,400,{error:"invalid media file"});
          const file=await stat(full).catch(()=>null);
          if(!file?.isFile())return json(res,400,{error:"missing media file"});
        }
        const event={...payload,bootId,sequence:++sequence,at:Date.now()};
        broadcast(clients,event);
        return json(res,202,{accepted:true,sequence:event.sequence,bootId,connectedOverlays:clients.size});
      }
      if(req.method==="GET"&&url.pathname.startsWith("/templates/")){
        const name=basename(url.pathname);
        if(!name.endsWith(".png")||!TEMPLATES.has(name.slice(0,-4))||url.pathname!=="/templates/"+name)
          return json(res,404,{error:"not found"});
        const full=insideDir(templatesDirectory,name);
        if(!full)return json(res,404,{error:"not found"});
        return await serve(res,full,"image/png",req.headers.range);
      }
      if(req.method==="GET"&&url.pathname.startsWith("/media/")){
        const name=basename(url.pathname);
        if(url.pathname!=="/media/"+name||!validMedia(name))return json(res,404,{error:"not found"});
        const full=insideDir(mediaDirectory,name);
        if(!full)return json(res,404,{error:"not found"});
        return await serve(res,full,MIME[extname(name).toLowerCase()],req.headers.range);
      }
      return json(res,404,{error:"not found"});
    }catch(error){
      if(!res.headersSent)json(res,500,{error:"internal relay error"});
      else res.end();
      if(process.env.NODE_ENV!=="test")console.error("Overlay relay:",error);
    }
  });
  const listen=(port=4190,host="127.0.0.1")=>new Promise((success,failure)=>{
    server.once("error",failure);
    server.listen(port,host,()=>{server.off("error",failure);success(server.address());});
  });
  const close=()=>new Promise((success,failure)=>{
    for(const client of clients)client.end();
    seenDedup.clear();
    server.close(error=>error?failure(error):success());
  });
  return {server,listen,close,publishToken,viewToken,bootId};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const relay=createOverlayRelay({
    publishToken:process.env.LIVE_EDITS_PUBLISH_TOKEN||undefined,
    viewToken:process.env.LIVE_EDITS_VIEW_TOKEN||undefined
  });
  const address=await relay.listen();
  console.log("Live Edits development relay running at http://127.0.0.1:"+address.port);
  console.log("Desktop PUBLISH token (do not share): "+relay.publishToken);
  console.log("OBS Browser Source URL (keep private): http://127.0.0.1:"+address.port+"/overlay?token="+relay.viewToken);
  console.log("To play custom video/audio, place files in public/reactions/ and enter their filename in the desktop UI.");
}
