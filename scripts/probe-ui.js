const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));

async function connect() {
  for (let i=0;i<60;i++) {
    const tabs = await fetch(`http://127.0.0.1:${process.env.NEUTRON_TEST_PORT || 19283}/json/list`).then(r=>r.json()).catch(()=>[]);
    const page = tabs.find(tab=>tab.url.endsWith("/index.html"));
    if (page) {
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((ok,err)=>{ws.onopen=ok;ws.onerror=err;});
      return ws;
    }
    await pause(1000);
  }
  throw Error("No packaged app window");
}

(async()=>{
  const ws = await connect();
  let id = 0;
  function call(method,params) {
    const request = ++id;
    const response = new Promise((resolve,reject)=>{
      ws.onmessage = event=>{
        const msg = JSON.parse(event.data);
        if (msg.id!==request) return;
        if(msg.error || msg.result?.exceptionDetails) {
          reject(Error(msg.error?.message || msg.result.exceptionDetails.exception?.description));
        } else resolve(msg.result);
      };
      ws.onerror = reject;
    });
    ws.send(JSON.stringify({id:request,method,params}));
    return response;
  }
  const evaluate = async expression=>(await call("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true})).result.value;
  async function wait(expression) {
    for(let i=0;i<60;i++){
      if(await evaluate(expression)) return;
      await pause(500);
    }
    throw Error("Timed out: "+expression);
  }
  async function screenshot(label) {
    if(!process.env.NEUTRON_SCREENSHOTS) return;
    await pause(600);
    const {data}=await call("Page.captureScreenshot",{format:"png"});
    fs.writeFileSync(process.env.NEUTRON_SCREENSHOTS+"/"+label+".png",Buffer.from(data,"base64"));
  }
  try {
    await wait("document.querySelector('#onboardingDialog').open");
    await screenshot("welcome");
    await evaluate(`(()=>{
      const form=document.querySelector('#welcomeForm');
      form.elements.name.value='Dani';
      document.querySelector('#welcomeNext').click();
      form.querySelector('[value=mint]').click();
      form.querySelector('[value=fjord]').click();
      if(document.documentElement.dataset.background!=='fjord') throw Error('Wallpaper preview missing');
      if(document.documentElement.dataset.theme!=='mint') throw Error('Theme preview missing');
      form.elements.motion.value='reduced';
      document.querySelector('#welcomeNext').click();
      form.elements.sound.click();
      document.querySelector('#welcomeNext').click();
    })()`);
    await wait("!document.querySelector('#onboardingDialog').open");
    if (process.env.NEUTRON_EXISTING_PROFILE) {
      await wait("document.querySelector('#releaseDialog').open");
      await screenshot("release");
      await evaluate("document.querySelector('#closeRelease').click()");
    }
    await wait("document.querySelector('.hero h2')?.textContent.includes('Dani') && document.documentElement.dataset.motion==='reduced'");
    await screenshot("home");
    const toolbar=await evaluate(`(()=>{
      if(!document.querySelector('#composer').contains(document.querySelector('#modelChip')))return false;
      chat.provider="default";chat.model="opus";renderEffort();
      document.querySelector('#effortChip').click();
      const visible=!document.querySelector('#effortBar').hidden;
      document.querySelector('#effortSlider').dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
      document.querySelector('#projectHubBtn').click();
      const hub=document.querySelector('#projectHub'), opened=hub.open && hub.contains(document.querySelector('#projectSelect'));
      hub.close();
      return visible && document.querySelector('#effortBar').hidden && opened;
    })()`);
    if(!toolbar)throw Error("Chat toolbar or project navigation did not work");
    await evaluate(`(()=>{
      chat.extraDirs=Array.from({length:20},(_,i)=>home+'/popup-folder-'+i);
      document.querySelector('#modeChip').click();
    })()`);
    await wait("document.querySelector('.pop')?.querySelectorAll('button.opt').length===25");
    await pause(320);
    const menu = await evaluate(`(()=>{
      const root=document.querySelector('.pop'), rect=root.getBoundingClientRect();
      const anchor=document.querySelector('#modeChip').getBoundingClientRect();
      return {x:rect.left+rect.width/2,y:rect.top+rect.height/2,
        inBounds:rect.top>=0 && rect.bottom<anchor.top && rect.right<=innerWidth && root.scrollHeight>root.clientHeight};
    })()`);
    if(!menu.inBounds)throw Error("Permission menu is clipped or does not scroll");
    await call("Input.dispatchMouseEvent",{type:"mouseWheel",x:menu.x,y:menu.y,deltaY:2500,deltaX:0});
    await wait(`(()=>{
      const p=document.querySelector('.pop'), last=p.querySelector('.opt:last-child');
      return p.scrollTop>0 && last.getBoundingClientRect().bottom<=p.getBoundingClientRect().bottom;
    })()`);
    const option = await evaluate(`(()=>{
      const r=document.querySelector('.pop .opt:last-child').getBoundingClientRect();
      return {x:r.left+r.width/2,y:r.top+r.height/2};
    })()`);
    await call("Input.dispatchMouseEvent",{type:"mousePressed",...option,button:"left",clickCount:1});
    await call("Input.dispatchMouseEvent",{type:"mouseReleased",...option,button:"left",clickCount:1});
    await wait("!document.querySelector('.pop') && chat.extraDirs.length===19");
    await evaluate("chat.extraDirs=[];save(chat)");
    await evaluate(`document.querySelector('#dirChip').click()`);
    await wait("!document.querySelector('#contextPane').hidden && document.querySelector('.context-folder')");
    const context=await evaluate(`(()=>{
      paintContext({report:{used:120000,max:400000,compactAt:380000,
        categories:[{name:'Üzenetek',tokens:110000,kind:'used'},{name:'Tartalék',tokens:10000,kind:'buffer'}],
        groups:[{name:'MCP-eszközök',rows:[{name:'fixture',tokens:123}]}]}});
      const pane=document.querySelector('#contextPane');
      return pane.querySelector('.context-totals').textContent.includes('30%') &&
        pane.querySelectorAll('.context-bar span').length===2 && pane.textContent.includes('fixture') &&
        [...pane.querySelector('#compactThreshold').options].some(option=>option.value==="400000");
    })()`);
    if(!context)throw Error("Missing context breakdown or compaction controls");
    if(process.env.NEUTRON_TEST_CONTEXT)
      await wait("document.querySelector('.context-totals')?.textContent.includes('47%')");
    await screenshot("context");
    await evaluate("document.querySelector('#closeContext').click()");
    await evaluate(`(async()=>{
      const p=await N.projects.create('Galéria tesztprojekt');
      await N.artifacts.create({projectId:p.id},'oldal.html','<h1>Előnézet ellenőrzése</h1>');
      document.querySelector('#artifactsBtn').click();
      document.querySelector('#newArtifact').click();
      document.querySelector('#artifactDraftName').value='galéria-jegyzet.md';
      document.querySelector('#artifactDraftContent').value='# Szerkeszthető dokumentum';
      const form=document.querySelector('#artifactEditorForm');
      form.requestSubmit(form.querySelector('button[type=submit]'));
    })()`);
    await wait("document.querySelectorAll('.gallery-card').length===2 && document.querySelector('#artifactSelect').value==='galéria-jegyzet.md'");
    await evaluate("document.querySelector('#closeFiles').click()");
    await screenshot("gallery");
    const gallery=await evaluate(`(()=>{
      const select=document.querySelector('#galleryScope');
      select.value='projects';select.dispatchEvent(new Event('input'));
      const cards=document.querySelectorAll('.gallery-card');
      if(cards.length!==1 || !cards[0].textContent.includes('Galéria tesztprojekt'))return false;
      cards[0].click();return !document.querySelector('#artifactPane').hidden;
    })()`);
    if(!gallery)throw Error("Artifact gallery is missing project files or preview");
    await wait("document.querySelector('#artifactSelect').value==='oldal.html' && document.querySelector('#previewSlot iframe')?.hasAttribute('sandbox')");
    await evaluate("document.querySelector('[data-view=chat]').click()");
    const importer=await evaluate(`(()=>{
      showChooser();
      document.querySelector('#importFromChooser').click();
      const visible=document.querySelector('#claudeImportDialog').open &&
        document.querySelector('#claudeImportAccount').value==='default';
      document.querySelector('#closeClaudeImport').click();
      return visible;
    })()`);
    if(!importer)throw Error("Claude Desktop import dialog did not open");
    const videoTab=await evaluate(`(()=>{
      models=["fixture/minimax-m3.1-flash"];
      document.querySelector('#input').value="Vágd meg ezt a videót";
      send();
      const picked=JSON.parse(document.querySelector('#videoModel').value);
      const ok=view==="video" && !document.querySelector('#videoView').inert &&
        picked.id==="fixture/minimax-m3.1-flash" && document.querySelector('#videoBrief').value==="Vágd meg ezt a videót";
      setView("chat");
      return ok;
    })()`);
    if(!videoTab)throw Error("Video handoff or recommended model was missing");
    await evaluate(`(()=>{
      document.querySelector('#charactersBtn').click();
      document.querySelector('#addProfile').click();
      const form=document.querySelector('#characterForm');
      document.querySelector('#characterName').value="Teszt karakter";
      document.querySelector('#characterProvider').value="codex";
      document.querySelector('#characterProvider').dispatchEvent(new Event("change"));
      form.requestSubmit(form.querySelector('button[type=submit]'));
    })()`);
    await wait("cfg.characters?.some(character=>character.name==='Teszt karakter' && character.prompt==='')");
    await evaluate("document.querySelector('#closeCharacters').click()");


    const fixtures=fs.mkdtempSync(path.join(os.tmpdir(),"neutron-drop-"));
    try{
      const filename=path.join(fixtures,"jegyzet.txt");
      fs.writeFileSync(filename,"Melléklet ellenőrzés");
      await evaluate("document.body.insertAdjacentHTML('beforeend','<input type=file id=testDrop hidden>')");
      const {root}=await call("DOM.getDocument",{});
      const {nodeId}=await call("DOM.querySelector",{nodeId:root.nodeId,selector:"#testDrop"});
      await call("DOM.setFileInputFiles",{nodeId,files:[filename]});
      await evaluate(`(()=>{
        const drag=new DataTransfer();
        drag.items.add(document.querySelector('#testDrop').files[0]);
        document.querySelector('#chatView').dispatchEvent(new DragEvent('drop',{dataTransfer:drag,bubbles:true,cancelable:true}));
      })()`);
      await wait("document.querySelector('#composerFiles')?.textContent.includes('jegyzet.txt')");
      await evaluate("document.querySelector('#composerFiles button').click()");
      await wait("document.querySelector('#composerFiles').hidden");
    } finally { fs.rmSync(fixtures,{recursive:true,force:true}); }

    const thinking = await evaluate(`(async()=>{
      newChat();
      const original=chat;
      live.set(original.id,{});
      const turn=newTurn(original);
      turn.started=Date.now()-62000;
      setBusyUi();
      if(!document.querySelector('.typing') || document.querySelector('#chatClock time').textContent!=='1:02') return false;
      const block={type:'thinking',text:'Első gondolat',expanded:true};
      appendBlock(original,turn,block);
      document.querySelector('.think summary').click();
      newChat();
      if(!document.querySelector('#chatClock').hidden) return false;
      block.text+=' és a folytatása';
      schedule(original,block);
      await selectChat(original.id);
      const details=document.querySelector('.think');
      if(details.open || !details.classList.contains('live') || !details.textContent.includes('és a folytatása')) return false;
      details.querySelector('summary').click();
      newChat(); await selectChat(original.id);
      if(!document.querySelector('.think').open || document.querySelector('#chatClock').hidden) return false;
      finishTurn(original,turn);
      return document.querySelector('#chatClock').hidden && turn.elapsedMs>=62000 &&
        document.querySelector('.turn-meta').textContent===elapsedTime(turn.elapsedMs) && document.querySelector('.think').open;
    })()`);
    if(!thinking) throw Error("Thinking and elapsed time were lost on chat switches");
    const worker=await evaluate(`(async()=>{
      newChat(null,'default');
      const target=chat;
      live.set(target.id,{});
      const turn=newTurn(target);
      recordClaudeTask(target,{subtype:'task_started',task_id:'agent-example',tool_use_id:'tool-example',description:'Próba alügynök'},live.get(target.id));
      finishTurn(target,turn);
      if(!taskReports.get(turn) || !document.querySelector('.claude-task[data-status=running]'))return false;
      newChat();
      recordClaudeTask(target,{subtype:'task_notification',task_id:'agent-example',status:'completed',summary:'Az alügynök elkészült.',usage:{total_tokens:42,tool_uses:2}});
      await selectChat(target.id);
      const card=document.querySelector('.claude-task');
      return card?.dataset.status==='completed' && card.textContent.includes('Az alügynök elkészült.') &&
        card.textContent.includes('42 token') && !taskReports.get(turn);
    })()`);
    if(!worker)throw Error("Background Claude task did not remain in the chat after the parent finished");
    await evaluate("document.querySelector('#accBtn').click()");
    if(!await evaluate("document.querySelector('#claudeEconomy').checked"))throw Error("Claude economy is not on by default");
    const quota = await evaluate(`(()=>{
      if(document.querySelector('[data-panel=ai]').hidden) return false;
      const card=document.createElement('div');
      paintUsage(card,{rows:[{window:'session',minutes:300,percent:24,reset:1795526460000},
        {window:'weekly',scope:'Sonnet',percent:91,reset:1795526460000}]});
      return card.querySelector('progress').value===24 && card.querySelector('progress.near-limit').value===91 &&
        !!card.querySelector('time').dateTime && card.textContent.includes('Heti keret · Sonnet');
    })()`);
    if(!quota) throw Error("AI quota windows did not render");
    if(process.env.NEUTRON_TEST_QUOTAS)
      await wait("document.querySelector('[data-usage-account=codex] progress') && document.querySelector('[data-usage-account=default] progress')");
    await screenshot("settings");
    await evaluate("document.querySelector('[data-settings=appearance]').click()");
    const {root}=await call("DOM.getDocument",{});
    const {nodeId}=await call("DOM.querySelector",{nodeId:root.nodeId,selector:"#appearanceForm .background-file"});
    await call("DOM.setFileInputFiles",{nodeId,files:[path.resolve("wallpapers/nebula.webp")]});
    await wait("document.documentElement.dataset.background==='custom'");
    await evaluate("document.querySelector('#appearanceForm').requestSubmit(document.querySelector('#appearanceForm button[type=submit]'))");
    await wait("(async()=>{const settings=await N.config.get();return settings.appearance?.background==='custom' && !!settings.appearance.customBackground;})()");
    await evaluate("document.querySelector('#settingsClose').click()");
    const result = await evaluate(`(async()=>{
      const request={chatId:chat.id,requestId:'smoke',tool:'Bash',input:{command:'echo smoke'}};
      pendingPermissions.add(request);live.set(chat.id,{});renderQuickPermission();
      const strip=document.querySelector('#quickPermission');
      if(strip.hidden || document.querySelector('#quickPermissionInput').textContent!=='echo smoke') return false;
      document.querySelector('#quickPermissionDeny').click();live.delete(chat.id);
      if(!strip.hidden || request.answer!=='deny') return false;
      const saved=await N.config.get();
      if(saved.appearance?.theme!=='mint' || !saved.appearance?.sound || !saved.seenRelease) return false;
      document.querySelector('#accBtn').click();
      document.querySelector('[data-settings=discord]').click();
      if(!document.querySelector('#discordClient option[value=vesktop]')) return false;
      if(document.querySelector('#discordToken').type!=='password' || document.querySelector('#discordToken').closest('section').hidden) return false;
      paintDiscord({bot:{id:'1',name:'Neutron teszt'},actions:[{id:'test',bot:'1',kind:'message',state:'pending',
        payload:{kind:'dm',label:'Teszt címzett',target:'123',text:'Jóváhagyandó üzenet'}}]});
      if(!document.querySelector('#discordActions').textContent.includes('Jóváhagyandó üzenet') ||
         !document.querySelector('#discordActions .go')?.textContent.includes('küldés'))return false;
      document.querySelector('[data-settings=updates]').click();
      document.querySelector('#showReleaseNotes').click();
      const u=await N.updates.status();
      return document.querySelector('#settingsDialog').open &&
        document.querySelector('#releaseDialog').open && !!u.version && (${!!process.env.NEUTRON_DEV_TEST} || u.enabled);
    })()`);
    if(!result) throw Error("Packaged appearance, notes or settings did not work");
    await screenshot("notes");
    await evaluate(`(()=>{
      document.querySelector('#releaseDialog').close();
      document.querySelector('[data-settings=appearance]').click();
      const form=document.querySelector('#appearanceForm');
      form.querySelector('[name=theme][value=glass]').click();
      form.requestSubmit(form.querySelector('button[type=submit]'));
    })()`);
    await wait("(async()=> document.documentElement.dataset.theme==='glass' && (await N.config.get()).appearance.theme==='glass')()");
    const login=await evaluate("N.startup.status()");
    if(!process.env.NEUTRON_DEV_TEST && !login.available)throw Error("Installed startup settings are unavailable");
    if(login.available){
      await evaluate("document.querySelector('[data-settings=startup]').click()");
      await wait("!document.querySelector('#startupToggle').disabled");
      try{
        if(login.enabled)await evaluate("N.startup.set(false)");
        await evaluate("refreshStartup()");
        await evaluate("document.querySelector('#startupToggle').click()");
        await wait("(async()=> !document.querySelector('#startupToggle').disabled && (await N.startup.status()).enabled)()");
        await screenshot("startup");
        await evaluate("document.querySelector('#startupToggle').click()");
        await wait("(async()=> !document.querySelector('#startupToggle').disabled && !(await N.startup.status()).enabled)()");
      }finally{await evaluate("N.startup.set("+!!login.enabled+")");}
    }
    await evaluate(`(async()=>{
      document.querySelector('#releaseDialog').close();
      document.querySelector('#settingsDialog').close();
      newChat();
      chat.items=[{role:'user',text:'Előnézet'},{role:'assistant',blocks:[{type:'text',text:'Liquid Glass a beszélgetésben.'}]}];
      renderChat();
      if(document.querySelector('.msg.assistant .avatar').offsetWidth<44 ||
        getComputedStyle(document.querySelector('.topbar')).backdropFilter==='none')
        throw Error('Larger chat avatar or glass surface missing');
    })()`);
    await screenshot("glass");
    await evaluate(`(async()=>{
      newChat();
      chat.title='Rögzíthető próbachat';
      globalThis.probePinnedId=chat.id;
      await save(chat);
      newChat();
      chat.title='Frissebb próbachat';
      await save(chat);
      await refreshList();
      const row=[...document.querySelectorAll('.chat-item')].find(item=>item.textContent.includes('Rögzíthető próbachat'));
      row.querySelector('.pin-chat').click();
    })()`);
    await wait("document.querySelector('.chat-item')?.textContent.includes('Rögzíthető próbachat') && document.querySelector('.pin-chat').getAttribute('aria-pressed')==='true'");
    if(!await evaluate("(async()=>!!(await N.chats.load(probePinnedId)).pinnedAt)()"))throw Error("Pin did not persist");
    await evaluate(`(async()=>{
      document.querySelector('#schedulesBtn').click();
      await N.schedules.save({kind:'reminder',title:'Próbaemlékeztető',text:'Ütemezett értesítés',nextAt:Date.now()+700,repeat:'once'});
      document.querySelector('#closeSchedules').click();
    })()`);
    await wait("document.querySelector('.notice-content')?.textContent.includes('Próbaemlékeztető')");
    await evaluate("document.querySelector('.notice-content').click()");
    await wait("document.querySelector('#schedulesDialog').open && document.querySelector('#scheduleList').textContent.includes('Befejezve')");
    await evaluate(`(()=>{
      const select=document.querySelector('#scheduleRepeat');
      select.value='startup';select.dispatchEvent(new Event('change'));
      if(!document.querySelector('#scheduleAt').disabled || document.querySelector('#startupScheduleHelp').hidden)
        throw Error('Boot trigger still requires a date');
      document.querySelector('#scheduleName').value='Próba rendszerindítás';
      const form=document.querySelector('#scheduleForm');
      form.requestSubmit(form.querySelector('button[type=submit]'));
    })()`);
    await wait("(async()=> (await N.schedules.list()).some(job=>job.repeat==='startup' && job.title==='Próba rendszerindítás' && !job.lastAt))()");
    await screenshot("schedules");
    await evaluate("document.querySelector('#closeSchedules').click()");
  } finally { ws.close(); }
})().catch(err=>{console.error(err);process.exit(1);});
