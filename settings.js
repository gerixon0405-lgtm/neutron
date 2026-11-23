"use strict";
const settingsDialog=$("#settingsDialog");
let settingsTab="ai", mailConnected=false;
let mailTimer, mailBusy=false, mailLoading=false, mailGeneration=0, lastMailView="";
const usageSnapshots = new Map();
let refreshingAi;
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
  usageSnapshots.delete(a.id);
  settingsDialog.close();loginAccount(a);
}
function quotaLabel(meter) {
  if (meter.window === "weekly") return "Heti keret";
  if (meter.minutes && meter.minutes % 60 === 0) return `${meter.minutes / 60} órás keret`;
  if (meter.minutes) return `${meter.minutes} perces keret`;
  return meter.window === "session" ? "Rövid távú keret" : "Használati keret";
}
function paintUsage(host, snapshot) {
  if (!snapshot?.rows.length) {
    host.textContent = !snapshot || snapshot.pending ? "Használati adatok lekérése…" : "A fiókhoz jelenleg nincs elérhető kvótaadat.";
    return;
  }
  host.replaceChildren();
  const resetTime = new Intl.DateTimeFormat("hu-HU", {month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});
  for (const meter of snapshot.rows) {
    const row = document.createElement("div"), track = document.createElement("progress");
    const title = quotaLabel(meter) + (meter.scope ? " · " + meter.scope : "");
    const percent = Math.max(0, Math.min(100, meter.percent));
    row.className = "quota-meter";
    row.innerHTML = `<span>${esc(title)}</span><strong>${Math.round(percent)}%</strong>`;
    track.max = 100;
    track.value = percent;
    track.setAttribute("aria-label", title);
    if (percent >= 90) track.classList.add("near-limit");
    row.append(track);
    if (meter.reset && Number.isFinite(meter.reset)) {
      const reset = new Date(meter.reset);
      const time = document.createElement("time");
      time.dateTime = reset.toISOString();
      time.textContent = "Visszaáll " + resetTime.format(reset);
      row.append(time);
    }
    host.append(row);
  }
}
function addUsageCard(list, id, row, signedIn) {
  const card = document.createElement("article");
  card.className = "ai-account-card";
  card.append(row);
  if (signedIn) {
    const host = document.createElement("div");
    host.className = "quota-meters";
    host.dataset.usageAccount = id;
    paintUsage(host, usageSnapshots.get(id));
    card.append(host);
  }
  list.append(card);
}
async function refreshUsage(id, force) {
  const existing = usageSnapshots.get(id);
  if (existing?.pending) return existing.pending;
  if (!force && Date.now() - (existing?.at || 0) < 60000) return;
  const snapshot = {rows:existing?.rows || [], at:0};
  usageSnapshots.set(id, snapshot);
  snapshot.pending = N.accounts.usage(id).then(rows => {snapshot.rows = rows;}).catch(() => {snapshot.rows = [];}).finally(() => {
    snapshot.at = Date.now();
    snapshot.pending = null;
    for (const host of $("#aiAccounts").querySelectorAll("[data-usage-account]")) {
      if (host.dataset.usageAccount === id && usageSnapshots.get(id) === snapshot) paintUsage(host, snapshot);
    }
  });
  return snapshot.pending;
}
function refreshAi(force = false) {
  if (refreshingAi) return refreshingAi;
  $("#refreshUsage").disabled = true;
  refreshingAi = (async () => {
    await refreshAccounts();
    drawAiAccounts();
    await Promise.all(["codex", ...accounts().map(a => a.id)].filter(id => accStatus.get(id)?.loggedIn).map(id => refreshUsage(id, force)));
  })().catch(error => toast(error.message, true)).finally(() => {
    refreshingAi = null;
    $("#refreshUsage").disabled = false;
  });
  return refreshingAi;
}
$("#refreshUsage").onclick = () => refreshAi(true);

