"use strict";
let selectedVideo, selectedMusic, videoBroll=[], videoJob, videoRunning=false;
let videoStarted, videoClockInterval;
const disabledDuringVideo=["videoPick","videoBroll","videoMusic","videoModel","videoBrief","videoPace","videoLanguage",
  "videoStart","videoEnd","videoTranscript","videoSourceWeb","videoRender","videoFormat","videoQuality","videoCaptions","videoClicks"];

function fillVideoModels(){
  const select=$("#videoModel"), value=select.value;
  const first=models.find(model=>/minimax.*3[.-]1.*flash/i.test(model));
  const picks=[];
  if(first)picks.push(["fcc",first,"MiniMax M3.1 Flash · Free Claude Code"]);
  for(const model of models)if(model!==first)picks.push(["fcc",model,shortModel(model)+" · Free Claude Code"]);
  picks.push(["codex","","Alapmodell · Codex"]);
  for(const model of codexModels)picks.push(["codex",model,model+" · Codex"]);
  for(const account of accounts()) {
    for(const [id,label] of CLAUDE_MODELS)picks.push([account.id,id,label+" · "+account.name]);
  }
  select.replaceChildren(...picks.map(([provider,id,label])=>new Option(label,JSON.stringify({provider,id}))));
  if([...select.options].some(option=>option.value===value))select.value=value;
  if (first && !select.dataset.userPicked) select.value=JSON.stringify({provider:"fcc",id:first});
}
$("#videoModel").onchange=()=>{$("#videoModel").dataset.userPicked="yes";};
function enterVideoEditor(){
  fillVideoModels();
  if(!models.length)refreshModels().catch(()=>{});
}
function videoState(message,percent){
  $("#videoStatus").textContent=message;
  $("#videoProgress").hidden=percent==null;
  if(percent!=null)$("#videoProgress").value=percent;
}
function busyVideo(busy){
  const clock=$("#videoClock"), time=clock.querySelector("time");
  if(busy && !videoRunning){
    videoStarted=Date.now();
    clock.hidden=false;
    time.textContent="0:00";
    videoClockInterval=setInterval(()=>{time.textContent=elapsedTime(Date.now()-videoStarted);},1000);
  }else if(!busy){
    clearInterval(videoClockInterval);
    if(videoRunning)time.textContent=elapsedTime(Date.now()-videoStarted);
  }
  clock.classList.toggle("running",busy);
  videoRunning=busy;
  $("#cancelVideo").hidden=!busy;
  for(const id of disabledDuringVideo)$("#"+id).disabled=busy;
  $("#videoPlan").disabled=busy || !selectedVideo;
  $("#videoShots").querySelectorAll("input").forEach(input=>input.disabled=busy);
}
function selectedSource(value){
  selectedVideo=value;
  $("#videoSource").textContent=value.name;
  resetReview();
  $("#videoClock").hidden=true;
  videoState("Add meg a vágási instrukciót, majd készíts tervet.");
  busyVideo(false);
}
async function openVideoFromChat(chatId,text,files){
  setView("video");
  if(videoRunning){toast("Már folyamatban van egy videós művelet.");return;}
  $("#videoBrief").value=text.replace(/^\/(?:vide[oó]|v[aá]g[aá]s)\b\s*/iu,"");
  resetReview();
  for(const file of files){
    if(!/\.(mp4|mov|mkv|webm|avi|m4v|mts|mpeg|mpg)$/i.test(file.name))continue;
    try {
      const entry=await N.video.fromChat(chatId,file);
      if(entry){selectedSource(entry);break;}
    }catch(error){videoState(error.message);}
  }
  $("#videoBrief").focus();
}
function resetReview(){
  videoJob=null;
  $("#videoReview").hidden=$("#videoExport").hidden=true;
  const player=$("#videoPlayer");
  player.pause(); player.removeAttribute("src");player.load();
}
async function pickVideoItem(kind){
  try {
    const items=await N.video.pick(kind);
    if(!items.length)return;
    if(kind==="video")return selectedSource(items[0]);
    if(kind==="music")selectedMusic=items[0];
    else videoBroll=items;
    $("#videoExtras").textContent=[...videoBroll.map(clip=>clip.name),selectedMusic?.name].filter(Boolean).join(" · ");
    resetReview();
  } catch(error){videoState(error.message);}
}
$("#videoPick").onclick=()=>pickVideoItem("video");
$("#videoBroll").onclick=()=>pickVideoItem("broll");
$("#videoMusic").onclick=()=>pickVideoItem("music");
$("#videoDrop").ondragover=event=>{
  if(event.dataTransfer.types.includes("Files")){event.preventDefault();$("#videoDrop").classList.add("dragging");}
};
$("#videoDrop").ondragleave=()=>$("#videoDrop").classList.remove("dragging");
$("#videoDrop").ondrop=async event=>{
  event.preventDefault();$("#videoDrop").classList.remove("dragging");
  if(videoRunning)return;
  try{
    const [item]=await N.video.drop(Array.from(event.dataTransfer.files));
    if(item)selectedSource(item);else videoState("Válassz MP4, MOV, MKV vagy más támogatott videót.");
  }catch(error){videoState(error.message);}
};
busyVideo(false);
N.video.onProgress(({stage,progress})=>videoState(stage,progress));

