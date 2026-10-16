import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOverlayRelay } from "./overlay-relay.mjs";

test("local OBS bridge authenticates, validates and delivers a reaction", async () => {
  const relay=createOverlayRelay({publishToken:"publish-test-token",viewToken:"view-test-token"});
  const address=await relay.listen(0);
  const base="http://127.0.0.1:"+address.port;
  const controller=new AbortController();
  // Drain every body: streaming responses only finish once the peer reads.
  const get=async(url,init)=>{
    const response=await fetch(url,init);
    await response.arrayBuffer().catch(()=>{});
    return response;
  };

  try {
    let response=await get(base+"/overlay");
    assert.equal(response.status,403,"overlay view token is required");
    response=await fetch(base+"/overlay?token=view-test-token");
    assert.equal(response.status,200);
    assert.match(await response.text(),/OBS Overlay/);

    response=await get(base+"/api/trigger",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({moment:"wow"})});
    assert.equal(response.status,401,"publishing requires its own secret");

    response=await get(base+"/api/trigger",{
      method:"POST",headers:{Authorization:"Bearer publish-test-token","Content-Type":"application/json"},
      body:JSON.stringify({moment:"wow",templateId:"sad-1"})});
    assert.equal(response.status,400,"mismatched template should be rejected");

    response=await get(base+"/api/trigger",{
      method:"POST",headers:{Authorization:"Bearer publish-test-token","Content-Type":"application/json"},
      body:JSON.stringify({moment:"wow",mediaFile:"../wrong.mp4"})});
    assert.equal(response.status,400,"media path traversal should be rejected");

    response=await get(base+"/api/trigger",{
      method:"POST",headers:{Authorization:"Bearer publish-test-token","Content-Type":"application/json",Origin:"https://attacker.example"},
      body:JSON.stringify({moment:"wow"})});
    assert.equal(response.status,403,"unexpected browser origins must be denied");

    response=await fetch(base+"/events?token=view-test-token",{signal:controller.signal});
    assert.equal(response.status,200);
    const reader=response.body.getReader();
    const initial=await reader.read();
    assert.match(new TextDecoder().decode(initial.value),/retry:/);

    const publish=await fetch(base+"/api/trigger",{
      method:"POST",headers:{Authorization:"Bearer publish-test-token","Content-Type":"application/json"},
      body:JSON.stringify({moment:"funny",templateId:"funny-2",durationMs:900})});
    assert.equal(publish.status,202);
    const accepted=await publish.json();
    assert.equal(accepted.connectedOverlays,1);

    const broadcast=await reader.read();
    const chunk=new TextDecoder().decode(broadcast.value);
    assert.match(chunk,/event: reaction/);
    assert.match(chunk,/"moment":"funny"/);
    assert.match(chunk,/"templateId":"funny-2"/);
    await reader.cancel().catch(()=>{});

    response=await get(base+"/templates/wow-1.png");
    assert.equal(response.status,200);
    assert.equal(response.headers.get("content-type"),"image/png");

    response=await get(base+"/media/..%2Fsecret.mp4");
    assert.equal(response.status,404);
  } finally {
    controller.abort();
    await relay.close();
  }
});

