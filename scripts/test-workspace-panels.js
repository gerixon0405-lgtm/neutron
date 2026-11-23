const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {claudeReport,codexReport,readRollout,compactTokens}=require("../chat-context");

async function test() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"neutron-workspace-test-"));
  process.env.HOME=process.env.USERPROFILE=root;
  try {
    const workspaces=require("../workspaces");
    const project=workspaces.createProject("Tesztprojekt");
    const chat={id:"chat-abc",title:"Tesztchat"};
    const archived={id:"chat-import-old",title:"Archivált chat"};
    workspaces.createArtifact({projectId:project.id},"oldal.html","<h1>Oldal</h1>");
    workspaces.createArtifact(chat,"adat.csv","név,érték");
    workspaces.createArtifact(archived,"jegyzet.md","# Jegyzet");
    const rows=workspaces.artifactCatalog([chat]);
    assert.equal(rows.length,3);
    const names=Object.fromEntries(rows.map(row=>[row.name,row]));
    assert.equal(names["oldal.html"].title,"Tesztprojekt");
    assert.equal(names["adat.csv"].title,"Tesztchat");
    assert.equal(names["jegyzet.md"].title,"Korábbi csevegés");
    assert.deepEqual(await workspaces.artifactCover(names["oldal.html"].scope,"oldal.html"),{text:"<h1>Oldal</h1>"});
    assert.throws(()=>workspaces.createArtifact(chat,"adat.csv","replace"),/már van/);
    assert.throws(()=>workspaces.createArtifact(chat,"../adat.csv","invalid"),/érvényes/);
    assert.throws(()=>workspaces.listFiles({libraryKey:"../adat"}),/Érvénytelen/);

    const counts={last_token_usage:{total_tokens:20000},total_token_usage:{total_tokens:100000},model_context_window:400000};
    assert.deepEqual(codexReport(counts),{used:20000,max:400000,categories:[],groups:[]});
    const log=path.join(root,"rollout.jsonl");
    fs.writeFileSync(log,JSON.stringify({type:"event_msg",payload:{type:"token_count",info:counts}})+'\n{"incomplete":');
    assert.deepEqual(await readRollout(log),codexReport(counts));
    const report=claudeReport({totalTokens:12000,maxTokens:100000,autoCompactThreshold:80000,
      categories:[{name:"Messages",tokens:12000,kind:"used"}],memoryFiles:[{path:"CLAUDE.md",tokens:10}]});
    assert.equal(report.compactAt,80000);
    assert.deepEqual(report.categories,[{name:"Messages",tokens:12000,kind:"used"}]);
    assert.deepEqual(report.groups[1].rows,[{name:"CLAUDE.md",tokens:10}]);
    assert.equal(compactTokens(100000),100000);
    assert.equal(compactTokens("400000"),0);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
}
test().catch(error=>{console.error(error);process.exitCode=1;});
