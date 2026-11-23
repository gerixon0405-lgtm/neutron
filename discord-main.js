const {ipcMain,shell}=require("electron");
const {execFile}=require("node:child_process");
const path=require("node:path");
const runtime=require("./runtime");
const script=path.join(__dirname,"discord_bot.py");

function backend(action,input,timeout){
  return new Promise((resolve,reject)=>{
    const child=execFile(runtime.python,[script,action],{windowsHide:true,timeout,maxBuffer:2*1024*1024},(error,stdout)=>{
      let reply;
      try {reply=JSON.parse(stdout);} catch {}
      if(error || !reply || reply.error)return reject(Error(reply?.error || "A Discord-művelet eredménye nem érhető el."));
      resolve(reply.result);
    });
    child.stdin.on("error",()=>{});
    child.stdin.end(JSON.stringify(input));
  });
}
const snowflake=value=>typeof value==="string" && /^[0-9]{17,20}$/.test(value);

function register(){
  ipcMain.handle("discord:connect",(_,token)=>backend("connect",{token},30000));
  ipcMain.handle("discord:status",()=>backend("status",{},20000));
  ipcMain.handle("discord:disconnect",()=>backend("disconnect",{},20000));
  ipcMain.handle("discord:decide",(_,id,approve)=>{
    if(!/^[a-f0-9]{32}$/.test(id))throw Error("Érvénytelen Discord-kérés.");
    return backend("decide",{id,approve:approve===true});
  });
  ipcMain.handle("discord:portal",()=>shell.openExternal("https://discord.com/developers/applications"));
  ipcMain.handle("discord:invite",(_,id)=>{
    if(!snowflake(id))throw Error("Érvénytelen Discord-bot azonosító.");
    const url=new URL("https://discord.com/oauth2/authorize");
    const permissions=(1<<4)|(1<<10)|(1<<11)|(1<<16)|(1<<28);
    url.search=new URLSearchParams({client_id:id,scope:"bot",permissions:String(permissions)});
    return shell.openExternal(url.href);
  });
  ipcMain.handle("discord:open",(_,guild,channel,message)=>{
    const target=guild==="@me" || snowflake(guild)?guild:"@me";
    const suffix=[target];
    if(snowflake(channel)){
      suffix.push(channel);
      if(snowflake(message))suffix.push(message);
    }
    const route="/channels/"+suffix.join("/");
    return shell.openExternal("discord://-"+route).catch(()=>shell.openExternal("https://discord.com"+route));
  });
}
module.exports={register};
