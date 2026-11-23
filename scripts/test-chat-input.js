const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {isRateLimit,rateRetryDecision,RATE_RETRY_DELAY}=require("../retry-policy");
(async()=>{
  for(const error of ["429 Too Many Requests","API Error: 429",'{"status": 429}',{type:"rate_limit_error"},"HTTP status 429"])
    assert.ok(isRateLimit(error),JSON.stringify(error));
  for(const error of ["A művelet sikerült: 429 találat","HTTP 401","Timeout"])assert.ok(!isRateLimit(error));
  assert.equal(RATE_RETRY_DELAY,60000);
  for(let n=1;n<10;n++)assert.equal(rateRetryDecision(n,false),"wait");
  assert.equal(rateRetryDecision(10,false),"limit");
  assert.equal(rateRetryDecision(1,true),"effects");
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),"neutron-input-test-"));
  process.env[process.platform==="win32"?"USERPROFILE":"HOME"]=folder;
  try {
    const files=require("../attachment-files");
    const input=path.join(folder,"jegyzet ékezet.txt");
    fs.writeFileSync(input,"árvíztűrő");
    const [row]=await files.importFiles("chat-a",[input]);
    fs.writeFileSync(input,"Ez már az új tartalom");
    assert.equal(fs.readFileSync(files.resolveFile("chat-a",row),"utf8"),"árvíztűrő");
    assert.equal(row.name,"jegyzet ékezet.txt");
    assert.throws(()=>files.resolveFile("chat-b",row));
    assert.throws(()=>files.resolveFile("chat-a",{id:"../jegyzet.txt"}));
    await assert.rejects(files.importFiles("chat-a",[folder]));
    await files.removeChat("chat-a");
    assert.throws(()=>files.resolveFile("chat-a",row));
  } finally { fs.rmSync(folder,{recursive:true,force:true}); }
})().catch(error=>{console.error(error);process.exitCode=1;});
