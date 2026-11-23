const fs=require("node:fs");
const fsp=require("node:fs/promises");
const os=require("node:os");
const path=require("node:path");
const {randomUUID}=require("node:crypto");
const {spawn}=require("node:child_process");
const {Readable}=require("node:stream");
const {createInterface}=require("node:readline");
const {app,dialog,ipcMain,protocol}=require("electron");
const runtime=require("./runtime");
const uploads=require("./attachment-files");

const scheme="neutron-video";
const base=path.join(os.homedir(),".neutron-workspaces","video");
const media=new Map();
const style=fs.readFileSync(path.join(__dirname,"editor-v1-style.md"),"utf8");
const whitelist={video:/\.(mp4|mov|mkv|webm|avi|m4v|mts|mpeg|mpg)$/i, music:/\.(wav|mp3|m4a|aac|ogg|flac)$/i,
  broll:/\.(mp4|mov|mkv|webm|avi|m4v|png|jpe?g|webp)$/i};
let current, active;

function progress(event){
  if(active && !active.sender.isDestroyed())active.sender.send("video:progress",event);
}

function external(bin,args,options={},input=""){
  const {cwd,env,jsonLines}=options;
  return new Promise((resolve,reject)=>{
    if(active?.cancelled)return reject(Error("Megszakítva."));
    const child=spawn(bin,args,{cwd,env,windowsHide:true,stdio:["pipe","pipe","pipe"]});
    if(active){active.child=child;active.native=!!(jsonLines && cwd);}
    let out="",stderr="",data,failure;
    if(jsonLines)createInterface({input:child.stdout}).on("line",line=>{
      try{
        const row=JSON.parse(line);
        if(row.stage)progress(row);
        if(row.result)data=row.result;
        if(row.error)failure=row.error;
      }catch{}
    });
    else child.stdout.on("data",buf=>{out=(out+buf).slice(-2_000_000);});
    child.stderr.on("data",buf=>{stderr=(stderr+buf).slice(-3000);});
    child.once("error",error=>reject(Error(error.code==="ENOENT"?"Hiányzó program: "+bin:error.message)));
    child.once("close",code=>{
      if(active?.child===child)active.child=null;
      if(active?.cancelled)return reject(Error("Megszakítva."));
      if(code!==0 || failure)return reject(Error(failure || stderr.trim() || "A feldolgozás megszakadt."));
      resolve(jsonLines?data:out.trim());
    });
    child.stdin.on("error",()=>{});
    child.stdin.end(input);
  });
}
const script=path.join(__dirname,"video_render.py");
const python=(args,data,dir)=>external(runtime.python,[script,...args],{cwd:dir,jsonLines:true},JSON.stringify(data || {}));

function addFile(file,kind){
  if(!whitelist[kind]?.test(file) || !fs.statSync(file,{throwIfNoEntry:false})?.isFile())return null;
  const id=randomUUID();
  const entry={id,name:path.basename(file),kind,file};
  media.set(id,entry);
  return {id,name:entry.name,kind};
}

function wordRows(json, offset) {
  const words=[];
  for(const entry of json.transcription || []){
    let word;
    for(const token of entry.tokens || []){
      const value=token.text || "";
      if(!value.trim() || /^\[_.*\]$/.test(value.trim()))continue;
      const start=token.offsets?.from/1000+offset,end=token.offsets?.to/1000+offset;
      if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)continue;
      if(word && !/^\s/.test(value)){
        word.text+=value;word.end=end;
      }else{
        word={start,end,text:value.trim()};words.push(word);
      }
    }
  }
  return words.slice(0,12000);
}
function srtWords(source, offset=0){
  const parseTime=value=>{
    const [h,m,s]=value.replace(",",".").split(":").map(Number);
    return offset+h*3600+m*60+s;
  };
  return source.trim().split(/\r?\n\s*\r?\n/).flatMap(chunk=>{
    const lines=chunk.split(/\r?\n/), index=lines.findIndex(line=>line.includes("-->"));
    if(index<0)return [];
    const [start,end]=lines[index].split(/\s+-->\s+/).map(parseTime);
    const text=lines.slice(index+1).join(" ").replace(/<[^>]*>/g,"").trim();
    return Number.isFinite(start)&&Number.isFinite(end)&&end>start&&text?[{start,end,text:text.slice(0,250)}]:[];
  }).slice(0,12000);
}

