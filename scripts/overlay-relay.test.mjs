import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createOverlayRelay } from "./overlay-relay.mjs";

function wavBytes(payloadSize, fill = 7) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + payloadSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(22050, 24);
  header.writeUInt32LE(44100, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(payloadSize, 40);
  return Buffer.concat([header, Buffer.alloc(payloadSize, fill)]);
}

function pngBytes(payloadSize) {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([head, Buffer.alloc(payloadSize, 3)]);
}

function residue(dir) {
  return readdirSync(dir).filter((n) => n.startsWith(".upload-") && n.endsWith(".part"));
}

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
    assert.equal(response.status,202,"pack effect ids are opaque to the relay");

    response=await fetch(base+"/api/trigger",{method:"POST",headers,
      body:JSON.stringify({moment:"wow",effectId:"not-an-effect"})});
    assert.equal(response.status,400,"malformed effect ids are rejected");

    response=await fetch(base+"/api/trigger",{method:"POST",headers,
      body:JSON.stringify({moment:"wow",templateId:"sad-1"})});
    assert.equal(response.status,400,"template artwork must still match the moment");
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
    await overlay.arrayBuffer().catch(()=>{});
  } finally {
    await relay.close();
  }
});

test("relay imports media over an authenticated streaming upload", async () => {
  const mediaDir=mkdtempSync(join(tmpdir(),"reactions-"));
  const relay=createOverlayRelay({publishToken:"p-token",viewToken:"v-token",mediaDirectory:mediaDir});
  const address=await relay.listen(0);
  const base="http://127.0.0.1:"+address.port;
  const auth={Authorization:"Bearer p-token"};
  const drain=async(response)=>{await response.arrayBuffer().catch(()=>{});return response;};
  try {
    const payload=wavBytes(4096);
    let response=await fetch(base+"/api/media/sting.wav",{method:"POST",headers:{...auth,"Content-Type":"audio/wav"},body:payload});
    assert.equal(response.status,201,"valid upload is stored");
    assert.deepEqual(await response.json(),{name:"sting.wav",bytes:payload.length,kind:"audio"});

    response=await fetch(base+"/media/sting.wav");
    assert.equal(response.status,200,"uploaded file plays back");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),payload,"round-trip is byte-identical");

    response=await fetch(base+"/api/media",{headers:auth});
    assert.deepEqual((await response.json()).media.map((m)=>m.name),["sting.wav"],"inventory lists the upload");

    // Duplicate names are refused, never silently overwritten.
    response=await fetch(base+"/api/media/sting.wav",{method:"POST",headers:{...auth,"Content-Type":"audio/wav"},body:wavBytes(100,9)});
    assert.equal(response.status,409,"existing names are not overwritten");
    assert.equal((await response.json()).error,"exists");
    response=await fetch(base+"/media/sting.wav");
    assert.equal((await response.arrayBuffer()).byteLength,payload.length,"original bytes survive the conflict");

    // Auth, names and content are enforced at the boundary.
    response=await fetch(base+"/api/media/fresh.wav",{method:"POST",headers:{"Content-Type":"audio/wav"},body:wavBytes(10)});
    assert.equal(response.status,401,"uploads need the publish token");
    response=await fetch(base+"/api/media/..%2Fevil.wav",{method:"POST",headers:{...auth,"Content-Type":"audio/wav"},body:wavBytes(10)});
    assert.equal(response.status,400,"traversal names are rejected");
    response=await fetch(base+"/api/media/tune.mp3",{method:"POST",headers:{...auth,"Content-Type":"audio/mpeg"},body:pngBytes(100)});
    assert.equal(response.status,400,"content must match the extension");
    response=await fetch(base+"/api/media/empty.wav",{method:"POST",headers:{...auth,"Content-Type":"audio/wav"},body:Buffer.alloc(0)});
    assert.equal(response.status,400,"empty uploads are rejected");
    await drain(response);

    // Oversize uploads die before touching the directory (raw request:
    // undici refuses to send a mismatched Content-Length itself).
    const oversizeStatus = await new Promise((resolve) => {
      const address = new URL(base);
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: Number(address.port),
          path: "/api/media/huge.webm",
          method: "POST",
          headers: {
            Authorization: "Bearer p-token",
            "Content-Type": "video/webm",
            "Content-Length": String(60 * 1024 * 1024),
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        }
      );
      req.on("error", () => resolve(-1));
      req.end(wavBytes(10));
    });
    assert.equal(oversizeStatus, 413, "declared oversize is rejected up front");
    response = await fetch(base + "/media/huge.webm");
    assert.equal(response.status, 404, "nothing was stored for the rejected upload");
    await drain(response);

    // Removal is explicit and authenticated.
    response=await fetch(base+"/api/media/sting.wav",{method:"DELETE"});
    assert.equal(response.status,401,"deletes need the publish token");
    response=await fetch(base+"/api/media/sting.wav",{method:"DELETE",headers:auth});
    assert.equal(response.status,200,"explicit delete removes the file");
    response=await fetch(base+"/media/sting.wav");
    assert.equal(response.status,404);
    response=await fetch(base+"/api/media/sting.wav",{method:"DELETE",headers:auth});
    assert.equal(response.status,404,"second delete reports missing");

    // Re-upload after delete works (the supported replace flow).
    response=await fetch(base+"/api/media/sting.wav",{method:"POST",headers:{...auth,"Content-Type":"audio/wav"},body:wavBytes(200,9)});
    assert.equal(response.status,201,"re-upload after delete succeeds");
    await drain(response);
    assert.deepEqual(residue(mediaDir),[],"no temp fragments remain");
  } finally {
    await relay.close();
  }
});

