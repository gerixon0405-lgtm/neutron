"use strict";
const discordTab=$('[data-settings="discord"]');
const discordFeedback=$("#discordFeedback");
const discordActions=$("#discordActions");
let discordBot, discordBusy=false, discordFocus, discordPoll, lastDiscordState="";
const discordStateLabels={pending:"Jóváhagyásra vár",running:"Végrehajtás folyamatban",done:"Kész",denied:"Elutasítva",
  partial:"Részben készült el",failed:"Sikertelen",unknown:"Ellenőrizendő a Discordban"};

function discordLine(parent,text,tag="div"){
  const element=document.createElement(tag);
  element.textContent=text;
  parent.append(element);
  return element;
}

function paintDiscord(state) {
  discordBot=state.bot;
  $("#discordConnection").textContent=discordBot ? `Csatlakoztatott bot: ${discordBot.name}` : "Csatlakoztasd a saját Discord-botodat.";
  $("#discordConnect").hidden=!!discordBot;
  $("#discordInvite").hidden=$("#discordDisconnect").hidden=!discordBot;
  discordActions.replaceChildren();
  const actions=discordBot ? state.actions.filter(action=>action.bot===discordBot.id) : [];
  if(!actions.length){discordLine(discordActions,"Még nincs előkészített Discord-művelet.","p");return;}
  for(const action of actions){
    const isMessage=action.kind==="message", target=action.payload;
    const card=document.createElement("article");card.className="discord-card";card.dataset.id=action.id;
    const heading=discordLine(card,(isMessage?"Üzenet · ":"Szerver berendezése · ")+target.label,"h4");
    heading.tabIndex=-1;
    discordLine(card,discordStateLabels[action.state] || action.state,"small");
    if(action.state==="pending"){
      if(isMessage){
        discordLine(card,(target.kind==="dm"?"Privát címzett: ":"Csatorna: ")+target.target,"small");
        discordLine(card,target.text,"pre");
      }else {
        const list=document.createElement("ul");
        list.className="discord-plan";
        for(const role of target.layout.roles)discordLine(list,"Szerepkör · "+role.name,"li");
        for(const category of target.layout.categories){
          const group=discordLine(list,category.name,"li"), children=document.createElement("ul");
          for(const channel of category.channels)discordLine(children,(channel.kind==="voice"?"Hang · ":"Szöveg · ")+channel.name,"li");
          group.append(children);
        }
        card.append(list);
      }
      const commands=document.createElement("div");commands.className="settings-actions";
      commands.append(settingsButton(isMessage?"Jóváhagyás és küldés":"Jóváhagyás és létrehozás",()=>decideDiscord(action.id,true)),
        settingsButton("Elutasítás",()=>decideDiscord(action.id,false)));
      commands.firstElementChild.classList.add("go");
      card.append(commands);
    }
    if(action.result?.error)discordLine(card,action.result.error,"p");
    if(action.result?.created)discordLine(card,`Létrehozva: ${action.result.created.length} · Meglévőként megtartva: ${action.result.kept.length}`,"p");
    if(action.result?.guild || action.result?.channel){
      card.append(settingsButton("Megnyitás a Discordban",()=>openDiscordClient(action.result.guild,action.result.channel,action.result.message)));
    }
    discordActions.append(card);
    if(action.id===discordFocus){heading.focus();discordFocus=null;}
  }
}

async function refreshDiscord(force=false){
  if(!settingsDialog.open || settingsTab!=="discord" || (discordBusy && !force))return;
  try{
    const result=await N.discord.status(), next=JSON.stringify(result);
    if(!settingsDialog.open || settingsTab!=="discord")return;
    if(next!==lastDiscordState || force || discordFocus){paintDiscord(result);lastDiscordState=next;}
  }catch(error){discordFeedback.textContent=error.message.replace(/^Error invoking remote method '[^']+': Error: /,"");}
}
async function discordOperation(fn, pending){
  if(discordBusy)return;
  discordBusy=true;discordFeedback.textContent=pending;
  try{
    await fn();
    discordFeedback.textContent="";
    await refreshDiscord(true);
  }catch(error){discordFeedback.textContent=error.message.replace(/^Error invoking remote method '[^']+': Error: /,"");}
  finally{discordBusy=false;}
}
function decideDiscord(id,approve){
  return discordOperation(()=>N.discord.decide(id,approve),approve?"A Discord végrehajtja a jóváhagyott kérést…":"A kérés elutasítása…");
}
function openDiscordReview(id){
  discordFocus=id;
  if(!settingsDialog.open)$("#accBtn").click();
  discordTab.click();
}
function openDiscordClient(guild,channel,message){
  return N.discord.open(guild,channel,message,$("#discordClient").value);
}
$("#discordClient").onchange=event=>{
  cfg.discordClient=event.target.value;
  N.config.set(cfg).catch(error=>toast(error.message,true));
};
discordTab.addEventListener("click",()=>{
  $("#discordClient").value=cfg.discordClient==="vesktop"?"vesktop":"system";
  clearInterval(discordPoll);refreshDiscord(true);
  discordPoll=setInterval(()=>{
    if(!settingsDialog.open || settingsTab!=="discord"){clearInterval(discordPoll);return;}
    refreshDiscord();
  },4000);
});
settingsDialog.addEventListener("close",()=>{clearInterval(discordPoll);$("#discordToken").value="";});
$("#discordConnect").onsubmit=event=>{
  event.preventDefault();
  const input=$("#discordToken"),token=input.value;
  input.value="";
  discordOperation(()=>N.discord.connect(token),"A bot ellenőrzése…");
};
$("#discordDisconnect").onclick=()=>{
  if(confirm("Leválasztod a Discord-botot? A függő kéréseit elutasítjuk."))
    discordOperation(()=>N.discord.disconnect(),"A bot leválasztása…");
};
$("#discordOpen").onclick=()=>openDiscordClient("@me").catch(error=>toast(error.message,true));
$("#discordPortal").onclick=()=>N.discord.portal().catch(error=>toast(error.message,true));
$("#discordInvite").onclick=()=>{if(discordBot)N.discord.invite(discordBot.id).catch(error=>toast(error.message,true));};