test("relay validates M3 contract fields: expiry, dedup, queue metadata", async () => {
  const relay=createOverlayRelay({publishToken:"p-token",viewToken:"v-token"});
  const address=await relay.listen(0);
  const base="http://127.0.0.1:"+address.port;
  const headers={Authorization:"Bearer p-token","Content-Type":"application/json"};
  try {
    let response=await fetch(base+"/api/trigger",{method:"POST",headers,
      body:JSON.stringify({moment:"wow",expiresAt:Date.now()-1000})});
    assert.equal(response.status,400,"expired triggers are rejected at the boundary");
    assert.match(await response.text(),/expired/);

    response=await fetch(base+"/api/trigger",{method:"POST",headers,
      body:JSON.stringify({moment:"wow",triggerId:"dup-1"})});
    assert.equal(response.status,202);
    response=await fetch(base+"/api/trigger",{method:"POST",headers,
      body:JSON.stringify({moment:"wow",triggerId:"dup-1"})});
    assert.equal(response.status,202,"replays are acknowledged without rebroadcast");
    assert.equal((await response.json()).duplicate,true);

    response=await fetch(base+"/api/trigger",{method:"POST",headers,
      body:JSON.stringify({moment:"wow",dedupKey:"ev-9"})});
    assert.equal(response.status,202);
    response=await fetch(base+"/api/trigger",{method:"POST",headers,
      body:JSON.stringify({moment:"funny",templateId:"funny-1",dedupKey:"ev-9"})});
    assert.equal((await response.json()).duplicate,true,"dedupKey aliases relays of one event");

    response=await fetch(base+"/api/trigger",{method:"POST",headers,
      body:JSON.stringify({moment:"wow",queue:"explode"})});
    assert.equal(response.status,400,"unknown queue policies are rejected");

    response=await fetch(base+"/api/trigger",{method:"POST",headers,
      body:JSON.stringify({moment:"wow",volume:2})});
    assert.equal(response.status,400,"out-of-range volume is rejected");

    response=await fetch(base+"/api/trigger",{method:"POST",headers,
      body:JSON.stringify({moment:"wow",clipStartMs:2000,clipEndMs:1000})});
    assert.equal(response.status,400,"inverted trim points are rejected");

    response=await fetch(base+"/api/trigger",{method:"POST",headers,
      body:JSON.stringify({moment:"wow",effectId:"effect-wow-1",volume:0.5,position:"fullscreen"})});
    assert.equal(response.status,202,"effect references resolve");

    response=await fetch(base+"/api/trigger",{method:"POST",headers,
      body:JSON.stringify({moment:"wow",effectId:"effect-sad-1"})});
    assert.equal(response.status,400,"effect/template mismatch is rejected");
  } finally {
    await relay.close();
  }
});

