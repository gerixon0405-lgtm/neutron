"use strict";
const importDialog=$("#claudeImportDialog"), importAccount=$("#claudeImportAccount");
const importStatus=$("#claudeImportStatus"), importSessions=$("#claudeImportSessions");
let candidates=[], importLoad=0, takingImport=false;

async function openClaudeImport(provider=""){
  if(!importDialog.open)importDialog.showModal();
  $("#claudeImportSearch").value="";
  $("#claudeImportArchived").checked=false;
  importAccount.replaceChildren(...accounts().map(account=>new Option(account.name,account.id)));
  if(provider)importAccount.value=provider;
  else if([...importAccount.options].some(option=>option.value===chat?.provider))importAccount.value=chat.provider;
  await refreshClaudeImport();
}

async function refreshClaudeImport(){
  const ticket=++importLoad;
  candidates=[];
  importStatus.textContent="Helyi munkamenetek keresése…";
  importSessions.replaceChildren();
  try{
    const result=await N.claudeImport.list(importAccount.value);
    if(ticket!==importLoad || !importDialog.open)return;
    candidates=result;
    drawClaudeImport();
  }catch(error){
    if(ticket===importLoad && importDialog.open)importStatus.textContent=error.message.replace(/^Error invoking remote method '[^']+': Error: /,"");
  }
}

function drawClaudeImport(){
  const search=$("#claudeImportSearch").value.trim().toLocaleLowerCase("hu");
  const archive=$("#claudeImportArchived").checked;
  const filtered=candidates.filter(row=>(archive || !row.archived) &&
    `${row.title} ${row.cwd}`.toLocaleLowerCase("hu").includes(search));
  importSessions.replaceChildren();
  importStatus.textContent=filtered.length?`${filtered.length} helyi munkamenet`:
    candidates.length?"Ezzel a szűréssel nincs találat.":"Ehhez a fiókhoz nem található helyi Desktop Code-munkamenet.";
  const dateFormat=new Intl.DateTimeFormat("hu-HU",{dateStyle:"medium",timeStyle:"short"});
  for(const row of filtered){
    const choice=document.createElement("button");
    choice.type="button";choice.className="claude-session-row";choice.disabled=!row.available || takingImport;
    if(row.available)choice.dataset.available="yes";
    const description=document.createElement("span"), title=document.createElement("strong"), folder=document.createElement("small");
    title.textContent=row.title;folder.textContent=row.cwd;folder.title=row.cwd;
    description.append(title,folder);
    const detail=document.createElement("span");detail.className="claude-session-date";
    detail.textContent=[row.time>0 && Number.isFinite(row.time)?dateFormat.format(row.time):"",row.archived?"Archivált":"",
      row.available?"":"Munkamappa nem érhető el"].filter(Boolean).join(" · ");
    choice.append(description,detail);
    choice.onclick=()=>importChosen(row.id);
    importSessions.append(choice);
  }
}

async function importChosen(id){
  if(takingImport)return;
  takingImport=true;
  importAccount.disabled=true;
  drawClaudeImport();
  importStatus.textContent="Beszélgetés importálása…";
  try{
    const imported=await N.claudeImport.select(importAccount.value,id);
    open.set(imported.id,open.get(imported.id) || imported);
    importDialog.close();
    if(activeProject())await activateProject("");
    await refreshList();
    await selectChat(imported.id);
    toast("A Claude Code-beszélgetés folytatható.");
  }catch(error){importStatus.textContent=error.message.replace(/^Error invoking remote method '[^']+': Error: /,"");}
  finally{
    takingImport=false;importAccount.disabled=false;
    importSessions.querySelectorAll("button").forEach(button=>{button.disabled=!button.dataset.available;});
  }
}
$("#importFromChooser").onclick=()=>{$("#newChooser").close();openClaudeImport();};
$("#closeClaudeImport").onclick=()=>importDialog.close();
importDialog.addEventListener("close",()=>{++importLoad;});
importAccount.onchange=refreshClaudeImport;
$("#claudeImportSearch").oninput=()=>{if(!takingImport && candidates.length)drawClaudeImport();};
$("#claudeImportArchived").onchange=()=>{if(!takingImport && candidates.length)drawClaudeImport();};
