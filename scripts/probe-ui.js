const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  for(let i=0;i<60;i++){
    const tabs=await fetch("http://127.0.0.1:19283/json/list").then(r=>r.json()).catch(()=>[]);
    const page=tabs.find(t=>t.url.endsWith("/index.html"));
    if(page){
      const ws=new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((ok,err)=>{ws.onopen=ok;ws.onerror=err;});
      const response=new Promise((ok,err)=>{ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id===1)ok(m.result?.result?.value);};ws.onerror=err;});
      ws.send(JSON.stringify({id:1,method:"Runtime.evaluate",params:{expression:"(async()=>{if(!chat)return false; const request={chatId:chat.id,requestId:'smoke',tool:'Bash',input:{command:'echo smoke'}}; pendingPermissions.add(request); live.set(chat.id,{}); renderQuickPermission(); const strip=document.querySelector('#quickPermission'); const shown=!strip.hidden && document.querySelector('#quickPermissionInput').textContent==='echo smoke'; document.querySelector('#quickPermissionDeny').click(); live.delete(chat.id); if(!shown || !strip.hidden || request.answer!=='deny') return false; document.querySelector('#accBtn').click(); const u=await N.updates.status(); return document.querySelector('#settingsDialog').open && u.enabled && !!u.version;})()",awaitPromise:true,returnByValue:true}}));
      const ok=await response;ws.close();if(ok)return;
    }
    await pause(1000);
  }
  throw Error("Packaged settings did not open with updates enabled");
})().catch(err=>{console.error(err);process.exit(1);});
