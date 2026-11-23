"use strict";
const themes = {
  violet: {label:"Ibolya", colors:["#b29cff","#65e7dc"]},
  ocean: {label:"Óceán", colors:["#70beff","#7beede"]},
  mint: {label:"Menta", colors:["#73e1b5","#d1ec8e"]},
  amber: {label:"Borostyán", colors:["#ffb778","#ff829e"]}
};
const appearanceDefaults = {name:"",theme:"violet",background:"ambient",density:"roomy",motion:"system",sound:false,volume:45};
const systemMotion = matchMedia("(prefers-reduced-motion: reduce)");
const wizard = $("#onboardingDialog"), releaseDialog = $("#releaseDialog");
const settingsForm = $("#appearanceForm"), welcomeFields = $("#welcomeFields");
let preview, step = 0, currentVersion, releaseNotes = [], showAfterSetup = false, audio;

function applyAppearance(values) {
  const {style, dataset} = document.documentElement;
  dataset.theme = Object.hasOwn(themes,values.theme) ? values.theme : appearanceDefaults.theme;
  dataset.background = values.background;
  dataset.density = values.density;
  dataset.motion = systemMotion.matches || values.motion === "reduced" ? "reduced" : "full";
  style.colorScheme = "dark";
  dispatchEvent(new Event("neutron-appearance"));
}

function appearanceValues() { return {...appearanceDefaults,...cfg.appearance}; }

function fields(groups, values) {
  const input = (name,label,choices) => `<label>${label}<select name="${name}">${choices.map(([value,caption]) =>
    `<option value="${value}"${value===values[name]?" selected":""}>${caption}</option>`).join("")}</select></label>`;
  const parts = {
    name: `<label>Hogyan szólíthatunk?<input name="name" maxlength="40" autocomplete="off" placeholder="Keresztnév vagy becenév" value="${esc(values.name)}"></label>`,
    theme: `<fieldset class="themes"><legend>Színtéma</legend><div>${Object.entries(themes).map(([id,{label,colors}]) =>
      `<label class="swatch" style="--swatch-a:${colors[0]};--swatch-b:${colors[1]}"><input type="radio" name="theme" value="${id}"${values.theme===id?" checked":""}><span></span>${label}</label>`).join("")}</div></fieldset>`,
    layout: `<div class="appearance-grid">${input("background","Háttér",[["ambient","Fényjáték"],["plain","Egyszínű"]])}
      ${input("density","Térköz",[["roomy","Szellős"],["compact","Kompakt"]])}
      ${input("motion","Animációk",[["system","Kövesse a rendszerbeállítást"],["reduced","Visszafogott"]])}</div>`,
    sound: `<div class="sound-controls"><label class="sound-toggle"><input type="checkbox" name="sound"${values.sound?" checked":""}> Hangjelzések</label>
      <label>Hangerő<input type="range" name="volume" min="0" max="100" value="${Number(values.volume) || 0}"></label>
      <button type="button" class="btn sound-sample">Próbahang</button></div>`
  };
  return groups.map(group=>parts[group]).join("");
}

function readFields(form, base) {
  const values = {...base,...Object.fromEntries(new FormData(form))};
  if(form.elements.sound) values.sound = form.elements.sound.checked;
  values.name = values.name.trim().slice(0,40);
  values.volume = Number(values.volume);
  return values;
}

async function saveAppearance(values) {
  const previous = cfg.appearance;
  cfg.appearance = {...values,initialized:true};
  try { await N.config.set(cfg); }
  catch (error) { cfg.appearance = previous; throw error; }
  applyAppearance(cfg.appearance);
  if(chat && !chat.items.length) renderHero();
}

function playSound(kind, sample = false) {
  const settings = preview || appearanceValues();
  if ((!settings.sound && !sample) || settings.volume <= 0) return;
  const notes = {send:[523,698],reply:[523,659,784],permission:[659,523]};
  try {
    audio ||= new AudioContext();
    audio.resume().then(() => {
      const now = audio.currentTime;
      notes[kind].forEach((frequency, i) => {
        const start = now + i * .073;
        const tone = audio.createOscillator(), gain = audio.createGain();
        tone.frequency.value = frequency;
        gain.gain.setValueAtTime(.0001,start);
        gain.gain.exponentialRampToValueAtTime(Math.max(.001,Math.min(settings.volume,100)*.00055),start+.021);
        gain.gain.exponentialRampToValueAtTime(.0001,start+.19);
        tone.connect(gain).connect(audio.destination);
        tone.start(start);tone.stop(start+.2);
      });
    }).catch(()=>{});
  } catch {}
}