test("relay streams a 1 MB upload without buffering it whole", async () => {
  const mediaDir=mkdtempSync(join(tmpdir(),"reactions-"));
  const relay=createOverlayRelay({publishToken:"p-token",viewToken:"v-token",mediaDirectory:mediaDir});
  const address=await relay.listen(0);
  const base="http://127.0.0.1:"+address.port;
  try {
    const payload=wavBytes(1024*1024-44);
    const response=await fetch(base+"/api/media/big.wav",{method:"POST",
      headers:{Authorization:"Bearer p-token","Content-Type":"audio/wav"},body:payload});
    assert.equal(response.status,201);
    assert.equal((await response.json()).bytes,payload.length);
    const back=await fetch(base+"/media/big.wav");
    assert.deepEqual(Buffer.from(await back.arrayBuffer()),payload);
  } finally {
    await relay.close();
  }
});

test("relay cleans up after an aborted upload", async () => {
  const mediaDir=mkdtempSync(join(tmpdir(),"reactions-"));
  const relay=createOverlayRelay({publishToken:"p-token",viewToken:"v-token",mediaDirectory:mediaDir});
  const address=await relay.listen(0);
  const port=typeof address==="object"&&address?address.port:4190;
  try {
    await new Promise((resolve)=>{
      const req=httpRequest({host:"127.0.0.1",port,path:"/api/media/half.wav",method:"POST",
        headers:{Authorization:"Bearer p-token","Content-Type":"audio/wav","Content-Length":String(5*1024*1024)}},
        (res)=>{res.resume();res.on("end",resolve);});
      req.on("error",()=>resolve());
      req.write(wavBytes(1024));
      setTimeout(()=>req.destroy(),100);
      setTimeout(resolve,2000);
    });
    await new Promise((r)=>setTimeout(r,300));
    assert.deepEqual(residue(mediaDir),[],"aborted uploads leave no fragments");
    const missing=await fetch(`${"http://127.0.0.1"}:${port}/media/half.wav`);
    assert.equal(missing.status,404,"aborted uploads are never published");
    await missing.arrayBuffer().catch(()=>{});
  } finally {
    await relay.close();
  }
});
