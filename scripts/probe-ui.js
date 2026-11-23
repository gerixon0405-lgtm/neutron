const fs = require("node:fs");
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
