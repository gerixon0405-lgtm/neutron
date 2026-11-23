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

    await evaluate("document.querySelector('#accBtn').click()");
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
  } finally { ws.close(); }
})().catch(err=>{console.error(err);process.exit(1);});
