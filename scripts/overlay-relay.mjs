import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve, join, extname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT=resolve(fileURLToPath(new URL("..", import.meta.url)));
const MOMENTS=new Set(["wow","funny","sad"]);
const TEMPLATES=new Set(["wow-1","wow-2","funny-1","funny-2","sad-1","sad-2"]);
const ORIGINS=new Set(["http://localhost:1420","http://127.0.0.1:1420","http://tauri.localhost","tauri://localhost"]);
const MIME={".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".webp":"image/webp",".gif":"image/gif",".mp4":"video/mp4",".webm":"video/webm",".mp3":"audio/mpeg",".ogg":"audio/ogg",".wav":"audio/wav"};
const ALLOWED_EXT=new Set(Object.keys(MIME));

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
function parseTrigger(input){
  if(!input||typeof input!=="object"||!MOMENTS.has(input.moment))return null;
  const templateId=input.templateId??input.moment+"-1";
  if(!TEMPLATES.has(templateId)||!templateId.startsWith(input.moment+"-"))return null;
  if(input.mediaFile!==undefined&&!validMedia(input.mediaFile))return null;
  const durationMs=input.durationMs??2700;
  if(!Number.isInteger(durationMs)||durationMs<250||durationMs>10000)return null;
  return {moment:input.moment,templateId,mediaFile:input.mediaFile??null,durationMs};
}
async function serve(res,fullPath,mime){
  const info=await stat(fullPath).catch(()=>null);
  if(!info?.isFile()||info.size>50*1024*1024)return json(res,404,{error:"not found"});
  const body=await readFile(fullPath);
  res.writeHead(200,{"Content-Type":mime,"Content-Length":body.length,"X-Content-Type-Options":"nosniff","Cache-Control":"private, max-age=60"});
  res.end(body);
}

/** Local-development bridge, bound to loopback. Not a cloud SaaS endpoint. */
export function createOverlayRelay({
  publishToken=randomBytes(24).toString("hex"),
  viewToken=randomBytes(24).toString("hex"),
  templatesDirectory=join(ROOT,"public","templates"),
  mediaDirectory=join(ROOT,"public","reactions"),
}={}){
  const clients=new Set();
  let sequence=0;
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
        return json(res,200,{ok:true,connectedOverlays:clients.size});
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
        res.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache, no-transform","Connection":"keep-alive"});
        res.write("retry: 2000\n\n");
        clients.add(res);
        const pulse=setInterval(()=>res.write(": ping\n\n"),15000);
        req.on("close",()=>{clearInterval(pulse);clients.delete(res);});
        return;
      }
      if(req.method==="POST"&&url.pathname==="/api/trigger"){
        if(!authorized(req.headers.authorization?.replace(/^Bearer /,""),publishToken))return json(res,401,{error:"unauthorized"});
        let data="";
        for await(const chunk of req){
          data+=chunk.toString();
          if(data.length>4096)return json(res,413,{error:"request too large"});
        }
        let input;
        try{input=JSON.parse(data)}catch{return json(res,400,{error:"invalid JSON"});}
        const payload=parseTrigger(input);
        if(!payload)return json(res,400,{error:"invalid reaction"});
        if(payload.mediaFile){
          const file=await stat(join(mediaDirectory,payload.mediaFile)).catch(()=>null);
          if(!file?.isFile())return json(res,400,{error:"missing media file"});
        }
        const event={...payload,sequence:++sequence,at:Date.now()};
        for(const client of clients)client.write("event: reaction\ndata: "+JSON.stringify(event)+"\n\n");
        return json(res,202,{accepted:true,sequence:event.sequence,connectedOverlays:clients.size});
      }
      if(req.method==="GET"&&url.pathname.startsWith("/templates/")){
        const name=basename(url.pathname);
        if(!name.endsWith(".png")||!TEMPLATES.has(name.slice(0,-4))||url.pathname!=="/templates/"+name)
          return json(res,404,{error:"not found"});
        return await serve(res,join(templatesDirectory,name),"image/png");
      }
      if(req.method==="GET"&&url.pathname.startsWith("/media/")){
        const name=basename(url.pathname);
        if(url.pathname!=="/media/"+name||!validMedia(name))return json(res,404,{error:"not found"});
        return await serve(res,join(mediaDirectory,name),MIME[extname(name).toLowerCase()]);
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
    server.close(error=>error?failure(error):success());
  });
  return {server,listen,close,publishToken,viewToken};
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