function reviewPlan(job){
  const {plan,assets,wordCount,note}=job;
  $("#videoPlanTitle").textContent=plan.title;
  const sources=new Map(assets.map(asset=>[asset.id,asset]));
  const used=plan.shots.filter(shot=>shot.asset).length;
  $("#videoSummary").textContent=`${(plan.end-plan.start).toFixed(1)} mp · ${used} B-roll-jelenet · ${wordCount} időzített felirat`+(note?" · "+note:"");
  $("#videoContact").src="neutron-video://"+job.id+"/contact.jpg";
  $("#videoContact").hidden=false;
  $("#videoContact").onerror=()=>{$("#videoContact").hidden=true;};
  const list=$("#videoShots");
  list.replaceChildren();
  const devices={camera:"Eredeti felvétel",punch:"Kamera-ráközelítés",cut:"Vágás",push:"Mozgó kép",tile:"Mozaikos belépő"};
  plan.shots.forEach((shot,index)=>{
    const row=document.createElement("div"), time=document.createElement("time"), group=document.createElement("div");
    time.textContent=shot.at.toFixed(2)+" mp";
    const source=sources.get(shot.asset), label=document.createElement("strong"), extra=document.createElement("small");
    label.textContent=source?source.name:shot.device==="punch"?devices.punch:devices.camera;
    extra.textContent=[source?devices[shot.device]:null,shot.why,source?.licence].filter(Boolean).join(" · ");
    group.append(label,extra);
    if(source?.thumbnail){
      const thumb=document.createElement("img");
      thumb.className="video-source-thumb";thumb.alt="";thumb.loading="lazy";thumb.src=source.thumbnail;
      group.append(thumb);
    }
    if(source?.url){
      const link=document.createElement("a");link.textContent="Forrás";link.href=source.url;link.target="_blank";
      group.append(link);
    }
    const include=document.createElement("input");include.type="checkbox";include.checked=true;include.value=index;
    include.disabled=!source && shot.device!=="punch";include.setAttribute("aria-label","Jelenet beépítése "+time.textContent);
    row.append(time,group,include);list.append(row);
  });
  if(!list.childElementCount)list.textContent="A kiválasztott szakasz az eredeti kameraképet használja.";
  $("#videoReview").hidden=false;
}
$("#videoForm").onsubmit=async event=>{
  event.preventDefault();
  if(!selectedVideo || videoRunning)return;
  resetReview();busyVideo(true);videoState("Felvétel beolvasása…",0);
  try {
    videoJob=await N.video.plan({source:selectedVideo.id,model:JSON.parse($("#videoModel").value),
      brief:$("#videoBrief").value,language:$("#videoLanguage").value,pace:$("#videoPace").value,
      start:$("#videoStart").value,end:$("#videoEnd").value,transcript:$("#videoTranscript").value,
      sourceWeb:$("#videoSourceWeb").checked,broll:videoBroll.map(clip=>clip.id),music:selectedMusic?.id});
    reviewPlan(videoJob);videoState("A renderelés előtt nézd át a vágási tervet és a forrásokat.");
  }catch(error){videoState(error.message.replace(/^Error invoking remote method '[^']+': Error: /,""));}
  finally{busyVideo(false);}
};
$("#videoRender").onclick=async()=>{
  if(!videoJob || videoRunning)return;
  busyVideo(true);$("#videoExport").hidden=true;
  $("#videoPlayer").removeAttribute("src");$("#videoPlayer").load();
  videoState("Renderelés előkészítése…",0);
  try{
    const excluded=[...$("#videoShots").querySelectorAll("input:not(:checked)")].map(input=>Number(input.value));
    const result=await N.video.render({id:videoJob.id,reviewed:true,excluded,format:$("#videoFormat").value,quality:$("#videoQuality").value,
      captions:$("#videoCaptions").checked,clicks:$("#videoClicks").checked});
    $("#videoPlayer").src=result.url;$("#videoExport").hidden=false;
    videoState(`Kész · ${result.info.width} × ${result.info.height} · ${result.info.duration.toFixed(1)} mp`);
    $("#videoExport").scrollIntoView({block:"nearest"});
  }catch(error){videoState(error.message.replace(/^Error invoking remote method '[^']+': Error: /,""));}
  finally{busyVideo(false);}
};
$("#cancelVideo").onclick=()=>N.video.cancel().catch(error=>videoState(error.message));
for(const [button,kind] of [["videoSave","video"],["videoSources","sources"]]){
  $("#"+button).onclick=()=>N.video.save(videoJob.id,kind).then(saved=>{if(saved)toast("Fájl elmentve.");}).catch(error=>videoState(error.message));
}
