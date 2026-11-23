const runtime=require("./runtime");
const {spawn}=require("node:child_process");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const crypto=require("node:crypto");
const readline=require("node:readline");
const script=path.join(__dirname,"mail_outbox.py");
const root=path.join(os.homedir(),".local/share/neutron/mail");
const turnPath=chat=>path.join(root,"turns",crypto.createHash("sha256").update(chat.id).digest("hex"));
function newTurn(chat){
  const file=turnPath(chat),tmp=file+"-"+crypto.randomUUID();
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  fs.writeFileSync(tmp,crypto.randomUUID(),{mode:0o600});fs.renameSync(tmp,file);
}
function register(getWindow){
  const {app,dialog,ipcMain,shell}=require("electron");
  let worker,closing=false,login;
  function start(){
    if(closing) return;
    worker=spawn(runtime.python,[script,"worker"],{stdio:["pipe","ignore","ignore"]});
    worker.on("error",()=>{});
    worker.once("close",()=>{worker=null;if(!closing)setTimeout(start,4000).unref();});
  }
  app.whenReady().then(start);
  app.on("before-quit",()=>{closing=true;worker?.stdin.end();login?.kill();});
  function run(action,input={}){
    const auth=action==="smtp" || action==="oauth";
    if(auth && login) throw Error("Már folyamatban van egy Gmail-bejelentkezés.");
    return new Promise((resolve,reject)=>{
      const p=spawn(runtime.python,[script,action],{stdio:["pipe","pipe","ignore"]});
      if(auth)login=p;
      let reply;
      readline.createInterface({input:p.stdout}).on("line",line=>{
        try{
          const data=JSON.parse(line);
          if(data.open && action==="oauth"){
            const url=new URL(data.open);
            if(url.origin==="https://accounts.google.com" && url.pathname==="/o/oauth2/v2/auth")
              shell.openExternal(url.href).catch(()=>{p.kill();reject(Error("A böngésző nem indult el."));});
          }else reply=data;
        }catch{}
      });
      p.once("error",reject);
      p.once("close",code=>{
        if(login===p)login=null;
        if(code!==0 || !reply || reply.error)reject(Error(reply?.error || "A Gmail-művelet megszakadt."));
        else resolve(reply.result);
      });
      p.stdin.on("error",()=>{});p.stdin.end(JSON.stringify(input));
    });
  }
  ipcMain.handle("mail:status",(_,batch)=>run("status",{batch}));
  ipcMain.handle("mail:cancel",(_,batch)=>run("cancel",{batch}));
  ipcMain.handle("mail:smtp",(_,email,password)=>run("smtp",{email,password}));
  ipcMain.handle("mail:disconnect",(_,sender)=>run("disconnect",{sender}));
  ipcMain.handle("mail:select",(_,sender)=>run("select",{sender}));
  ipcMain.handle("mail:password-page",()=>shell.openExternal("https://myaccount.google.com/apppasswords"));
  ipcMain.handle("mail:oauth",async()=>{
    let client={client_id:process.env.NEUTRON_GOOGLE_CLIENT_ID,client_secret:process.env.NEUTRON_GOOGLE_CLIENT_SECRET};
    if(!client.client_id || !client.client_secret){
      const picked=await dialog.showOpenDialog(getWindow(),{title:"Google Desktop app OAuth-kliens",properties:["openFile"],filters:[{name:"Google OAuth-kliens",extensions:["json"]}]});
      if(picked.canceled)return null;
      try{client=JSON.parse(await fs.promises.readFile(picked.filePaths[0],"utf8")).installed;}catch{client=null;}
      if(!client?.client_id || !client?.client_secret)throw Error("Válaszd a Google Cloudból letöltött Desktop app OAuth-kliens JSON-fájlját.");
    }
    return run("oauth",{client:{client_id:client.client_id,client_secret:client.client_secret}});
  });
}
module.exports={register,newTurn,turnPath};
