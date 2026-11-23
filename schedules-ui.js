"use strict";

const schedulesDialog=$("#schedulesDialog"), scheduleForm=$("#scheduleForm");
const scheduleDate=new Intl.DateTimeFormat("hu-HU",{dateStyle:"medium",timeStyle:"short"});
const scheduleStatus={done:"Befejezve",failed:"Hibával zárult",stopped:"Leállítva",interrupted:"Megszakadt kilépéskor",missing:"A csevegés vagy fiók hiányzik"};
const repeatNames={once:"Egyszer",daily:"Naponta",weekly:"Hetente"};
let editingSchedule="", currentSchedules=[];

function toLocalInput(timestamp) {
  const value=new Date(timestamp);
  return new Date(timestamp-value.getTimezoneOffset()*60000).toISOString().slice(0,16);
}

function scheduleLabel() {
  const task=$("#scheduleKind").value==="task";
  $("#scheduleTargetLabel").hidden=!task;
  $("#scheduleTarget").required=task;
  $("#scheduleText").required=task;
  $("#scheduleTextLabel").textContent=task?"Feladat":"Megjegyzés";
}

function fillScheduleForm(record={}) {
  editingSchedule=record.id || "";
  $("#scheduleFormTitle").textContent=editingSchedule?"Ütemezés szerkesztése":"Új ütemezés";
  $("#scheduleKind").value=record.kind==="task"?"task":"reminder";
  $("#scheduleName").value=record.title || "";
  $("#scheduleText").value=record.text || "";
  $("#scheduleRepeat").value=Object.hasOwn(repeatNames,record.repeat)?record.repeat:"once";
  const proposed=record.nextAt ?? (record.when?Date.parse(record.when):0);
  $("#scheduleAt").value=toLocalInput(Number.isFinite(proposed) && proposed>Date.now()?proposed:Date.now()+15*60000);
  const eligible=chats.map(c=>new Option(c.title,c.id));
  if(chat && !chats.some(c=>c.id===chat.id))eligible.unshift(new Option(chat.title+" · aktuális",chat.id));
  const target=$("#scheduleTarget");
  target.replaceChildren(...eligible);
  target.value=record.chatId || chat?.id || "";
  $("#scheduleFeedback").textContent="";
  scheduleLabel();
}

function scheduleAction(label,onClick,disabled) {
  const button=document.createElement("button");
  button.type="button";button.className="btn";button.textContent=label;button.disabled=disabled;
  button.onclick=()=>Promise.resolve().then(onClick).catch(error=>{ $("#scheduleFeedback").textContent=error.message; });
  return button;
}

function renderSchedules(rows) {
  currentSchedules=rows;
  if(!schedulesDialog.open)return;
  const list=$("#scheduleList");
  list.replaceChildren();
  if(!rows.length){
    list.textContent="Még nincs mentett ütemezés.";
    return;
  }
  for(const row of [...rows].sort((a,b)=>Number(b.enabled)-Number(a.enabled) || (a.nextAt || Infinity)-(b.nextAt || Infinity))){
    const item=document.createElement("article"), heading=document.createElement("strong"), details=document.createElement("small");
    item.className="schedule-row";
    heading.textContent=row.title;
    const timing=row.enabled && row.nextAt ? scheduleDate.format(row.nextAt) : row.nextAt ? "Szünetel" : "Egyszeri ütemezés";
    details.textContent=[row.kind==="task"?"Chatfeladat":"Emlékeztető",repeatNames[row.repeat],timing].join(" · ");
    item.append(heading,details);
    if(row.runId || row.lastStatus){
      const state=document.createElement("small");
      state.className="schedule-row-status";state.textContent=row.runId?"Folyamatban":scheduleStatus[row.lastStatus];
      item.append(state);
    }
    const actions=document.createElement("div");
    actions.className="schedule-actions";
    actions.append(
      scheduleAction("Szerkesztés",()=>fillScheduleForm(row),!!row.runId),
      scheduleAction(row.enabled?"Szüneteltetés":"Bekapcsolás",()=>N.schedules.toggle(row.id),!!row.runId || !row.nextAt),
      scheduleAction("Törlés",async()=>{
        if(!confirm("Törlöd ezt az ütemezést? "+row.title))return;
        await N.schedules.remove(row.id);
        if(editingSchedule===row.id)fillScheduleForm();
      },!!row.runId),
    );
    item.append(actions);list.append(item);
  }
}