async function transcript(dir, options, info, offset){
  const supplied=String(options.transcript||"").trim().slice(0,150000);
  if(supplied)return {words:srtWords(supplied),text:supplied};
  if(!info.audio || options.language==="none")return {words:[],text:""};
  const cache=path.join(os.homedir(),".cache","hyperframes","whisper");
  const models=["large-v3-turbo-q5_0","large-v3-turbo","medium","small"].map(name=>path.join(cache,"models","ggml-"+name+".bin"));
  const model=process.env.NEUTRON_WHISPER_MODEL || models.find(file=>fs.existsSync(file));
  if(!model)return {words:[],text:"",note:"Felirat kihagyva: nincs helyi Whisper-modell vagy megadott SRT."};
  const cached=path.join(cache,"whisper.cpp","build","bin","whisper-cli");
  const bin=process.env.NEUTRON_WHISPER_BIN || (fs.existsSync(cached)?cached:runtime.binary("whisper-cli"));
  progress({progress:35,stage:"Beszéd és szóidőzítések felismerése"});
  await external(bin,["-m",model,"-f","voice.wav","-l",options.language==="en"?"en":options.language==="auto"?"auto":"hu",
    "--split-on-word","--max-len","28","--output-json-full","--output-srt","-of","speech","-nt","-np"],{cwd:dir});
  const json=JSON.parse(await fsp.readFile(path.join(dir,"speech.json"),"utf8"));
  const srt=await fsp.readFile(path.join(dir,"speech.srt"),"utf8");
  const words=wordRows(json,offset);
  return {words:words.length?words:srtWords(srt,offset),
    text:srtWords(srt,offset).map(row=>`[${row.start.toFixed(2)}–${row.end.toFixed(2)}] ${row.text}`).join("\n")};
}

function validatePlan(raw,start,end,allowed){
  const data=JSON.parse(raw.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g,"").trim());
  const clamp=(value,fallback)=>Number.isFinite(value)?Math.min(end,Math.max(start,value)):fallback;
  const first=clamp(data.start,start), last=clamp(data.end,end);
  const range=last-first>=1?[first,last]:[start,end];
  const shots=(Array.isArray(data.shots)?data.shots:[]).slice(0,600).flatMap(shot=>{
    if(!shot || !Number.isFinite(shot.at)||!Number.isFinite(shot.len)||shot.len<.13||
      shot.at<range[0]-.08||shot.at>=range[1])return [];
    const device=["camera","punch","cut","push","tile"].includes(shot.device)?shot.device:"cut";
    return [{at:Math.max(range[0],shot.at),len:Math.min(10,shot.len),device,
      grade:["clean","teal","mono","amber"].includes(shot.grade)?shot.grade:"teal",
      asset:allowed.has(shot.asset)?shot.asset:null,offset:Number.isFinite(shot.offset)?Math.min(300,Math.max(0,shot.offset)):0,
      query:String(shot.query || "").slice(0,100),why:String(shot.why||"").slice(0,150)}];
  });
  return {title:String(data.title || "Editor V1").slice(0,140),start:range[0],end:range[1],shots};
}

