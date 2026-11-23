const assert=require("node:assert/strict");
const fs=require("node:fs/promises");
const path=require("node:path");
const os=require("node:os");
const api=require("../claude-import");

(async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"neutron-claude-import-"));
  try{
    const profile="00112233-4455-4677-8899-aabbccddeeff", org="abcdef01-2345-4678-9876-123456789abc";
    const other="12345678-1234-4567-8abc-123456789abc";
    const source="86016466-b7d2-43c7-a366-4c9000e6bd98",missing="cbb48226-844e-4bc5-b55b-2a07b18a4425";
    const desktop=path.join(root,"desktop"), projects=path.join(root,"projects"), cwd=path.join(root,"munkamappa");
    const project=path.join(projects,"munkamappa");
    for(const directory of [path.join(desktop,profile,org),path.join(desktop,profile,other),cwd,project])await fs.mkdir(directory,{recursive:true});
    const metadata={cliSessionId:source,cwd,title:"Helyi tesztchat",lastActivityAt:30,model:"sonnet"};
    await fs.writeFile(path.join(desktop,profile,org,"local_one.json"),JSON.stringify(metadata));
    await fs.writeFile(path.join(desktop,profile,org,"local_missing.json"),JSON.stringify({...metadata,cliSessionId:missing}));
    await fs.writeFile(path.join(desktop,profile,org,"remote_one.json"),JSON.stringify({...metadata,title:"Nem helyi"}));
    await fs.writeFile(path.join(desktop,profile,other,"local_other.json"),JSON.stringify({...metadata,title:"Másik szervezet"}));
    const transcript=path.join(project,source+".jsonl");
    const rows=[
      {uuid:"user1",type:"user",message:{content:"Tesztkérdés"}},
      {uuid:"drop",parentUuid:"user1",type:"assistant",message:{content:[{type:"text",text:"Elvetett ág"}]}},
      {uuid:"meta",parentUuid:"user1",type:"user",isMeta:true,message:{content:"Belső meta"}},
      {uuid:"assistant",parentUuid:"meta",type:"assistant",message:{content:[{type:"thinking",thinking:"Privát"},{type:"text",text:"Tesztválasz"}]}},
      {uuid:"side",parentUuid:"user1",type:"assistant",isSidechain:true,message:{content:"Mellékág"}},
    ];
    const backing=rows.map(row=>JSON.stringify(row)).join("\n")+"\n";
    await fs.writeFile(transcript,backing);
    const account={loggedIn:true,orgId:org,projectsDirectory:projects};
    assert.deepEqual(await api.localSessions({...account,orgId:null},[desktop]),[]);
    const [record,...extra]=await api.localSessions(account,[desktop]);
    assert.ok(!extra.length && record.available);
    assert.equal(record.title,"Helyi tesztchat");
    const chat=await api.buildChat("default",account,record);
    assert.equal(chat.claudeOrigin.sessionId,source);
    assert.equal(chat.id,api.importedId("default",org,source));
    assert.equal(chat.cwd,cwd);
    assert.equal(chat.items[0].text,"Tesztkérdés");
    assert.equal(chat.items[1].blocks[0].text,"Tesztválasz");
    assert.equal(chat.items.length,2);
    assert.deepEqual(api.resumeArgs(chat,projects),["--resume",source,"--fork-session","--session-id",chat.sessionId]);
    await fs.writeFile(path.join(project,chat.sessionId+".jsonl"),backing);
    assert.deepEqual(api.resumeArgs(chat,projects),["--resume",chat.sessionId]);
    assert.equal(await fs.readFile(transcript,"utf8"),backing);
    assert.deepEqual(api.resumeArgs({sessionId:missing},projects),["--session-id",missing]);
  }finally{await fs.rm(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