function openScheduleDialog(draft) {
  if(!schedulesDialog.open)schedulesDialog.showModal();
  fillScheduleForm(draft);
  renderSchedules(currentSchedules);
  N.schedules.list().then(renderSchedules).catch(error=>{$("#scheduleFeedback").textContent=error.message;});
}
$("#scheduleKind").onchange=scheduleLabel;
$("#closeSchedules").onclick=()=>schedulesDialog.close();
$("#schedulesBtn").onclick=()=>openScheduleDialog();
$("#newSchedule").onclick=()=>fillScheduleForm();

scheduleForm.onsubmit=async event=>{
  event.preventDefault();
  const button=event.submitter;button.disabled=true;
  const job={id:editingSchedule,kind:$("#scheduleKind").value,title:$("#scheduleName").value,text:$("#scheduleText").value,
    chatId:$("#scheduleTarget").value,repeat:$("#scheduleRepeat").value,nextAt:new Date($("#scheduleAt").value).getTime()};
  try {
    if(job.kind==="task" && chat?.id===job.chatId && !chats.some(c=>c.id===job.chatId)){await save(chat);await refreshList();}
    const saved=await N.schedules.save(job);
    fillScheduleForm(saved);
    $("#scheduleFeedback").textContent="Az ütemezés elmentve.";
  }catch(error){$("#scheduleFeedback").textContent=error.message.replace(/^Error invoking remote method '[^']+': Error: /,"");}
  finally{button.disabled=false;}
};
N.schedules.onChange(renderSchedules);
N.schedules.onRun(async job=>{
  try{
    const target=await getChat(job.chatId);
    if(!target || !hasChatProvider(target))return N.schedules.finish(job.id,job.runId,"missing");
    if(live.has(target.id) || termChatId===target.id)return N.schedules.finish(job.id,job.runId,"busy");
    if(!await submit(target,job.text,true,null,[],job))N.schedules.finish(job.id,job.runId,"busy");
  }catch{
    N.schedules.finish(job.id,job.runId,"failed");
    N.notices.complete({title:"Az ütemezett futás hibával zárult",body:job.title,chatId:job.chatId,failed:true});
  }
});

async function openNotice(notice) {
  if(notice.kind==="schedule")return openScheduleDialog();
  if(notice.kind==="video")return setView("video");
  if(!notice.chatId)return;
  const target=await getChat(notice.chatId);
  if(!target)return toast("A csevegés már nem érhető el.",true);
  if((target.projectId || "")!==(cfg.activeProject || ""))await activateProject(target.projectId || "");
  await selectChat(target.id);
}
N.notices.onOpen(notice=>openNotice(notice).catch(error=>toast(error.message,true)));
N.notices.onNotice(notice=>{
  const area=$("#neutronNotices"), item=document.createElement("article");
  item.className="notice-card"+(notice.failed?" failed":"");
  const button=document.createElement("button"), title=document.createElement("strong"), body=document.createElement("span");
  button.type="button";button.className="notice-content";
  title.textContent=notice.title;body.textContent=notice.body;
  button.append(title,body);
  button.onclick=()=>{item.remove();openNotice(notice).catch(error=>toast(error.message,true));};
  const close=document.createElement("button");
  close.type="button";close.className="notice-close";close.textContent="×";close.setAttribute("aria-label","Értesítés bezárása");
  close.onclick=()=>item.remove();
  item.append(button,close);area.prepend(item);
  if(area.childElementCount>4)area.lastElementChild.remove();
  setTimeout(()=>item.remove(),12000);
});