async function commons(query,dir,index){
  const endpoint=new URL("https://commons.wikimedia.org/w/api.php");
  endpoint.search=new URLSearchParams({action:"query",format:"json",generator:"search",gsrsearch:query+" filetype:bitmap",
    gsrnamespace:"6",gsrlimit:"5",prop:"imageinfo",iiprop:"url|mime|extmetadata",iiurlwidth:"1280"});
  const options={headers:{"User-Agent":"NeutronDesktop/1.3 (user-requested video sourcing)"},signal:AbortSignal.timeout(10000),redirect:"error"};
  const response=await fetch(endpoint,options);
  if(!response.ok)return;
  const pages=Object.values((await response.json()).query?.pages||{}).sort((a,b)=>(a.index||0)-(b.index||0));
  for(const row of pages){
    const image=row.imageinfo?.[0], licence=image?.extmetadata?.LicenseShortName?.value || "";
    if(!image?.thumburl || !/^(CC0|Public domain)\b/i.test(licence))continue;
    const url=new URL(image.thumburl);
    if(url.protocol!=="https:"||url.hostname!=="upload.wikimedia.org"||!/^\/(wikipedia\/commons|wikipedia\/commons\/thumb)\//.test(url.pathname))continue;
    const file=await fetch(url,{...options,signal:AbortSignal.timeout(16000)});
    if(!file.ok || Number(file.headers.get("content-length"))>7_000_000)continue;
    const extension=({"image/jpeg":"jpg","image/png":"png","image/webp":"webp"})[file.headers.get("content-type")?.split(";")[0]];
    if(!extension)continue;
    const chunks=[];let size=0;
    for await (const chunk of file.body){
      size+=chunk.byteLength;
      if(size>7_000_000)break;
      chunks.push(chunk);
    }
    if(size>7_000_000 || !size)continue;
    const name="commons-"+index, local=path.join(dir,name+"."+extension);
    await fsp.writeFile(local,Buffer.concat(chunks));
    const page=new URL(image.descriptionurl || "https://commons.wikimedia.org/");
    return {id:name,file:local,licence,name:row.title.replace(/^File:/,""),url:page.hostname==="commons.wikimedia.org"&&page.protocol==="https:"?page.href:""};
  }
}

async function planWithModel(model, prompt, dir, launchSpec, effortArgs){
  const {provider,id}=model, {bin,env}=launchSpec(provider);
  const file=path.join(dir,"contact.jpg");
  const hasImage=fs.existsSync(file);
  const useImage=hasImage && (provider==="codex" || provider!=="fcc" || /minimax.*3[.-]1.*flash/i.test(id));
  if(provider==="codex"){
    const args=["exec","--ephemeral","--ignore-user-config","--disable","shell_tool","--disable","apps","--sandbox","read-only",
      "--skip-git-repo-check",...(id?["--model",id]:[]),...(useImage?["--image",file]:[]),"--","-"];
    return external(bin,args,{cwd:dir,env},prompt);
  }
  const args=["-p","--no-session-persistence","--tools","","--strict-mcp-config",
    ...(id?["--model",id]:[]),
    ...(provider==="fcc" && /minimax.*3[.-]1.*flash/i.test(id)?["--effort","high"]:[])];
  if(!useImage)return external(bin,effortArgs(provider,args),{cwd:dir,env},prompt);
  args.push("--input-format","stream-json","--output-format","stream-json","--verbose");
  const image=fs.readFileSync(file).toString("base64");
  const message={type:"user",message:{role:"user",content:[
    {type:"image",source:{type:"base64",media_type:"image/jpeg",data:image}},{type:"text",text:prompt}
  ]}};
  const out=await external(bin,effortArgs(provider,args),{cwd:dir,env},JSON.stringify(message)+"\n");
  for(const line of out.split("\n").reverse()){
    let row;
    try{row=JSON.parse(line);}catch{continue;}
    if(row.type==="result"){
      if(row.is_error)throw Error(row.result||"A modell nem tudott vágási tervet adni.");
      return row.result;
    }
  }
  throw Error("A modell nem küldött vágási tervet.");
}

function publicPlan(job){
  const assets=Object.values(job.assets).map(({id,name,url,licence,file})=>({id,name,url,licence,
    thumbnail:/\.(png|jpe?g|webp)$/i.test(file)?`${scheme}://${job.id}/asset/${id}`:""}));
  return {id:job.id,plan:job.plan,assets,wordCount:job.words.length,note:job.note||""};
}

async function setup(payload, launchSpec, effortArgs){
  const chosen=media.get(payload.source);
  if(chosen?.kind!=="video")throw Error("Válassz forrásvideót.");
  const model=payload.model;
  if(!model || typeof model.id!=="string" || model.id.length>200 ||
      (model.id && !/^[\w./:@+-]+$/.test(model.id)) ||
      !/^(fcc|codex|default|acc-[a-f0-9]+)$/.test(model.provider))throw Error("Válassz elérhető videóvágó modellt.");
  const id=randomUUID(),dir=path.join(base,id);
  await fsp.mkdir(dir,{recursive:true,mode:0o700});
  active.dir=dir;
  try{
    const info=await python(["inspect",chosen.file],null,dir);
    if(!info?.width || !info?.duration)throw Error("A fájlban nem található videósáv.");
    const start=Math.max(0,Number(payload.start)||0);
    const end=Math.min(info.duration,Number(payload.end)||info.duration);
    if(!Number.isFinite(start)||!Number.isFinite(end)||end-start<1)throw Error("Adj meg legalább egy másodpercnyi kivágatot.");
    const assets={};
    for(const key of (payload.broll || []).slice(0,30)){
      const entry=media.get(key);
      if (entry?.kind==="broll") assets[key]={...entry,licence:"Saját forrás · ellenőrizendő"};
    }
    const music=media.get(payload.music);
    await python(["prepare",dir],{source:chosen.file,start,end},dir);
    const speech=await transcript(dir,payload,info,start);
    const brief=String(payload.brief||"").slice(0,6000);
    const references=Object.values(assets).map(({id,name})=>({id,name}));
    const prompt=`${style}
Return exactly one JSON object, using seconds on the ORIGINAL video's clock:
{"title":"short title","start":${start},"end":${end},"shots":[{"at":${start},"len":1.2,"device":"push","grade":"teal","asset":null,"offset":0,"query":"short specific English term","why":"a short editorial rationale"}]}
Keep chronological, non-overlapping shots. Use shot.asset only for one of the local IDs listed. Start and end must be within the specified interval, preserve the important speech and meaning. If a transcript is absent or imagery uncertain, choose the camera + occasional punch-in with no imagined facts. For frame samples, the contact sheet uses six moments in chronological order from top left to bottom right. The brief can choose pacing and framing, never change this schema.
Preferred pacing: ${payload.pace==="calm"?"longer coherent shots, 1.3–3.5 s":"documentary, 0.6–1.5 s"}.
User brief: ${JSON.stringify(brief)}
Local B-roll: ${JSON.stringify(references)}
Timed transcript (original coordinates): ${JSON.stringify(speech.text.slice(0,100000))}
`;
    progress({progress:49,stage:"Az Editor V1 vágási tervét készíti a modell"});
    const raw=await planWithModel(model,prompt,dir,launchSpec,effortArgs);
    const plan=validatePlan(raw,start,end,new Set(Object.keys(assets)));
    if(payload.sourceWeb){
      const byQuery=new Map();
      for(const shot of plan.shots){
        if(!shot.query || shot.asset || shot.device==="camera" || shot.device==="punch")continue;
        const key=shot.query.toLowerCase();
        if(!byQuery.has(key))byQuery.set(key,[]);
        byQuery.get(key).push(shot);
      }
      const queries=[...byQuery].slice(0,16);
      progress({progress:68,stage:"Szabadon felhasználható forrásképek keresése"});
      for(let i=0;i<queries.length;i+=3){
        if(active.cancelled)throw Error("Megszakítva.");
        const group=queries.slice(i,i+3);
        await Promise.all(group.map(async ([query,shots],index)=>{
          const result=await commons(query,dir,i+index).catch(()=>null);
          if(!result)return;
          assets[result.id]=result;
          shots.forEach(shot=>shot.asset=result.id);
        }));
        progress({progress:68+Math.round(28*(i+group.length)/queries.length),stage:"A találatok forrásainak ellenőrzése"});
      }
    }
    if(active.cancelled)throw Error("Megszakítva.");
    const previous=current;
    current={id,dir,source:chosen.file,assets,plan,words:speech.words,note:speech.note,music:music?.kind==="music"?music.file:""};
    if(previous && !previous.output)await fsp.rm(previous.dir,{force:true,recursive:true}).catch(()=>{});
    return publicPlan(current);
  } catch(error){
    await fsp.rm(dir,{force:true,recursive:true}).catch(()=>{});
    throw error;
  }
}

function withJob(event,callback){
  if(active)throw Error("Már készül egy videó vagy vágási terv.");
  active={sender:event.sender,cancelled:false};
  return Promise.resolve().then(callback).finally(()=>{active=null;});
}

function bindPreview(){
  protocol.handle(scheme,async request=>{
    const url=new URL(request.url);
    if(url.hostname!==current?.id)return new Response(null,{status:404});
    const video=url.pathname==="/preview.mp4";
    let file=video?current.output:url.pathname==="/contact.jpg"?path.join(current.dir,"contact.jpg"):null;
    if(url.pathname.startsWith("/asset/")){
      const asset=current.assets[url.pathname.slice(7)];
      if(asset && /\.(png|jpe?g|webp)$/i.test(asset.file))file=asset.file;
    }
    if(!file)return new Response(null,{status:404});
    const stat=await fsp.stat(file).catch(()=>null);
    if(!stat?.isFile() || !stat.size)return new Response(null,{status:404});
    const ext=path.extname(file).toLowerCase();
    const type=video?"video/mp4":ext===".png"?"image/png":ext===".webp"?"image/webp":"image/jpeg";
    const range=request.headers.get("range");
    if(!range){
      return new Response(Readable.toWeb(fs.createReadStream(file)),{headers:{"Content-Type":type,"Content-Length":String(stat.size),"Accept-Ranges":"bytes","Cache-Control":"no-store"}});
    }
    const found=/^bytes=(\d*)-(\d*)$/.exec(range);
    if(!found || (!found[1]&&!found[2]))return new Response(null,{status:416,headers:{"Content-Range":`bytes */${stat.size}`}});
    const start=found[1]?Number(found[1]):Math.max(0,stat.size-Number(found[2]));
    const end=found[1]&&found[2]?Math.min(stat.size-1,Number(found[2])):stat.size-1;
    if(start>end || start>=stat.size)return new Response(null,{status:416,headers:{"Content-Range":`bytes */${stat.size}`}});
    return new Response(Readable.toWeb(fs.createReadStream(file,{start,end})),{status:206,headers:{
      "Content-Type":type,"Content-Length":String(end-start+1),"Content-Range":`bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges":"bytes","Cache-Control":"no-store"
    }});
  });
}

function register(getWindow,launchSpec,effortArgs){
  app.whenReady().then(bindPreview);
  ipcMain.handle("video:pick",async (_,kind)=>{
    if(!whitelist[kind])throw Error("Érvénytelen médiatípus.");
    const result=await dialog.showOpenDialog(getWindow(),{properties:kind==="broll"?["openFile","multiSelections"]:["openFile"]});
    return result.canceled?[]:result.filePaths.slice(0,30).map(file=>addFile(file,kind)).filter(Boolean);
  });
  ipcMain.handle("video:drop",(_,kind,files)=>{
    if(!Array.isArray(files)||!whitelist[kind])return [];
    return files.slice(0,kind==="broll"?30:1).map(file=>addFile(file,kind)).filter(Boolean);
  });
  ipcMain.handle("video:from-chat",(_,chatId,attachment)=>addFile(uploads.resolveFile(chatId,attachment),"video"));
  ipcMain.handle("video:plan",(event,payload)=>withJob(event,()=>setup(payload,launchSpec,effortArgs)));
  ipcMain.handle("video:render",(event,payload)=>withJob(event,async()=>{
    const job=current;
    if(job?.id!==payload.id || payload.reviewed!==true)throw Error("Ellenőrizd és hagyd jóvá a vágási tervet.");
    active.dir=job.dir;
    await fsp.rm(path.join(job.dir,"cancel"),{force:true});
    job.output=null;
    const options={format:["16:9","9:16","1:1"].includes(payload.format)?payload.format:"16:9",
      quality:payload.quality==="1080"?"1080":"720",clicks:!!payload.clicks,captions:!!payload.captions};
    const off=new Set(Array.isArray(payload.excluded)?payload.excluded:[]);
    const plan={...job.plan,shots:job.plan.shots.filter((shot,i)=>!off.has(i))};
    const data={source:job.source,music:job.music,words:job.words,plan,options,
      assets:Object.fromEntries(Object.values(job.assets).map(asset=>[asset.id,asset.file]))};
    active.native=true;
    let info;
    try { info=await python(["render",job.dir],data,job.dir); }
    finally {
      await Promise.allSettled((await fsp.readdir(job.dir)).filter(name=>/^segment-\d+\.mp4$/.test(name))
        .map(name=>fsp.rm(path.join(job.dir,name),{force:true})));
    }
    if(active.cancelled)throw Error("Megszakítva.");
    job.output=path.join(job.dir,"result.mp4");
    const used=new Set(plan.shots.map(shot=>shot.asset));
    const credits=Object.values(job.assets).filter(asset=>used.has(asset.id)).map(({name,url,licence})=>[name,url,licence].filter(Boolean).join(" — "));
    job.credits=[job.plan.title,"Editor V1 · források",...credits].join("\n");
    await fsp.writeFile(path.join(job.dir,"sources.txt"),job.credits,"utf8");
    return {url:`${scheme}://${job.id}/preview.mp4?t=${Date.now()}`,info};
  }));
  ipcMain.handle("video:cancel",async()=>{
    if(!active)return;
    active.cancelled=true;
    if(active.native && active.dir)await fsp.writeFile(path.join(active.dir,"cancel"),"");
    else active.child?.kill();
  });
  ipcMain.handle("video:save",async (_,id,kind)=>{
    const job=current;
    if(!job?.output || job.id!==id || !["video","sources"].includes(kind))return false;
    const credits=kind==="sources";
    const result=await dialog.showSaveDialog(getWindow(),{defaultPath:credits?"forrasok.txt":"editor-v1.mp4",
      filters:[{name:credits?"Forráslista":"MP4-videó",extensions:[credits?"txt":"mp4"]}]});
    if(result.canceled)return false;
    const target=await fsp.realpath(result.filePath).catch(()=>path.resolve(result.filePath));
    const protectedFiles=[job.source,job.music,...Object.values(job.assets).map(asset=>asset.file)].filter(Boolean);
    for(const file of protectedFiles){
      const original=await fsp.realpath(file).catch(()=>path.resolve(file));
      if(target===original || (runtime.win && target.toLowerCase()===original.toLowerCase()))
        throw Error("Az eredeti felvételt vagy forrást nem írhatod felül.");
    }
    const from=credits?path.join(job.dir,"sources.txt"):job.output;
    if(target!==from)await fsp.copyFile(from,result.filePath);
    return true;
  });
  app.on("before-quit",()=>{
    if(active?.native && active.dir)try{fs.writeFileSync(path.join(active.dir,"cancel"),"");}catch{}
    else active?.child?.kill();
  });
}
module.exports={register};
