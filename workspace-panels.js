"use strict";

const contextPane = $("#contextPane");
const contextCache = new WeakMap();
const tokenNumber = new Intl.NumberFormat("hu-HU");
const compactNumber = new Intl.NumberFormat("hu-HU",{notation:"compact",maximumFractionDigits:1});
const contextColors = ["#6da9fc","#4edac8","#ed9a68","#b9a4ff","#f4c85e","#6fc597","#bcc2d5"];

function closeContext() {
  contextPane.hidden = true;
  $("#dirChip").setAttribute("aria-expanded","false");
}

function invalidateContext(target, refresh = true) {
  contextCache.delete(target);
  if (refresh && target === chat) renderContext();
}

function renderContextControls() {
  if (contextPane.hidden || !chat) return;
  const busy = live.has(chat.id);
  $("#contextAddFolder").disabled = busy;
  $("#contextChangeFolder").disabled = busy || !!(chat.items.length || chat.projectId);
  $("#contextRemote").disabled = busy;
  $("#compactThreshold").disabled = busy;
  $("#compactNow").disabled = busy || !chat.items.length || (chat.provider==="codex" && !chat.codexThread);
  contextPane.querySelectorAll(".remove-folder").forEach(button=>{button.disabled=busy;});
}

function renderContext() {
  if (!chat || contextPane.hidden || view!=="chat") return;
  $("#contextProvider").textContent = providerLabel(chat.provider,chat.model);
  const folders = $("#contextFolders");
  folders.replaceChildren();
  for (const [index, dir] of [chat.cwd,...(chat.extraDirs || [])].entries()) {
    if (!dir) continue;
    const row=document.createElement("div");
    row.className="context-folder";
    const caption=document.createElement("span");
    caption.textContent=shortDir(dir);
    caption.title=dir;
    row.append(caption);
    if(index){
      const owner=chat, button=document.createElement("button");
      button.type="button";
      button.className="remove-folder";
      button.textContent="×";
      button.setAttribute("aria-label","Mappa eltávolítása: "+dir);
      button.onclick=()=>editChatFolders(owner,"remove:"+dir);
      row.append(button);
    }
    folders.append(row);
  }
  $("#contextRemote").hidden = ["codex","fcc"].includes(chat.provider);
  const threshold=$("#compactThreshold");
  threshold.parentElement.hidden=chat.provider==="fcc";
  const limits=new Set([100000,150000,200000,300000,400000,600000,800000,1000000]);
  if(chat.autoCompactTokens)limits.add(chat.autoCompactTokens);
  threshold.replaceChildren(new Option("Szolgáltató alapértéke",""),...[...limits].sort((a,b)=>a-b).map(tokens=>new Option(tokenNumber.format(tokens)+" token",tokens)));
  threshold.value=chat.autoCompactTokens || "";
  renderContextControls();
  const state=contextCache.get(chat);
  if(state) paintContext(state);
  else loadContext(chat);
}

