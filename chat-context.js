const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const { randomUUID } = require("node:crypto");

function claudeReport(value) {
  if (!Number.isFinite(value?.totalTokens) || !(value.maxTokens > 0)) return null;
  return {
    used: value.totalTokens, max: value.maxTokens,
    compactAt: value.autoCompactThreshold,
    categories: (value.categories || []).map(row => ({name:row.name, tokens:row.tokens, kind:row.kind})),
    groups: [
      {name:"MCP-eszközök", rows:(value.mcpTools || []).map(row => ({name:row.name, tokens:row.tokens}))},
      {name:"Memóriafájlok", rows:(value.memoryFiles || []).map(row => ({name:row.path, tokens:row.tokens}))},
    ],
  };
}

function claudeContext(child, isolated = false, detail = "summary") {
  const requestId = "neutron-context-" + randomUUID();
  return new Promise((resolve, reject) => {
    let settled=false;
    function finish(error, data) {
      if(settled)return;
      settled=true;
      clearTimeout(timer);
      child.removeListener("neutron-control", receive);
      child.removeListener("close", closed);
      child.removeListener("error", closed);
      if (isolated) child.kill();
      if (error) reject(Error(error)); else resolve(claudeReport(data));
    }
    function closed() { finish("A Claude Code nem adott kontextusjelentést."); }
    function receive(packet) {
      if (packet?.request_id !== requestId) return;
      finish(packet.subtype === "success" ? "" : "A Claude Code nem adott kontextusjelentést.", packet.response);
    }
    const timer = setTimeout(closed, 15000);
    child.on("neutron-control", receive);
    child.once("close", closed);
    child.once("error", closed);
    const send = message => child.stdin.write(JSON.stringify(message) + "\n", error => {if (error) closed();});
    if (isolated) {
      createInterface({input:child.stdout}).on("line", line => {
        try { const event=JSON.parse(line); if(event.type==="control_response") receive(event.response); } catch {}
      });
      child.stdin.on("error", () => {});
      send({type:"control_request", request_id:requestId+"-init", request:{subtype:"initialize"}});
    }
    send({type:"control_request", request_id:requestId, request:{subtype:"get_context_usage",detail}});
  });
}

function codexReport(info) {
  const used = info?.last_token_usage?.total_tokens;
  const max = info?.model_context_window;
  return Number.isFinite(used) && used >= 0 && max > 0 ? {used, max, categories:[], groups:[]} : null;
}

async function readRollout(filename) {
  const file = await fs.open(filename,"r");
  try {
    const size = (await file.stat()).size;
    const length = Math.min(size, 4*1024*1024);
    const buffer = Buffer.alloc(length);
    const {bytesRead} = await file.read(buffer,0,length,size-length);
    for (const line of buffer.toString("utf8",0,bytesRead).split("\n").reverse()) {
      if (!line.includes('"token_count"')) continue;
      try {
        const row = JSON.parse(line);
        if (row.type !== "event_msg" || row.payload?.type !== "token_count") continue;
        const report = codexReport(row.payload.info);
        if (report) return report;
      } catch {}
    }
    return null;
  } finally { await file.close(); }
}

function codexProcess(bin, options, onMessage, done, timeout) {
  const child = spawn(bin, ["app-server","--listen","stdio://",...options], {windowsHide:true,stdio:["pipe","pipe","ignore"]});
  let settled = false;
  const timer = setTimeout(() => finish(Error("A Codex nem válaszolt időben.")), timeout);
  function finish(error, result) {
    if (settled) return;
    settled=true;
    clearTimeout(timer);
    if(child.exitCode===null) child.kill();
    done(error, result);
  }
  const send = (method,id,params) => child.stdin.write(JSON.stringify({method,id,params})+"\n");
  child.stdin.on("error", () => {});
  child.once("error", error => finish(error));
  child.once("close", (code, signal) => finish(signal ? null : Error("A Codex-kapcsolat megszakadt.")));
  createInterface({input:child.stdout}).on("line", line => {
    if (settled) return;
    let event;
    try { event=JSON.parse(line); } catch { return; }
    if (!event) return;
    if (event.error) return finish(Error(event.error.message || "A Codex nem tudta végrehajtani a műveletet."));
    if (event.id===1) send("initialized");
    onMessage(event,send,finish);
  });
  send("initialize",1,{clientInfo:{name:"neutron",title:"Neutron",version:require("./package.json").version}});
  return child;
}

async function codexContext(bin, id) {
  if (!/^[a-f0-9-]{36}$/i.test(id || "")) return null;
  const filename = await new Promise((resolve,reject) => codexProcess(bin, [], (event,send,finish) => {
    if (event.id===1) send("thread/read",2,{threadId:id});
    if (event.id===2) finish(null,event.result?.thread?.path);
  }, (error,result)=>error?reject(error):resolve(result), 10000));
  if (!filename || !path.basename(filename).endsWith(id+".jsonl")) return null;
  const root = await fs.realpath(process.env.CODEX_HOME || path.join(os.homedir(),".codex"));
  const file = await fs.realpath(filename);
  if (!["sessions","archived_sessions"].some(dir=>file.startsWith(path.join(root,dir)+path.sep))) return null;
  return readRollout(file);
}

function compactCodex(bin, chat, done) {
  const options = chat.autoCompactTokens ? ["-c","model_auto_compact_token_limit="+chat.autoCompactTokens] : [];
  return codexProcess(bin, options, (event,send,finish) => {
    if (event.id===1) send("thread/resume",2,{threadId:chat.codexThread,...(chat.model?{model:chat.model}:{}),
      cwd:chat.cwd,approvalPolicy:"never",sandbox:"read-only"});
    if (event.id===2) send("thread/compact/start",3,{threadId:chat.codexThread});
    if (event.method==="turn/completed" && event.params?.threadId===chat.codexThread) {
      const turn=event.params.turn;
      finish(turn.status==="completed" ? null : Error(turn.error?.message || "A kontextus tömörítése megszakadt."));
    }
  }, done, 180000);
}

const compactTokens = (value) => Number.isInteger(value) && value>=100000 && value<=2000000 ? value : 0;
module.exports={claudeContext,claudeReport,codexReport,readRollout,codexContext,compactCodex,compactTokens};
