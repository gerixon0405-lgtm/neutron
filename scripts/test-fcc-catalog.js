const assert = require("node:assert/strict");
const {listModels} = require("../fcc-catalog");
const names = ["nvidia_nim/nvidia/nemotron-3.5-super", ...Array.from({length:19}, (_,i) => "provider/model-"+i)];
async function check() {
  const endpoints = {
    "/admin/api/models": {models:names},
    "/v1/models?view=messages": {data:[{id:"chat-alias",provider_model_ref:names[1]}]},
    "/v1/models?view=responses": {data:[{id:"response-alias",provider_model_ref:names[1],reasoningEfforts:["high"]}]},
  };
  const read = () => listModels("", async url => ({ok:!!endpoints[url],status:404,json:async()=>endpoints[url]}));
  const catalog = await read();
  assert.equal(catalog.length,20);
  assert.ok(catalog.some(m => m.id === names[0]));
  assert.deepEqual(catalog.find(m => m.id === "chat-alias").levels,["high"]);
  delete endpoints["/admin/api/models"];
  assert.equal((await read()).length,1);
  delete endpoints["/v1/models?view=messages"];
  assert.equal((await read())[0].id,"response-alias");
  delete endpoints["/v1/models?view=responses"];
  await assert.rejects(read,/404/);
}
check().catch(err => {console.error(err);process.exitCode=1;});
