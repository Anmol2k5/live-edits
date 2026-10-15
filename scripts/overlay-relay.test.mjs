import { test } from "node:test";
import assert from "node:assert/strict";
import { createOverlayRelay } from "./overlay-relay.mjs";

test("local OBS bridge authenticates, validates and delivers a reaction", async () => {
  const relay=createOverlayRelay({publishToken:"publish-test-token",viewToken:"view-test-token"});
  const address=await relay.listen(0);
  const base="http://127.0.0.1:"+address.port;
  const controller=new AbortController();

  try {
    let response=await fetch(base+"/overlay");
    assert.equal(response.status,403,"overlay view token is required");
    response=await fetch(base+"/overlay?token=view-test-token");
    assert.equal(response.status,200);
    assert.match(await response.text(),/OBS Overlay/);

    response=await fetch(base+"/api/trigger",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({moment:"wow"})});
    assert.equal(response.status,401,"publishing requires its own secret");

    response=await fetch(base+"/api/trigger",{
      method:"POST",headers:{Authorization:"Bearer publish-test-token","Content-Type":"application/json"},
      body:JSON.stringify({moment:"wow",templateId:"sad-1"})});
    assert.equal(response.status,400,"mismatched template should be rejected");

    response=await fetch(base+"/api/trigger",{
      method:"POST",headers:{Authorization:"Bearer publish-test-token","Content-Type":"application/json"},
      body:JSON.stringify({moment:"wow",mediaFile:"../wrong.mp4"})});
    assert.equal(response.status,400,"media path traversal should be rejected");

    response=await fetch(base+"/api/trigger",{
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

    response=await fetch(base+"/templates/wow-1.png");
    assert.equal(response.status,200);
    assert.equal(response.headers.get("content-type"),"image/png");

    response=await fetch(base+"/media/..%2Fsecret.mp4");
    assert.equal(response.status,404);
  } finally {
    controller.abort();
    await relay.close();
  }
});
