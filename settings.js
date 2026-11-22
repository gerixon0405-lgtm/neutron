"use strict";
const settingsDialog=$("#settingsDialog");
let mailTimer, mailBusy=false, mailLoading=false, mailGeneration=0, lastMailView="";
const stateLabels={pending:"várakozik",sending:"küldés alatt",sent:"Gmail átvette",failed:"elutasítva",unknown:"ellenőrizendő",cancelled:"leállítva"};

function settingsButton(text,fn){
  const btn=document.createElement("button");btn.className="btn";btn.type="button";btn.textContent=text;
  btn.onclick=async()=>{btn.disabled=true;try{await fn();}catch(e){toast(e.message,true);}finally{btn.disabled=false;}};
  return btn;
}
function accountRow(title,description){
  const row=document.createElement("div");row.className="settings-account";
  const info=document.createElement("div"),name=document.createElement("strong"),status=document.createElement("small");
  name.textContent=title;status.textContent=description;info.append(name,status);row.append(info);
  return row;
}
function loginFromSettings(a){
  if(chat && live.has(chat.id)) return toast("A bejelentkezéshez várd meg az aktuális választ.");
  settingsDialog.close();loginAccount(a);
}
function drawAiAccounts(){
  const list=$("#aiAccounts"); list.replaceChildren();
  const cx=accStatus.get("codex"),codexAccount={id:"codex",name:"Codex"};
  const row=accountRow("Codex · ChatGPT",cx?.loggedIn?"Bejelentkezve":cx?.missing?"A Codex CLI nem található":cx?"Nincs bejelentkezve":"Állapot lekérése…");
  if(cx?.loggedIn) row.append(settingsButton("Új chat",()=>{settingsDialog.close();startProfile(null,"codex");}));
  row.append(settingsButton(cx?.loggedIn?"Bejelentkezés másik fiókkal":"Codex csatlakoztatása",()=>loginFromSettings(codexAccount)));
  list.append(row);
  for(const a of accounts()){
    const state=accStatus.get(a.id);
    const r=accountRow("Claude · "+a.name,state?.loggedIn?[state.email,state.plan].filter(Boolean).join(" · ") || "Bejelentkezve":state?"Nincs bejelentkezve":"Állapot lekérése…");
    if(state?.loggedIn) r.append(settingsButton("Használat",()=>{settingsDialog.close();switchModel(a.id,cfg.claudeModel || "");}));
    r.append(settingsButton("Bejelentkezés",()=>loginFromSettings(a)));
    if(a.id!=="default")r.append(settingsButton("Eltávolítás",async()=>{
      if(!confirm("Eltávolítod a(z) „"+a.name+"” helyi Claude-fiókot?"))return;
      await N.accounts.remove(a.dir);cfg.accounts=accounts().filter(x=>x.id!==a.id);
      if(cfg.provider===a.id)cfg.provider="fcc";
      await N.config.set(cfg);accStatus.delete(a.id);
      if(chat?.provider===a.id){chat.provider="fcc";chat.model=cfg.model || defaultModel();restartSession(chat);updateChips();}
      drawAiAccounts();
    }));
    list.append(r);
  }
  $("#settingsFcc").textContent=$("#fccText").textContent;
}
$("#addClaudeForm").onsubmit=async e=>{
  e.preventDefault();const btn=e.submitter;
  const name=$("#newAccountName").value.trim();
  if(!name)return;
  btn.disabled=true;
  try{
    const {id,dir}=await N.accounts.create(),a={id,dir,name};
    accounts().push(a);await N.config.set(cfg);accStatus.set(id,{loggedIn:false});
    $("#newAccountName").value="";drawAiAccounts();loginFromSettings(a);
  }catch(err){toast(err.message,true);}finally{btn.disabled=false;}
};
function drawMail(state){
  const connected=!!state.email;
  $("#gmailState").textContent=connected ? [state.email,state.note].filter(Boolean).join(" · ") : "Egy Gmail-fiókkal egy vagy több címzettnek is küldhetsz levelet a chatből.";
  $("#gmailLogin").hidden=connected && !state.note;
  $("#gmailDisconnect").hidden=!connected;$("#outboxSection").hidden=!connected;
  const list=$("#gmailOutbox");list.replaceChildren();
  if(!state.batches?.length){list.textContent="Még nincs sorba állított levél.";return;}
  for(const batch of state.batches){
    const stats=Object.entries(batch.counts).map(([k,v])=>v+" "+(stateLabels[k] || k)).join(" · ");
    const row=accountRow(batch.subject,stats);
    if(batch.counts.pending)row.append(settingsButton("Hátralévők leállítása",async()=>{
      await N.mail.cancel(batch.id);await refreshMail(true);
    }));
    if(batch.counts.failed || batch.counts.unknown)row.append(settingsButton("Részletek",async()=>{
      const info=await N.mail.status(batch.id);
      $("#gmailFeedback").textContent=(info.problems || []).map(p=>p.recipient+" — "+p.note).join("\n");
    }));
    list.append(row);
  }
}
async function refreshMail(force=false){
  if(!settingsDialog.open || (!force && (mailLoading || mailBusy)))return;
  const request=++mailGeneration;mailLoading=true;
  try{
    const s=await N.mail.status();
    if(request!==mailGeneration || !settingsDialog.open)return;
    const key=JSON.stringify(s);
    if(force || key!==lastMailView){drawMail(s);lastMailView=key;}
  }catch(e){if(request===mailGeneration)$("#gmailState").textContent=e.message;}
  finally{if(request===mailGeneration)mailLoading=false;}
}
async function mailAction(task){
  if(mailBusy)return;
  mailBusy=true;
  const buttons=[...settingsDialog.querySelectorAll("#gmailLogin button,#gmailDisconnect")];
  buttons.forEach(b=>b.disabled=true);$("#gmailFeedback").textContent="Kapcsolat frissítése…";
  try{const answer=await task();$("#gmailFeedback").textContent=answer?.email?"A Gmail-fiók csatlakoztatva.":"";await refreshMail(true);}
  catch(e){$("#gmailFeedback").textContent=(e.message || String(e)).replace(/^Error invoking remote method '[^']+': Error: /,"");}
  finally{mailBusy=false;buttons.forEach(b=>b.disabled=false);}
}
$("#gmailForm").onsubmit=e=>{
  e.preventDefault();
  const email=$("#gmailEmail").value.trim(),password=$("#gmailPassword").value;
  $("#gmailPassword").value="";mailAction(()=>N.mail.smtp(email,password));
};
$("#gmailOAuth").onclick=()=>mailAction(()=>N.mail.oauth());
$("#gmailHelp").onclick=()=>N.mail.passwordPage().catch(e=>toast(e.message,true));
$("#gmailDisconnect").onclick=()=>mailAction(()=>N.mail.disconnect());
$("#settingsClose").onclick=()=>settingsDialog.close();
$("#accBtn").onclick=()=>{
  settingsDialog.showModal();drawAiAccounts();refreshAccounts().then(()=>{if(settingsDialog.open)drawAiAccounts();}).catch(e=>toast(e.message,true));
  refreshMail(true);clearInterval(mailTimer);refreshUpdate();mailTimer=setInterval(()=>{refreshMail();refreshUpdate();},3000);
};
settingsDialog.addEventListener("close",()=>{clearInterval(mailTimer);mailGeneration++;mailLoading=false;$("#gmailPassword").value="";});

async function refreshUpdate(){
  const info=await N.updates.status();
  $("#appVersion").textContent="Neutron "+info.version;
  $("#updateMessage").textContent=info.message;$("#updateCheck").hidden=!info.enabled;
}
$("#updateCheck").onclick=async()=>{await N.updates.check();await refreshUpdate();};