function drawAiAccounts(){
  const list=$("#aiAccounts"); list.replaceChildren();
  const cx=accStatus.get("codex"),codexAccount={id:"codex",name:"Codex"};
  const row=accountRow("Codex · ChatGPT",cx?.loggedIn?"Bejelentkezve":cx?.missing?"A Codex CLI nem található":cx?"Nincs bejelentkezve":"Állapot lekérése…");
  if(cx?.loggedIn) row.append(settingsButton("Új chat",()=>{settingsDialog.close();startProfile(null,"codex");}));
  row.append(settingsButton(cx?.loggedIn?"Bejelentkezés másik fiókkal":"Codex csatlakoztatása",()=>loginFromSettings(codexAccount)));
  addUsageCard(list, "codex", row, cx?.loggedIn);
  for(const a of accounts()){
    const state=accStatus.get(a.id);
    const r=accountRow("Claude · "+a.name,state?.loggedIn?[state.email,state.plan].filter(Boolean).join(" · ") || "Bejelentkezve":state?"Nincs bejelentkezve":"Állapot lekérése…");
    if(state?.loggedIn) r.append(settingsButton("Új chat",()=>{settingsDialog.close();startProfile(null,a.id);}),
      settingsButton("Code-chatek importálása",()=>{settingsDialog.close();return openClaudeImport(a.id);}));
    r.append(settingsButton("Bejelentkezés",()=>loginFromSettings(a)));
    if(a.id!=="default")r.append(settingsButton("Eltávolítás",async()=>{
      if(!confirm("Eltávolítod a(z) „"+a.name+"” helyi Claude-fiókot?"))return;
      await N.accounts.remove(a.dir);cfg.accounts=accounts().filter(x=>x.id!==a.id);
      if(cfg.provider===a.id)cfg.provider="fcc";
      await N.config.set(cfg);accStatus.delete(a.id);usageSnapshots.delete(a.id);
      if(chat?.provider===a.id){chat.provider="fcc";chat.model=cfg.model || defaultModel();restartSession(chat);updateChips();}
      drawAiAccounts();
    }));
    addUsageCard(list, a.id, r, state?.loggedIn);
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
  $("#gmailState").textContent=connected ? "Alapértelmezett feladó: "+state.email : "Csatlakoztass egy Gmail-fiókot a chatből indított küldéshez.";
  const accountsList=$("#gmailAccounts");
  accountsList.replaceChildren();
  for (const account of state.accounts || []) {
    const row=accountRow(account.email,account.note || (account.is_default ? "Alapértelmezett feladó" : "Csatlakoztatva"));
    if(!account.is_default) row.append(settingsButton("Legyen az alapértelmezett",()=>mailAction(()=>N.mail.select(account.email))));
    row.append(settingsButton("Leválasztás",()=>{
      if(confirm(`Leválasztod ezt a Gmail-fiókot? ${account.email}`))return mailAction(()=>N.mail.disconnect(account.email));
    }));
    accountsList.append(row);
  }
  mailConnected=connected;
  $("#outboxSection").hidden=!connected || settingsTab!=="gmail";
  const list=$("#gmailOutbox");list.replaceChildren();
  if(!state.batches?.length){list.textContent="Még nincs sorba állított levél.";return;}
  for(const batch of state.batches){
    const stats=Object.entries(batch.counts).map(([k,v])=>v+" "+(stateLabels[k] || k)).join(" · ");
    const row=accountRow(batch.subject,batch.email+" · "+stats);
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
  const buttons=[...settingsDialog.querySelectorAll("#gmailLogin button,#gmailAccounts button")];
  buttons.forEach(b=>b.disabled=true);$("#gmailFeedback").textContent="Kapcsolat frissítése…";
  try{const answer=await task();$("#gmailFeedback").textContent=answer?.email?answer.email:"";await refreshMail(true);}
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
document.querySelectorAll("[data-settings]").forEach(button=>button.onclick=()=>{
  settingsTab=button.dataset.settings;
  $(".settings-body").scrollTop=0;
  document.querySelectorAll("[data-settings]").forEach(tab=>tab.setAttribute("aria-pressed",tab===button));
  document.querySelectorAll("[data-panel]").forEach(panel=>{
    panel.hidden=panel.dataset.panel!==settingsTab || (panel.id==="outboxSection" && !mailConnected);
  });
  if (settingsTab==="ai") {drawAiAccounts();refreshAi();}
  if (settingsTab==="gmail") refreshMail(true);
  if (settingsTab==="updates") refreshUpdate();
});
$("#settingsClose").onclick=()=>settingsDialog.close();
$("#openVoiceSettings").onclick=()=>{settingsDialog.close();$("#voiceSettings").click();};
$("#accBtn").onclick=()=>{
  settingsDialog.showModal();
  $('[data-settings="ai"]').click();
  clearInterval(mailTimer);
  mailTimer=setInterval(()=>{
    if (settingsTab==="gmail") refreshMail();
    if (settingsTab==="updates") refreshUpdate();
  },3000);
};
settingsDialog.addEventListener("close",()=>{clearInterval(mailTimer);mailGeneration++;mailLoading=false;$("#gmailPassword").value="";});

async function refreshUpdate(){
  const info=await N.updates.status();
  $("#appVersion").textContent="Neutron "+info.version;
  $("#updateMessage").textContent=info.message;$("#updateCheck").hidden=!info.enabled;
}
$("#updateCheck").onclick=async()=>{await N.updates.check();await refreshUpdate();};


function showSpotifyAccount(state){
  $("#spotifyConnect").hidden=state.connected;
  $("#spotifyDisconnect").hidden=!state.connected;
  $("#spotifyConnection").textContent=state.connected?"A Spotify playlist-hozzáférése aktív.":"A playlist-szerkesztéshez engedélyezd a Spotify-fiókodat.";
}
$('[data-settings="spotify"]').addEventListener("click",()=>N.spotify.status().then(showSpotifyAccount).catch(error=>{
  $("#spotifyConnection").textContent=error.message;
}));
$("#spotifyConnect").onsubmit=async event=>{
  event.preventDefault();
  const button=event.submitter;button.disabled=true;
  $("#spotifyConnection").textContent="Spotify-jóváhagyásra várunk a böngészőben…";
  try { showSpotifyAccount(await N.spotify.connect($("#spotifyClientId").value)); }
  catch(error){ $("#spotifyConnection").textContent=error.message; }
  finally { button.disabled=false; }
};
$("#spotifyDisconnect").onclick=async()=>{
  try{showSpotifyAccount(await N.spotify.disconnect());}
  catch(error){$("#spotifyConnection").textContent=error.message;}
};