test("relay streams byte ranges, lists local media and resets cleanly", async () => {
  const mediaDir=mkdtempSync(join(tmpdir(),"reactions-"));
  writeFileSync(join(mediaDir,"clip.webm"),Buffer.alloc(1024,7));
  writeFileSync(join(mediaDir,"notes.txt"),"nope");
  const relay=createOverlayRelay({publishToken:"p-token",viewToken:"v-token",mediaDirectory:mediaDir});
  const address=await relay.listen(0);
  const base="http://127.0.0.1:"+address.port;
  const headers={Authorization:"Bearer p-token","Content-Type":"application/json"};
  try {
    let response=await fetch(base+"/templates/wow-1.png",{headers:{Range:"bytes=0-99"}});
    assert.equal(response.status,206,"templates support seeking");
    assert.match(response.headers.get("content-range")||"",/^bytes 0-99\//);
    assert.equal(response.headers.get("accept-ranges"),"bytes");
    assert.equal((await response.arrayBuffer()).byteLength,100);

    response=await fetch(base+"/templates/wow-1.png",{headers:{Range:"bytes=99999999-100000000"}});
    assert.equal(response.status,416,"unsatisfiable ranges report their bound");

    response=await fetch(base+"/media/clip.webm",{headers:{Range:"bytes=0-9"}});
    assert.equal(response.status,206);
    assert.equal((await response.arrayBuffer()).byteLength,10);

    response=await fetch(base+"/api/media?token=v-token");
    assert.equal(response.status,200);
    const listed=await response.json();
    assert.deepEqual(listed.media.map((m)=>m.name),["clip.webm"]);
    assert.equal(listed.media[0].kind,"video");

    response=await fetch(base+"/api/media");
    assert.equal(response.status,403,"media inventory needs a token");

    response=await fetch(base+"/api/health");
    assert.equal(response.status,200);
    const health=await response.json();
    assert.match(health.bootId,/^[0-9a-f]+$/,"restarts mint a fresh boot id");

    for(let i=0;i<50;i++){
      response=await fetch(base+"/api/trigger",{method:"POST",headers,
        body:JSON.stringify({moment:"funny",templateId:"funny-1"})});
      assert.equal(response.status,202);
    }
    const last=await response.json();
    assert.equal(last.sequence,50,"50 rapid triggers stay strictly ordered");
  } finally {
    await relay.close();
  }
});

test("relay serves bounded byte ranges and the shared player script", async () => {
  const mediaDir=mkdtempSync(join(tmpdir(),"reactions-"));
  const bytes=Buffer.alloc(4096,0);
  for(let i=0;i<bytes.length;i++)bytes[i]=i%256;
  writeFileSync(join(mediaDir,"clip.webm"),bytes);
  const relay=createOverlayRelay({publishToken:"p-token",viewToken:"v-token",mediaDirectory:mediaDir});
  const address=await relay.listen(0);
  const base="http://127.0.0.1:"+address.port;
  try {
    let response=await fetch(base+"/media/clip.webm");
    assert.equal(response.status,200,"full file still served");
    assert.equal(response.headers.get("accept-ranges"),"bytes");
    assert.equal(Number(response.headers.get("content-length")),4096);
    assert.equal(Buffer.from(await response.arrayBuffer()).length,4096);

    response=await fetch(base+"/media/clip.webm",{headers:{Range:"bytes=100-199"}});
    assert.equal(response.status,206,"mid-file seek slices exactly 100 bytes");
    assert.equal(response.headers.get("content-range"),"bytes 100-199/4096");
    const slice=Buffer.from(await response.arrayBuffer());
    assert.equal(slice.length,100);
    assert.equal(slice[0],100%256,"slice starts at the requested offset");

    response=await fetch(base+"/media/clip.webm",{headers:{Range:"bytes=4090-"}});
    assert.equal(response.status,206,"open-ended range reaches EOF");
    assert.equal(response.headers.get("content-range"),"bytes 4090-4095/4096");
    assert.equal(Buffer.from(await response.arrayBuffer()).length,6);

    response=await fetch(base+"/media/clip.webm",{headers:{Range:"bytes=-50"}});
    assert.equal(response.status,206,"suffix ranges serve the tail");
    assert.equal(Buffer.from(await response.arrayBuffer()).length,50);

    response=await fetch(base+"/media/clip.webm",{headers:{Range:"bytes=4096-5000"}});
    assert.equal(response.status,416,"past-EOF start is unsatisfiable");
    assert.equal(response.headers.get("content-range"),"bytes */4096");

    response=await fetch(base+"/media/clip.webm",{headers:{Range:"bytes=abc-def"}});
    assert.equal(response.status,200,"malformed ranges fall back to the full file");

    response=await fetch(base+"/obs-player.js");
    assert.equal(response.status,200,"shared scheduler ships to the overlay");
    assert.match(response.headers.get("content-type")||"",/javascript/);
    assert.match(await response.text(),/createScheduler/);
  } finally {
    await relay.close();
  }
});

test("relay issues the private OBS url only to the publish-token holder", async () => {
  const relay=createOverlayRelay({publishToken:"p-token",viewToken:"v-token"});
  const address=await relay.listen(0);
  const base="http://127.0.0.1:"+address.port;
  try {
    let response=await fetch(base+"/api/overlay-url",{method:"POST"});
    assert.equal(response.status,401,"no token means no url");
    response=await fetch(base+"/api/overlay-url",{method:"POST",
      headers:{Authorization:"Bearer wrong"}});
    assert.equal(response.status,401);
    response=await fetch(base+"/api/overlay-url",{method:"POST",
      headers:{Authorization:"Bearer p-token"}});
    assert.equal(response.status,200);
    const body=await response.json();
    assert.match(body.url,/^http:\/\/127\.0\.0\.1:\d+\/overlay\?token=v-token$/);
    const overlay=await fetch(body.url);
    assert.equal(overlay.status,200,"issued url loads the overlay");
  } finally {
    await relay.close();
  }
});