function paintContext(state) {
  const host=$("#contextReport");
  const data=state.report;
  const openGroups=new Set([...host.querySelectorAll("details[open]")].map(details=>details.dataset.contextGroup));
  host.replaceChildren();
  $("#refreshContext").disabled=!!state.pending;
  if(!data){
    host.textContent=state.pending ? "Kontextus lekérése…" : state.status;
    return;
  }
  const percent=Math.max(0,100*data.used/data.max);
  const totals=document.createElement("div"), bar=document.createElement("div");
  totals.className="context-totals";
  totals.innerHTML="<strong>"+Math.round(percent)+"% használatban</strong><span>"+compactNumber.format(data.used)+" / "+compactNumber.format(data.max)+" token</span>";
  totals.title=tokenNumber.format(data.used)+" / "+tokenNumber.format(data.max)+" token";
  bar.className="context-bar";
  bar.setAttribute("role","meter");
  bar.setAttribute("aria-label","Kontextushasználat");
  bar.setAttribute("aria-valuemin","0");
  bar.setAttribute("aria-valuemax","100");
  bar.setAttribute("aria-valuenow",String(Math.min(100,Math.round(percent))));
  host.append(totals,bar);
  const list=document.createElement("div");list.className="context-categories";
  let assigned=0;
  for(const [index,row] of data.categories.entries()){
    if(!Number.isFinite(row.tokens) || row.tokens<0)continue;
    const color=row.kind==="used" ? contextColors[index%contextColors.length] : "#686b7a";
    if(row.kind==="used" || row.kind==="buffer"){
      const width=Math.max(0,Math.min(100-assigned,100*row.tokens/data.max));
      const segment=document.createElement("span");
      segment.style.width=width+"%"; segment.style.background=color;
      bar.append(segment);assigned+=width;
    }
    const item=document.createElement("div");
    item.className="context-category";
    const swatch=document.createElement("i");swatch.style.background=color;
    const caption=document.createElement("span");caption.textContent=row.name;
    const count=document.createElement("small");count.textContent=compactNumber.format(row.tokens);
    const share=document.createElement("small");share.textContent=row.kind==="deferred" ? "–" : (100*row.tokens/data.max).toLocaleString("hu-HU",{maximumFractionDigits:1})+"%";
    item.append(swatch,caption,count,share);list.append(item);
  }
  if(!bar.children.length){
    const segment=document.createElement("span");
    segment.style.width=Math.min(100,percent)+"%";
    segment.style.background="var(--grad)";
    bar.append(segment);
  }
  if(list.children.length)host.append(list);
  if(data.compactAt>0){
    const threshold=document.createElement("p");threshold.className="context-hint";
    threshold.textContent="A munkamenet tömörítési küszöbe "+tokenNumber.format(data.compactAt)+" token.";
    host.append(threshold);
  }
  for(const group of data.groups){
    if(!group.rows.length)continue;
    const details=document.createElement("details");details.dataset.contextGroup=group.name;
    details.open=openGroups.has(group.name);
    const summary=document.createElement("summary");summary.textContent=group.name+" · "+group.rows.length;
    const rows=document.createElement("div");rows.className="context-group-rows";
    for(const entry of group.rows){
      const row=document.createElement("div"),name=document.createElement("span"),count=document.createElement("small");
      name.textContent=entry.name;name.title=entry.name;
      count.textContent=Number.isFinite(entry.tokens)?tokenNumber.format(entry.tokens):"";
      row.append(name,count);rows.append(row);
    }
    details.append(summary,rows);host.append(details);
  }
}

async function loadContext(target, full = false) {
  const previous=contextCache.get(target);
  if(previous?.pending)return;
  const state={pending:true,report:previous?.report,status:""};
  contextCache.set(target,state);
  paintContext(state);
  try{
    state.report=await N.context.read(target,full?"full":"summary");
    state.status=target.provider==="codex" && !target.codexThread ? "Az első Codex-válasz után jelenik meg a használat." : "Ehhez a munkamenethez még nincs kontextusmérés.";
  }catch{
    state.status="A kontextusjelentés most nem érhető el.";
  }finally{
    state.pending=false;
    if(target===chat && !contextPane.hidden && contextCache.get(target)===state)paintContext(state);
  }
}

async function editChatFolders(target, action) {
  if(live.has(target.id))return;
  if(action==="add-folder"){
    const dir=await N.pickDir();
    if(!dir || target!==chat || live.has(target.id) || dir===target.cwd)return;
    target.extraDirs=[...new Set([...(target.extraDirs || []),dir])];
    if(target.provider==="codex")target.codexSandbox="workspace-write";
  }else target.extraDirs=(target.extraDirs || []).filter(dir=>dir!==action.slice(7));
  restartSession(target);
  if(termChatId===target.id){N.term.stop();termChatId=null;}
  updateChips();
  invalidateContext(target);
  await save(target);
}
$("#dirChip").onclick=()=>{
  if(!contextPane.hidden)return closeContext();
  closeFiles();
  contextPane.hidden=false;
  $("#dirChip").setAttribute("aria-expanded","true");
  renderContext();
};
$("#closeContext").onclick=closeContext;
$("#contextAddFolder").onclick=()=>editChatFolders(chat,"add-folder").catch(error=>toast(error.message,true));
$("#contextChangeFolder").onclick=async()=>{
  const target=chat;
  if(target.items.length || target.projectId || live.has(target.id))return;
  const dir=await N.pickDir();
  if(!dir || target!==chat || target.items.length)return;
  target.cwd=cfg.lastCwd=dir;
  restartSession(target);
  updateChips();invalidateContext(target);
  await Promise.all([N.config.set(cfg),save(target)]);
};
$("#contextRemote").onclick=()=>setView("term",()=>startTerm(["--remote-control"]));
$("#refreshContext").onclick=()=>loadContext(chat,!live.has(chat.id));
$("#compactThreshold").onchange=async event=>{
  const target=chat;
  if(live.has(target.id))return;
  target.autoCompactTokens=Number(event.target.value);
  restartSession(target);invalidateContext(target);await save(target);
};
$("#compactNow").onclick=()=>submit(chat,"/compact");

