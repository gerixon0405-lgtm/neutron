const {app,ipcMain,shell}=require("electron");
const {execFile}=require("node:child_process");
const {createHash,randomBytes}=require("node:crypto");
const http=require("node:http");
const path=require("node:path");
const {python}=require("./runtime");
const redirect="http://127.0.0.1:47812/callback";
const scopes="playlist-read-private playlist-read-collaborative playlist-modify-private playlist-modify-public user-library-modify";
let login;

function account(action, data) {
  return new Promise((resolve,reject)=>{
    const child=execFile(python,[path.join(__dirname,"spotify_api.py"),action],{timeout:15000,windowsHide:true},(error,stdout,stderr)=>{
      if(error)return reject(Error(stderr.trim() || "A Spotify kapcsolat nem elérhető."));
      try { resolve(JSON.parse(stdout)); } catch {reject(Error("A Spotify kapcsolat állapota ismeretlen."));}
    });
    child.stdin.on("error",()=>{});
    child.stdin.end(data ? JSON.stringify(data) : "");
  });
}

async function connect(clientId) {
  clientId=String(clientId||"").trim();
  if(!/^[a-f0-9]{32}$/i.test(clientId))throw Error("Adj meg egy érvényes Spotify Client ID-t.");
  if(login)throw Error("Már folyamatban van egy Spotify-bejelentkezés.");
  const verifier=randomBytes(48).toString("base64url");
  const state=randomBytes(24).toString("base64url");
  const url="https://accounts.spotify.com/authorize?"+new URLSearchParams({
    client_id:clientId,response_type:"code",redirect_uri:redirect,scope:scopes,state,
    code_challenge_method:"S256",code_challenge:createHash("sha256").update(verifier).digest("base64url"),
  });
  const code=await new Promise((resolve,reject)=>{
    const server=http.createServer((req,res)=>{
      let incoming;
      try { incoming=new URL(req.url,redirect); } catch {res.writeHead(400).end();return;}
      const valid=req.method==="GET" && req.headers.host==="127.0.0.1:47812" &&
        incoming.pathname==="/callback" && incoming.searchParams.get("state")===state;
      res.writeHead(valid?200:400,{"Content-Type":"text/plain; charset=utf-8","Connection":"close"});
      res.end(valid?"Visszatérhetsz a Neutronba.":"Érvénytelen kérés.");
      if(!valid)return;
      const code=incoming.searchParams.get("code");
      finish(code?null:Error("A Spotify-hozzáférést nem engedélyezted."),code);
    });
    const timeout=setTimeout(()=>finish(Error("A Spotify-bejelentkezés lejárt.")),180000);
    function finish(error,code) {
      clearTimeout(timeout); server.close(); login=null;
      if(error)reject(error);else resolve(code);
    }
    login=()=>finish(Error("A Neutron bezárult."));
    server.once("error",()=>finish(Error("A Spotify bejelentkezési portja (47812) nem használható.")));
    server.listen(47812,"127.0.0.1",()=>shell.openExternal(url).catch(finish));
  });
  const reply=await fetch("https://accounts.spotify.com/api/token",{
    method:"POST",body:new URLSearchParams({client_id:clientId,code,code_verifier:verifier,redirect_uri:redirect,grant_type:"authorization_code"}),
    signal:AbortSignal.timeout(15000),redirect:"error"
  });
  if(!reply.ok)throw Error("A Spotify elutasította a bejelentkezést. Ellenőrizd a Client ID-t és az átirányítási címet.");
  const token=await reply.json();
  return account("store",{clientId,token});
}

function register(){
  ipcMain.handle("spotify:status",()=>account("status"));
  ipcMain.handle("spotify:connect",(_,id)=>connect(id));
  ipcMain.handle("spotify:disconnect",()=>account("disconnect"));
  app.on("before-quit",()=>login?.());
}
module.exports={register};