for (const kind of ["send","reply","permission"]) {
  addEventListener("neutron-"+kind,()=>{ if (!document.hidden) playSound(kind); });
}
for (const form of [settingsForm,$("#welcomeForm")]) {
  form.addEventListener("input",()=>{
    preview = readFields(form, preview || appearanceValues());
    if (form.elements.theme || form.elements.background) applyAppearance(preview);
  });
  form.addEventListener("click",event=>{if(event.target.closest(".sound-sample")) playSound("reply",true);});
}
systemMotion.addEventListener("change",()=>applyAppearance(preview || appearanceValues()));

settingsDialog.addEventListener("close",()=>{
  preview = null;
  applyAppearance(appearanceValues());
});
$("#accBtn").addEventListener("click",()=>{
  preview = appearanceValues();
  settingsForm.innerHTML = fields(["name","theme","layout","sound"],preview) +
    '<div class="appearance-actions"><button type="button" class="btn" id="resetAppearance">Alapértékek</button><button class="btn go" type="submit">Mentés</button></div>';
  $("#resetAppearance").onclick=()=>{
    preview = {...appearanceDefaults,name:preview.name};
    const newFields = document.createElement("template");
    newFields.innerHTML = fields(["name","theme","layout","sound"],preview);
    const actions = settingsForm.querySelector(".appearance-actions");
    settingsForm.replaceChildren(newFields.content,actions);
    applyAppearance(preview);
  };
});
settingsForm.onsubmit=async event=>{
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try { await saveAppearance(readFields(settingsForm,preview)); toast("Megjelenés mentve."); }
  catch (error) { toast(error.message,true); }
  finally { button.disabled = false; }
};

function renderStep() {
  const steps = [
    ["Üdv a Neutronban!","A kezdőképernyőn ezzel a névvel köszöntünk. A mezőt üresen is hagyhatod.",["name"]],
    ["Válassz színtémát","A változást azonnal láthatod a háttérben és a gombokon.",["theme","layout"]],
    ["Hangjelzések","Üzenetküldéskor, válasz érkezésekor és engedélykérésnél.",["sound"]]
  ];
  const [title,intro,groups] = steps[step];
  $("#welcomeTitle").textContent=title;
  $("#welcomeIntro").textContent=intro;
  $("#welcomeProgress").textContent=`${step+1} / ${steps.length}`;
  $("#welcomeBack").hidden=!step;
  $("#welcomeNext").textContent=step===steps.length-1?"Kezdés":"Tovább";
  welcomeFields.innerHTML=fields(groups,preview);
  (welcomeFields.querySelector("input:checked, input") || $("#welcomeNext")).focus();
}

wizard.addEventListener("cancel",event=>event.preventDefault());
$("#welcomeBack").onclick=()=>{
  preview=readFields($("#welcomeForm"),preview);
  step--;renderStep();
};
$("#welcomeForm").onsubmit=async event=>{
  event.preventDefault();
  preview=readFields(event.currentTarget,preview);
  if(step<2){step++;renderStep();return;}
  $("#welcomeNext").disabled=true;
  try {
    if(!showAfterSetup && currentVersion) cfg.seenRelease=currentVersion;
    await saveAppearance(preview);
    preview=null;wizard.close();
    if(showAfterSetup) openRelease(true);
  } catch(error) { toast(error.message,true); }
  finally {$("#welcomeNext").disabled=false;}
};

function openRelease(automatic) {
  $("#releaseVersion").textContent="Neutron "+currentVersion;
  const entries=$("#releaseEntries");
  entries.replaceChildren();
  for (const entry of releaseNotes) {
    if(automatic && cfg.seenRelease && entry.version.localeCompare(cfg.seenRelease,undefined,{numeric:true})<=0) continue;
    const section=document.createElement("section"), heading=document.createElement("h3"), list=document.createElement("ul");
    heading.textContent=`${entry.version} · ${entry.title}`;
    for (const text of entry.changes) {
      const item=document.createElement("li");item.textContent=text;list.append(item);
    }
    section.append(heading,list);entries.append(section);
  }
  if(!entries.childElementCount) return;
  releaseDialog.showModal();
}
$("#closeRelease").onclick=()=>releaseDialog.close();
$("#showReleaseNotes").onclick=()=>openRelease(false);
releaseDialog.addEventListener("close",()=>{
  if(cfg.seenRelease===currentVersion) return;
  cfg.seenRelease=currentVersion;
  N.config.set(cfg).catch(error=>toast(error.message,true));
});

addEventListener("neutron-ready",async event=>{
  applyAppearance(appearanceValues());
  try {
    const result=await N.updates.notes();
    currentVersion=result.version;releaseNotes=result.entries;
    $("#showReleaseNotes").hidden=!releaseNotes.length;
  } catch(error) { toast(error.message,true); }
  if(!cfg.appearance?.initialized){
    showAfterSetup = event.detail.returning;
    preview=appearanceValues();wizard.showModal();renderStep();
  } else if(currentVersion && cfg.seenRelease!==currentVersion) openRelease(true);
});