const htmlStarter=(title,body)=>'<!doctype html>\n<html lang="hu"><meta charset="utf-8">\n<title>'+title+'</title>\n<style>body{max-width:760px;margin:64px auto;padding:24px;background:#10172c;color:#f5f4fb;font:18px system-ui}section,article{padding:24px;margin:16px 0;background:#263458;border-radius:14px}h1{color:#a6dcfa}</style>\n<main>\n'+body+'\n</main></html>\n';
const templates = [
  {label:"Dokumentum", ext:"md", name:"Dokumentum", glyph:"▤", color:"blue", content:"# Dokumentum címe\n\nÍrd ide a dokumentum tartalmát.\n"},
  {label:"Prezentáció", ext:"html", name:"Prezentáció", glyph:"▣", color:"amber", content:htmlStarter("Prezentáció","<section><h1>Prezentáció címe</h1><p>Bevezetés</p></section>\n<section><h2>Második dia</h2><p>A következő gondolat</p></section>")},
  {label:"Táblázat", ext:"csv", name:"Táblázat", glyph:"⊞", color:"mint", content:"Név,Érték,Dátum\nPélda,1,\n"},
  {label:"Webalkalmazás", ext:"html", name:"Webalkalmazás", glyph:"↗", color:"violet", content:htmlStarter("Webalkalmazás","<h1>Webalkalmazás</h1>\n<article><p>Az alkalmazás tartalma.</p></article>")},
  {label:"Adat", ext:"json", name:"Adatok", glyph:"{ }", color:"cherry", content:'{\n  "tételek": []\n}\n'},
  {label:"Jegyzettábla", ext:"html", name:"Jegyzettábla", glyph:"▥", color:"ocean", content:htmlStarter("Jegyzettábla","<h1>Jegyzettábla</h1>\n<section><h2>Teendő</h2></section>\n<section><h2>Folyamatban</h2></section>\n<section><h2>Kész</h2></section>")},
];
let library=[], galleryLoad=0, galleryPage=48, covers, draftTemplate, draftScope;
const coverCache = new Map();
const dateLabel = new Intl.DateTimeFormat("hu-HU",{dateStyle:"medium"});

async function loadGallery() {
  const request=++galleryLoad;
  try {
    const items=await N.artifacts.catalog();
    if(request!==galleryLoad || view!=="gallery")return;
    library=items;
    $("#artifactCount").textContent=library.length || "";
    renderGallery();
  }catch(error){
    if(request===galleryLoad && view==="gallery")$("#galleryCount").textContent="Az artifactok most nem tölthetők be.";
  }
}

