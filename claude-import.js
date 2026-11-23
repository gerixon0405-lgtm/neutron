const fs=require("node:fs");
const fsp=require("node:fs/promises");
const path=require("node:path");
const os=require("node:os");
const crypto=require("node:crypto");
const {createInterface}=require("node:readline");

const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function desktopRoots(home=os.homedir(),env=process.env,platform=process.platform){
  const options=platform==="win32"?[env.APPDATA && path.join(env.APPDATA,"Claude")]:
    platform==="darwin"?[path.join(home,"Library","Application Support","Claude")]:
      [path.join(env.XDG_CONFIG_HOME || path.join(home,".config"),"Claude"),
        path.join(home,".var","app","com.anthropic.Claude","config","Claude")];
  return options.filter(Boolean).map(dir=>path.join(dir,"claude-code-sessions"));
}
async function names(dir){
  try {return await fsp.readdir(dir,{withFileTypes:true});}
  catch(error){if(["ENOENT","ENOTDIR","EACCES","EPERM"].includes(error.code))return [];throw error;}
}
function hasTranscript(projects,id){
  if(!uuid.test(id || ""))return false;
  try{return fs.readdirSync(projects).some(dir=>fs.statSync(path.join(projects,dir,id+".jsonl"),{throwIfNoEntry:false})?.isFile());}
  catch{return false;}
}
async function transcriptIndex(projects, ids){
  const byId=new Map();
  for (const dir of await names(projects)){
    if (!dir.isDirectory())continue;
    const folder=path.join(projects,dir.name);
    for (const file of await names(folder)){
      if(!file.isFile() || !file.name.endsWith(".jsonl"))continue;
      const id=file.name.slice(0,-6);
      if(ids.has(id) && !byId.has(id))byId.set(id,path.join(folder,file.name));
    }
  }
  return byId;
}
async function localSessions(account,roots=desktopRoots()){
  if(!account.loggedIn || !uuid.test(account.orgId || "") || !account.projectsDirectory || !path.isAbsolute(account.projectsDirectory))
    return [];
  const local=new Map();
  for(const root of roots){
    // Desktop stores local sessions under the user and organization directories.
    for(const profile of await names(root)){
      if(!profile.isDirectory() || !uuid.test(profile.name))continue;
      const folder=path.join(root,profile.name,account.orgId);
      for(const file of await names(folder)){
        if(!file.isFile() || !/^local_[a-z0-9-]+\.json$/i.test(file.name))continue;
        let details;
        try{details=JSON.parse(await fsp.readFile(path.join(folder,file.name),"utf8"));}catch{continue;}
        if(!details || typeof details!=="object")continue;
        const id=details.cliSessionId;
        if(!uuid.test(id || "") || typeof details.cwd!=="string" || !path.isAbsolute(details.cwd))continue;
        const time=Number(details.lastActivityAt || details.createdAt) || 0;
        if(local.get(id)?.time>time)continue;
        const model=String(details.model || "");
        local.set(id,{
          id,cwd:details.cwd,title:String(details.title || path.basename(details.cwd) || "Claude Code").trim().slice(0,160),
          time, archived:details.isArchived===true,
          model:/^(?:claude-[a-z0-9.-]+|opus|sonnet|haiku|fable)$/i.test(model)?model:"",
        });
      }
    }
  }
  const transcripts=await transcriptIndex(account.projectsDirectory,local);
  return [...local.values()].filter(record=>transcripts.has(record.id)).map(record=>({
    ...record,transcript:transcripts.get(record.id),
    available:!!fs.statSync(record.cwd,{throwIfNoEntry:false})?.isDirectory(),
  })).sort((a,b)=>b.time-a.time);
}

function display(row){
  if(row.isMeta || row.isVisibleInTranscriptOnly || row.isCompactSummary || row.isSidechain)return null;
  if(!["user","assistant"].includes(row.type) || !row.message)return null;
  const content=row.message.content;
  const text=typeof content==="string"?content:Array.isArray(content)?
    content.filter(block=>block.type==="text" && typeof block.text==="string").map(block=>block.text).join("\n\n"):"";
  if(!text.trim() || /^\s*<(?:local-command-|command-|bash-stdout>|bash-stderr>|system-reminder>)/.test(text))return null;
  return row.type==="user"?{role:"user",text}:{role:"assistant",blocks:[{type:"text",text}]};
}

async function readHistory(filename){
  const byId=new Map(), seen=[];
  let tip;
  const file=fs.createReadStream(filename,{encoding:"utf8"});
  const reader=createInterface({input:file,crlfDelay:Infinity});
  try{
    for await(const line of reader){
      let row;
      try{row=JSON.parse(line);}catch{continue;}
      if(row.isSidechain || !row.uuid)continue;
      const item=display(row);
      if(!byId.has(row.uuid))seen.push(row.uuid);
      byId.set(row.uuid,{parent:row.parentUuid || row.logicalParentUuid,item});
      if(row.type==="user" || row.type==="assistant")tip=row.uuid;
    }
  }finally{reader.close();file.destroy();}
  const branch=[];
  const visited=new Set();
  while(tip && byId.has(tip) && !visited.has(tip)){
    visited.add(tip);
    const {parent,item}=byId.get(tip);
    if(item)branch.push(item);
    tip=parent;
  }
  if(!branch.length) return seen.map(id=>byId.get(id).item).filter(Boolean);
  return branch.reverse();
}

function importedId(provider,orgId,sourceId){
  return "chat-import-"+crypto.createHash("sha256").update(JSON.stringify([provider,orgId,sourceId])).digest("hex").slice(0,32);
}
async function buildChat(provider,account,record){
  if(!record.available)throw Error("Az eredeti munkamappa jelenleg nem érhető el.");
  const items=await readHistory(record.transcript);
  if(!items.length)throw Error("A munkamenet nem tartalmaz importálható üzeneteket.");
  return {
    id:importedId(provider,account.orgId,record.id),title:record.title,cwd:record.cwd,provider,
    items,projectId:"",effort:"",mode:"default",model:record.model,sessionId:crypto.randomUUID(),
    claudeOrigin:{provider,orgId:account.orgId,sessionId:record.id},
  };
}
function resumeArgs(chat,projects){
  const {sessionId,claudeOrigin}=chat;
  if(!sessionId)return [];
  if(hasTranscript(projects,sessionId))return ["--resume",sessionId];
  if(claudeOrigin){
    if(!hasTranscript(projects,claudeOrigin.sessionId))
      throw Error("Az eredeti Claude Code-munkamenet már nem található.");
    return ["--resume",claudeOrigin.sessionId,"--fork-session","--session-id",sessionId];
  }
  return ["--session-id",sessionId];
}
module.exports={desktopRoots,localSessions,readHistory,buildChat,importedId,resumeArgs};
