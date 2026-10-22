import type { ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { TriggerPublishSchema, type TriggerPublish } from "./types.ts";

const MAX_CLIENTS = 50;
const MAX_DEDUP = 500;
/** Bytes a slow SSE client may lag before it is dropped (it reconnects). */
const MAX_PENDING_BYTES = 64 * 1024;
const TEMPLATES = new Set(["wow-1", "wow-2", "funny-1", "funny-2", "sad-1", "sad-2"]);

/** Bundled template art served to hosted overlays (public assets, no secret). */
export function isTemplateAsset(name: string): boolean {
  return typeof name === "string" && name.endsWith(".png") && TEMPLATES.has(name.slice(0, -4));
}

export async function templatePngBytes(name: string): Promise<Buffer> {
  const here = dirname(fileURLToPath(import.meta.url));
  const full = resolve(here, "..", "..", "public", "templates", name);
  const { readFile: read } = await import("node:fs/promises");
  return read(full);
}

export interface OverlayEvent {
  bootId: string;
  sequence: number;
  at: number;
  moment: string;
  templateId: string;
  mediaFile: string | null;
  mediaUrl: string | null;
  durationMs: number;
  volume: number;
  muted: boolean;
  clipStartMs: number | null;
  clipEndMs: number | null;
  position: string;
  queue: string;
  priority: number;
  cooldownMs: number;
  effectId: string | null;
  triggerId: string | null;
  dedupKey: string | null;
  expiresAt: number | null;
  sequenceNumber: number | null;
}

interface Client {
  res: ServerResponse;
  overlayId: string;
}

export class OverlayHub {
  private clients = new Map<string, Set<Client>>();
  private pending = new Map<ServerResponse, number>();
  private seenDedup = new Map<string, Map<string, number>>();
  private sequences = new Map<string, number>();
  readonly bootId: string;

  constructor(bootId: string) {
    this.bootId = bootId;
  }

  private seq(workspaceId: string): number {
    const next = (this.sequences.get(workspaceId) ?? 0) + 1;
    this.sequences.set(workspaceId, next);
    return next;
  }

  noteDedup(workspaceId: string, key: string | null): boolean {
    if (key == null) return true;
    let seen = this.seenDedup.get(workspaceId);
    if (!seen) {
      seen = new Map();
      this.seenDedup.set(workspaceId, seen);
    }
    if (seen.has(key)) return false;
    seen.set(key, Date.now());
    if (seen.size > MAX_DEDUP) {
      const oldest = seen.keys().next();
      if (!oldest.done) seen.delete(oldest.value);
    }
    return true;
  }

  addClient(workspaceId: string, overlayId: string, res: ServerResponse): boolean {
    let set = this.clients.get(workspaceId);
    if (!set) {
      set = new Set();
      this.clients.set(workspaceId, set);
    }
    const total = [...this.clients.values()].reduce((n, s) => n + s.size, 0);
    if (total >= MAX_CLIENTS) return false;
    set.add({ res, overlayId });
    return true;
  }

  removeClient(workspaceId: string, res: ServerResponse): void {
    const set = this.clients.get(workspaceId);
    this.pending.delete(res);
    if (!set) return;
    for (const c of [...set]) if (c.res === res) set.delete(c);
    if (set.size === 0) this.clients.delete(workspaceId);
  }

  dropOverlayClients(workspaceId: string, overlayId: string): void {
    const set = this.clients.get(workspaceId);
    if (!set) return;
    for (const c of [...set]) {
      if (c.overlayId === overlayId) {
        try {
          c.res.end();
        } catch {
          // ignore
        }
        this.pending.delete(c.res);
        set.delete(c);
      }
    }
  }

  connectedOverlays(workspaceId?: string): number {
    if (workspaceId) return this.clients.get(workspaceId)?.size ?? 0;
    return [...this.clients.values()].reduce((n, s) => n + s.size, 0);
  }

  broadcast(workspaceId: string, event: OverlayEvent): number {
    const set = this.clients.get(workspaceId);
    if (!set || set.size === 0) return 0;
    const frame = `id: ${event.sequence}\nevent: reaction\ndata: ${JSON.stringify(event)}\n\n`;
    const frameBytes = Buffer.byteLength(frame);
    let delivered = 0;
    for (const c of [...set]) {
      try {
        const ok = c.res.write(frame);
        if (!ok) {
          const pending = (this.pending.get(c.res) ?? 0) + frameBytes;
          this.pending.set(c.res, pending);
          c.res.once("drain", () => this.pending.delete(c.res));
          if (pending > MAX_PENDING_BYTES) {
            // Hopelessly slow reader: drop it so one stuck overlay can
            // never stall the workspace. EventSource reconnects.
            set.delete(c);
            this.pending.delete(c.res);
            try {
              c.res.destroy();
            } catch {
              // ignore
            }
            continue;
          }
        } else {
          this.pending.delete(c.res);
        }
        delivered += 1;
      } catch {
        set.delete(c);
        this.pending.delete(c.res);
      }
    }
    return delivered;
  }

  nextSequence(workspaceId: string): number {
    return this.seq(workspaceId);
  }
}

export interface ValidatedTrigger extends TriggerPublish {
  templateId: string;
}

const EFFECT_ID_RE = /^effect-[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Validate a hosted trigger; mirrors local relay rules plus workspace media existence (checked by caller). */
export function validateTrigger(input: unknown): ValidatedTrigger {
  const parsed = TriggerPublishSchema.parse(input);
  if (parsed.expiresAt != null && Date.now() > parsed.expiresAt) {
    throw Object.assign(new Error("expired"), { code: "expired" });
  }
  if (parsed.clipStartMs !== undefined && parsed.clipEndMs !== undefined && parsed.clipEndMs <= parsed.clipStartMs) {
    throw Object.assign(new Error("inverted trim"), { code: "invalid" });
  }
  if (parsed.effectId !== undefined && !EFFECT_ID_RE.test(parsed.effectId) && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(parsed.effectId)) {
    throw Object.assign(new Error("malformed effect id"), { code: "invalid" });
  }
  const templateId = parsed.templateId ?? `${parsed.moment}-1`;
  if (!TEMPLATES.has(templateId) || !templateId.startsWith(`${parsed.moment}-`)) {
    throw Object.assign(new Error("template artwork must match the moment"), { code: "invalid" });
  }
  return { ...parsed, templateId };
}

export function hostedOverlayHtml(overlayId: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Live Edits Hosted Overlay</title>
<style>
html,body{width:100%;height:100%;margin:0;overflow:hidden;background:transparent!important;font-family:system-ui,sans-serif}
#stage{width:100%;height:100%;display:grid;place-items:center;pointer-events:none;position:relative}
.effect{max-width:72%;max-height:72%;filter:drop-shadow(0 15px 25px #0008);animation:appear .23s cubic-bezier(.2,1.5,.3,1) both}
.effect img,.effect video{width:100%;max-height:67vh;object-fit:contain;border-radius:14px}
.effect--fullscreen{max-width:100%;max-height:100%;width:100%;height:100%}
.effect--fullscreen img,.effect--fullscreen video{width:100%;height:100%;max-height:100%;object-fit:cover;border-radius:0}
.effect--corner{position:absolute;max-width:34%;margin:0}
.effect--top-left{top:3%;left:3%}.effect--top-right{top:3%;right:3%}
.effect--bottom-left{bottom:3%;left:3%}.effect--bottom-right{bottom:3%;right:3%}
.effect--leaving{animation:leave .25s ease both}
#debug{position:absolute;bottom:12px;left:12px;padding:7px 10px;color:white;background:#13172bc9;border-radius:8px;font-size:13px}
@keyframes appear{from{opacity:0;transform:translateY(25px) scale(.8)}to{opacity:1;transform:translateY(0) scale(1)}}
@keyframes leave{from{opacity:1}to{opacity:0;transform:scale(.92)}}
</style>
</head>
<body>
<main id="stage" aria-label="Stream effects"></main>
<div id="debug" hidden>Connecting...</div>
<script src="/o/${overlayId}/scheduler-core.js"></script>
<script>
(function(){
const query=new URLSearchParams(location.search);
const overlayId=${JSON.stringify(overlayId)};
const stage=document.getElementById("stage");
const debug=document.getElementById("debug");
debug.hidden=query.get("debug")!=="1";
const sched=window.LiveEditsScheduler.createScheduler({maxQueue:6,dedupSize:200});
const eventsByKey=new Map();
const layers=new Map();
const pendingStarts=new WeakMap();
let playToken=0,lastSequence=0,lastBootId=null,mainKey=null;
const status=m=>{debug.textContent=m};
function release(wrapper){
pendingStarts.get(wrapper)?.();
try{const media=wrapper.querySelector("video,audio");if(media){try{media.pause()}catch{}media.removeAttribute("src");try{media.load()}catch{}}
const imgs=wrapper.querySelectorAll("img");imgs.forEach(i=>i.removeAttribute("src"));}catch{}
wrapper.remove();
}
function startMedia(media,event,wrapper){
return new Promise(resolve=>{
let settled=false,started=false,loadTimer;
const finish=result=>{
if(settled)return;
settled=true;clearTimeout(loadTimer);
media.removeEventListener("error",fail);media.removeEventListener("load",start);media.removeEventListener("loadedmetadata",start);
pendingStarts.delete(wrapper);resolve(result);
};
const fail=()=>finish("failed");
const start=async()=>{
if(started||settled||!wrapper.isConnected)return;
started=true;
try{if(media.tagName==="VIDEO"||media.tagName==="AUDIO"){
if(event.clipStartMs!=null)media.currentTime=event.clipStartMs/1000;
await media.play();
if(!wrapper.isConnected){try{media.pause()}catch{}return;}
}}catch(err){if(wrapper.isConnected)status("Media playback blocked: "+err.message)}
finish("ready");
};
pendingStarts.set(wrapper,()=>finish("cancelled"));
media.addEventListener("error",fail,{once:true});
if(media.tagName==="IMG"){
if(media.complete)void start();else{media.addEventListener("load",start,{once:true});loadTimer=setTimeout(()=>finish("ready"),4000);}
}else if(event.clipStartMs!=null&&media.readyState<1){media.addEventListener("loadedmetadata",start,{once:true});}
else void start();
});
}
function visibleDuration(event){
const durationMs=event.durationMs||2700;
return event.clipEndMs!=null?Math.min(durationMs,Math.max(0,event.clipEndMs-(event.clipStartMs??0))):durationMs;
}
function cleanupMain(){const main=stage.querySelector(":scope > .effect--main");if(main)release(main);for(const w of layers.keys())release(w);layers.clear();}
function effectLike(e){return{id:e.effectId||e.templateId||e.moment,enabled:true,priority:typeof e.priority==="number"?e.priority:50,queue:e.queue||"replace",cooldownMs:typeof e.cooldownMs==="number"?e.cooldownMs:0};}
function triggerLike(e){return{id:String(e.triggerId??("seq:"+e.sequence)),dedupKey:e.dedupKey??undefined,expiresAt:e.expiresAt??undefined};}
function mediaSrc(e){return e.mediaUrl?e.mediaUrl:(e.mediaFile?("/o/"+overlayId+"/media/"+encodeURIComponent(e.mediaFile)+"?token="+encodeURIComponent(query.get("token")||"")):null);}
function positionClass(p){if(p==="fullscreen")return "effect--fullscreen";if(p==="top-left")return "effect--corner effect--top-left";if(p==="top-right")return "effect--corner effect--top-right";if(p==="bottom-left")return "effect--corner effect--bottom-left";if(p==="bottom-right")return "effect--corner effect--bottom-right";return "";}
async function play(event){
const wrapper=document.createElement("div");
wrapper.className=("effect effect--main "+positionClass(event.position)).trim();
const src=mediaSrc(event);
let media;
if(event.mediaFile&&/\\.(webm|mp4)$/i.test(event.mediaFile)){media=document.createElement("video");media.src=src;media.playsInline=true;media.muted=event.muted===true;if(typeof event.volume==="number")media.volume=Math.min(1,Math.max(0,event.volume));}
else if(event.mediaFile&&/\\.(mp3|ogg|wav)$/i.test(event.mediaFile)){media=document.createElement("audio");media.src=src;media.muted=event.muted===true;if(typeof event.volume==="number")media.volume=Math.min(1,Math.max(0,event.volume));const fb=document.createElement("img");fb.src="/o/"+overlayId+"/templates/"+event.templateId+".png";fb.alt=event.moment+" reaction";wrapper.append(fb);}
else{media=document.createElement("img");media.src=src||("/o/"+overlayId+"/templates/"+event.templateId+".png");media.alt=event.moment+" reaction";}
wrapper.append(media);stage.append(wrapper);status("Playing "+event.moment);
const started=await startMedia(media,event,wrapper);
if(started!=="ready"){if(started==="failed")status("Media failed to load; skipped");release(wrapper);return started;}
await new Promise(r=>setTimeout(r,visibleDuration(event)));
if(event.clipEndMs!=null)try{media.pause?.()}catch{}
wrapper.classList.add("effect--leaving");
await new Promise(r=>setTimeout(r,240));
release(wrapper);return "done";
}
async function playLayer(event,key){
const wrapper=document.createElement("div");
wrapper.className=("effect "+positionClass(event.position)).trim();
layers.set(wrapper,key);
try{
const src=mediaSrc(event);let media;
if(event.mediaFile&&/\\.(webm|mp4)$/i.test(event.mediaFile)){media=document.createElement("video");media.src=src;media.playsInline=true;media.muted=event.muted===true;if(typeof event.volume==="number")media.volume=Math.min(1,Math.max(0,event.volume));}
else if(event.mediaFile&&/\\.(mp3|ogg|wav)$/i.test(event.mediaFile)){media=document.createElement("audio");media.src=src;media.muted=event.muted===true;if(typeof event.volume==="number")media.volume=Math.min(1,Math.max(0,event.volume));const fb=document.createElement("img");fb.src="/o/"+overlayId+"/templates/"+event.templateId+".png";fb.alt=event.moment+" reaction";wrapper.append(fb);}
else{media=document.createElement("img");media.src=src||("/o/"+overlayId+"/templates/"+event.templateId+".png");media.alt=event.moment+" reaction";}
wrapper.append(media);stage.append(wrapper);
const started=await startMedia(media,event,wrapper);
if(started==="failed")status("Media failed to load; skipped");
else if(started==="ready"){await new Promise(r=>setTimeout(r,visibleDuration(event)));if(event.clipEndMs!=null)try{media.pause?.()}catch{}wrapper.classList.add("effect--leaving");await new Promise(r=>setTimeout(r,240));}
}finally{release(wrapper);layers.delete(wrapper);eventsByKey.delete(key);}
}
async function runMain(key,token){
const event=eventsByKey.get(key);if(!event){if(mainKey===key)mainKey=null;return;}
mainKey=key;await play(event);eventsByKey.delete(key);if(mainKey===key)mainKey=null;
if(token!==playToken)return;const next=sched.finish(key);if(next){const f=eventsByKey.get(next.key);if(f)void runMain(next.key,token);}
}
function submit(event){
const result=sched.submit(effectLike(event),triggerLike(event));
if(result.action==="drop"){status(result.reason==="duplicate"?"Duplicate trigger ignored":result.reason==="expired"?"Expired trigger ignored":result.reason==="cooldown"?"Trigger cooling down":"Trigger ignored (busy)");return;}
if(result.key)eventsByKey.set(result.key,event);
if(result.action==="replace"){playToken++;cleanupMain();sched.clearWaiting();eventsByKey.clear();if(result.key)eventsByKey.set(result.key,event);void runMain(result.key,playToken);return;}
if(result.action==="start"&&(event.queue||"replace")==="coexist"&&mainKey!==null){if(layers.size>=3){status("Too many layers; trigger ignored");eventsByKey.delete(result.key);return;}void playLayer(event,result.key);return;}
if(mainKey===null)void runMain(result.key,playToken);
}
window.__liveEdits={layers:()=>layers.size,queued:()=>sched.queueLength(),playing:()=>mainKey!==null,idle:()=>mainKey===null&&layers.size===0&&sched.queueLength()===0};
const events=new EventSource("/o/"+overlayId+"/events?token="+encodeURIComponent(query.get("token")||""));
events.onopen=()=>status("Hosted overlay connected");
events.onerror=()=>status("Hosted overlay reconnecting");
events.addEventListener("hello",message=>{try{const h=JSON.parse(message.data);if(lastBootId!==null&&h.bootId!==lastBootId){lastSequence=0;playToken++;cleanupMain();eventsByKey.clear();sched.reset();mainKey=null;status("Session resynchronised");}lastBootId=h.bootId;}catch{status("Malformed hello event")}});
events.addEventListener("reaction",message=>{try{const r=JSON.parse(message.data);if(r.sequence<=lastSequence)return;lastSequence=r.sequence;submit(r);}catch{status("Malformed reaction event")}});
})();
</script>
</body>
</html>`;
}

export async function schedulerCoreJs(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const core = resolve(here, "..", "..", "src", "effects", "scheduler-core.js");
  return readFile(core, "utf8");
}