function galleryCover(item,node) {
  const key=JSON.stringify([item.scope,item.name,item.time]);
  if(!coverCache.has(key)){
    if(coverCache.size>=96)coverCache.delete(coverCache.keys().next().value);
    coverCache.set(key,N.artifacts.cover(item.scope,item.name).catch(()=>null));
  }
  return coverCache.get(key).then(data=>{
    if(!node.isConnected || !data)return;
    if(data.image){
      const image=document.createElement("img");image.alt="";image.src=data.image;
      image.onload=()=>{if(node.isConnected)node.replaceChildren(image);};
      return;
    }
    let lines=data.text.trim().split(/\r?\n/).filter(Boolean);
    if(/\.html?$/i.test(item.name)){
      const source=document.createElement("template");
      source.innerHTML=data.text;
      const title=source.content.querySelector("h1,h2,title")?.textContent;
      lines=[title,...[...source.content.querySelectorAll("p,h2,h3,li")].map(el=>el.textContent)].filter(Boolean);
    }
    if(!lines.length)return;
    const page=document.createElement("div");
    page.className="gallery-cover-page";
    for(const [i,line] of lines.slice(0,5).entries()){
      const text=document.createElement(i===0?"b":"span");text.textContent=line.replace(/^#{1,6}\s+/,"").slice(0,125);
      page.append(text);
    }
    node.replaceChildren(page);
  });
}

function renderGallery(){
  covers?.disconnect();
  const name=$("#gallerySearch").value.toLocaleLowerCase("hu").trim(), scope=$("#galleryScope").value;
  const rows=library.filter(file=>(!scope || !!file.scope.projectId===(scope==="projects")) &&
    (file.name+" "+file.title).toLocaleLowerCase("hu").includes(name));
  if($("#gallerySort").value==="name") rows.sort((a,b)=>a.name.localeCompare(b.name,"hu"));
  const grid=$("#galleryCards");
  grid.replaceChildren();
  $("#galleryCount").textContent=rows.length+" artifact";
  $("#galleryMore").hidden=rows.length<=galleryPage;
  if(!rows.length){
    const empty=document.createElement("p");
    empty.textContent=library.length?"Nincs a szűrésnek megfelelő artifact.":"A chatben létrehozott és a projektekben közzétett fájlok itt jelennek meg.";
    empty.className="gallery-empty";grid.append(empty);return;
  }
  const observed=new Map();
  covers=new IntersectionObserver(entries=>{
    for(const entry of entries){
      if(!entry.isIntersecting)continue;
      covers.unobserve(entry.target);
      galleryCover(observed.get(entry.target),entry.target);
      observed.delete(entry.target);
    }
  },{root:$("#galleryView"),rootMargin:"100px"});
  for(const item of rows.slice(0,galleryPage)){
    const ext=item.name.includes(".")?item.name.split(".").at(-1).toLowerCase():"fájl";
    const card=document.createElement("button");
    card.type="button";card.className="gallery-card";card.onclick=()=>showFiles(item.name,item.scope);
    const cover=document.createElement("div");cover.className="gallery-cover";cover.dataset.kind=ext;
    const tag=document.createElement("b");tag.textContent=ext.toUpperCase().slice(0,8);cover.append(tag);
    const title=document.createElement("strong");title.textContent=item.name;title.title=item.name;
    const info=document.createElement("small");
    info.textContent=[item.title,dateLabel.format(item.time),Math.max(1,Math.ceil(item.bytes/1024))+" kB"].join(" · ");
    card.append(cover,title,info);grid.append(card);
    observed.set(cover,item);covers.observe(cover);
  }
}
for(const selector of ["#gallerySearch","#galleryScope","#gallerySort"]) $(selector).oninput=()=>{galleryPage=48;renderGallery();};
$("#galleryMore").onclick=()=>{galleryPage+=48;renderGallery();};
$("#galleryLayout").onclick=event=>{
  const list=$("#galleryCards").classList.toggle("list");
  event.currentTarget.setAttribute("aria-pressed",String(list));event.currentTarget.textContent=list?"Rács":"Lista";
};

function openArtifactEditor(template){
  draftTemplate=template;
  draftScope=artifactScope();
  $("#artifactEditorTitle").textContent="Új "+template.label.toLocaleLowerCase("hu");
  $("#artifactDraftName").value=template.name+"."+template.ext;
  $("#artifactDraftContent").value=template.content;
  $("#artifactDraftError").textContent="";
  const select=$("#artifactDraftScope");
  select.replaceChildren(new Option("Aktuális munkatér · "+(activeProject()?.name || chat.title),"active"),...projectRows.filter(project=>project.id!==draftScope.projectId).map(project=>new Option(project.name,project.id)));
  $("#artifactEditor").showModal();
  $("#artifactDraftName").select();
}
for(const template of templates){
  const button=document.createElement("button");button.type="button";button.className="gallery-template";button.dataset.color=template.color;
  const mark=document.createElement("span");mark.textContent=template.glyph;mark.setAttribute("aria-hidden","true");
  const label=document.createElement("strong");label.textContent=template.label;
  button.append(mark,label);button.onclick=()=>openArtifactEditor(template);$("#galleryTemplates").append(button);
}
$("#newArtifact").onclick=()=>openArtifactEditor(templates[0]);
$("#closeArtifactEditor").onclick=()=>$("#artifactEditor").close();
$("#artifactEditorForm").onsubmit=async event=>{
  event.preventDefault();
  const button=event.submitter;button.disabled=true;
  try {
    const value=$("#artifactDraftScope").value,scope=value==="active"?draftScope:{projectId:value};
    const draft=$("#artifactDraftName").value.trim();
    const name=/\.(html|md|txt|csv|json)$/i.test(draft)?draft:draft+"."+draftTemplate.ext;
    const saved=await N.artifacts.create(scope,name,$("#artifactDraftContent").value);
    if(value==="active" && draftScope.id===chat.id && !draftScope.projectId)await save(chat);
    $("#artifactEditor").close();
    await loadGallery();
    showFiles(saved,scope);
  }catch(error){$("#artifactDraftError").textContent=error.message.replace(/^Error invoking remote method '[^']+': Error: /,"");}
  finally{button.disabled=false;}
};
