let projectRows = [];
let artifactRequest = 0;
const activeProject = () => projectRows.find(p => p.id === cfg.activeProject);
const artifactScope = () => ({id:chat.id, projectId:chat.projectId || ""});

async function initProjects() {
  projectRows = await N.projects.list();
  if (!activeProject()) cfg.activeProject = "";
  const select = $("#projectSelect"), hub=$("#projectHub");
  $("#projectHubBtn").onclick=()=>hub.showModal();
  function render() {
    select.replaceChildren(new Option("Projekt nélküli chatek", ""), ...projectRows.map(p => new Option(p.name,p.id)));
    select.value = cfg.activeProject;
    $("#projectFolder").hidden = !cfg.activeProject;
    $("#projectHubName").textContent=activeProject()?.name || "Projektek";
  }
  async function activate(id) {
    if (view === "term") setView("chat");
    cfg.activeProject = id;
    render();
    $("#search").value = "";
    const first = chats.find(c => (c.projectId || "") === id);
    if (first) await selectChat(first.id); else newChat();
    await N.config.set(cfg);
  }
  render();
  $("#projectFolder").onclick = () => N.projects.open(cfg.activeProject).catch(e => toast(e.message,true));
  select.onchange = () => {hub.close();activate(select.value).catch(e => toast(e.message,true));};
  document.querySelectorAll(".compact .dismiss").forEach(b => b.onclick = () => b.closest("dialog").close());
  $("#createProject").onclick = () => { hub.close(); $("#projectName").value = ""; $("#projectDialog").showModal(); $("#projectName").focus(); };
  $("#projectForm").onsubmit = async e => {
    e.preventDefault();
    const btn = e.submitter;
    btn.disabled = true;
    try {
      const p = await N.projects.create($("#projectName").value.trim());
      projectRows.push(p);
      await activate(p.id);
      $("#projectDialog").close();
    } catch (err) { toast(err.message,true); } finally { btn.disabled = false; }
  };
  $("#artifactsBtn").onclick = () => {
    if (!$("#artifactPane").hidden) return closeFiles();
    showFiles();
  };
  $("#closeFiles").onclick = closeFiles;
  $("#artifactSelect").onchange = () => showFiles($("#artifactSelect").value);
  window.addEventListener("neutron-turn-ended", updateArtifacts);
  window.addEventListener("focus", () => { if (chat) updateArtifacts(); });
}
let panelScope = "", fileVersion = "", selectedFile = "";
function closeFiles(){
  ++artifactRequest;
  $("#artifactPane").hidden=true; $("#previewSlot").replaceChildren();
  fileVersion=""; selectedFile=""; N.artifacts.close().catch(()=>{});
}
function showFiles(name){
  $("#artifactPane").hidden=false;
  panelScope=chat.id;
  if(name) selectedFile=name;
  return updateArtifacts();
}
async function updateArtifacts(){
  if(!chat) return;
  if(panelScope && panelScope!==chat.id) { closeFiles(); panelScope=""; }
  const scope=artifactScope(), request=++artifactRequest;
  try {
    const files=await N.artifacts.list(scope);
    if(request!==artifactRequest) return;
    $("#artifactCount").textContent=files.length || "";
    const pane=$("#artifactPane");
    if(pane.hidden) return;
    const select=$("#artifactSelect"), slot=$("#previewSlot");
    const chosen=files.find(f=>f.name===(selectedFile || select.value)) || files[0];
    select.replaceChildren(...files.map(f=>new Option(f.name,f.name)));
    select.hidden=!chosen;
    $("#artifactSave").hidden=!chosen;
    $("#artifactImport").hidden=!chosen?.name.endsWith(".mrpack");
    if(!chosen){ slot.textContent="Az elkészült fájlok itt jelennek meg."; $("#artifactInfo").textContent=""; fileVersion="";return; }
    select.value=selectedFile=chosen.name;
    $("#artifactInfo").textContent=Math.max(1,Math.ceil(chosen.bytes/1024))+" kB";
    $("#artifactSave").onclick=()=>N.artifacts.export(scope,chosen.name).catch(e=>toast(e.message,true));
    $("#artifactImport").onclick=()=>N.artifacts.importPack(scope,chosen.name).then(msg=>toast(msg)).catch(e=>toast(e.message,true));
    const version=JSON.stringify([scope.id,chosen.name,chosen.time]);
    if(fileVersion===version) return;
    slot.textContent="Előnézet betöltése…";
    const url=await N.artifacts.preview(scope,chosen.name);
    if(request!==artifactRequest) return;
    fileVersion=version;
    if(!url){slot.textContent="A fájlt a Mentés gombbal töltheted le.";return;}
    const frame=document.createElement("iframe");
    frame.title=chosen.name; frame.setAttribute("sandbox","allow-scripts"); frame.referrerPolicy="no-referrer"; frame.src=url;
    slot.replaceChildren(frame);
  } catch(e) {
    if(request===artifactRequest) {$("#previewSlot").textContent="Nincs elérhető előnézet. A fájl menthető."; fileVersion="";}
  }
}
function attachmentBlock(b) {
  const el=document.createElement("button"); el.className="file-attachment";
  const icon=document.createElement("span");icon.textContent="↗";icon.setAttribute("aria-hidden","true");
  const title=document.createElement("strong");title.textContent=b.name;
  el.append(icon,title);el.title="Megnyitás a fájlpanelen";el.onclick=()=>showFiles(b.name);
  return el;
}
function safeLink(value){
  try {const u=new URL(value);return u.protocol==="https:" && !u.username && !u.password ? u.href : "";} catch{return "";}
}
function resultCards(b) {
  const wrap=document.createElement("div");wrap.className="result-cards";
  for(const row of b.rows){
    const href=safeLink(row.url);
    if(!href || !row.title) continue;
    const link=document.createElement("a");link.className="result-card";link.href=href;link.target="_blank";link.rel="noopener noreferrer";
    if(safeLink(row.image)){
      const img=document.createElement("img");img.src=safeLink(row.image);img.loading="lazy";img.referrerPolicy="no-referrer";img.alt="";img.onerror=()=>img.remove();link.append(img);
    }
    const title=document.createElement("strong");title.textContent=row.title;link.append(title);
    if(row.price){const price=document.createElement("b");price.textContent=row.price;link.append(price);}
    const source=document.createElement("small");source.textContent=[row.merchant,row.source].filter(Boolean).join(" · ");link.append(source);
    wrap.append(link);
  }
  return wrap;
}
function receiveOutput(c,it,tool,input,body) {
  if(!/^mcp__neutron__/.test(tool)) return;
  const short=tool.slice(14);
  let value=body;
  try { value=JSON.parse(body); } catch {}
  if(Array.isArray(value) && value[0]?.text){try {value=JSON.parse(value[0].text);}catch{value=value[0].text;}}
  if(["artifact_write","artifact_publish","attach_file","prism_build"].includes(short)){
    const name=value?.artifact || (short==="artifact_write" && input?.name);
    if(typeof name!=="string" || !name || /[/\\]/.test(name)) return;
    if(!it.blocks.some(b=>b.type==="attachment" && b.name===name)) appendBlock(c,it,{type:"attachment",name});
    if(chat?.id===c.id) showFiles(name);
  }else if(["product_search","image_search"].includes(short)){
    const rows=value?.products || value?.images;
    if(Array.isArray(rows) && rows.length) appendBlock(c,it,{type:"cards",rows:rows.slice(0,8)});
  }
}
