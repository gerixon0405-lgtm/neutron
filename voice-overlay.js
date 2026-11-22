const { app,BrowserWindow,screen }=require("electron");
const path=require("node:path");
const readline=require("node:readline");
const cache=path.join(require("node:os").homedir(),".cache","neutron-voice-overlay");
require("node:fs").mkdirSync(cache,{recursive:true,mode:0o700});
app.setPath("userData",cache);
let win,state,ready=false;
function paint(){
  if(!ready) return;
  if(!state) {win.hide();return;}
  const box=screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  win.setBounds({x:box.x+box.width-398,y:box.y+18,width:380,height:100});
  win.webContents.send("voice:hud-state",state);win.showInactive();
}
readline.createInterface({input:process.stdin}).on("line",line=>{try{state=JSON.parse(line);paint();}catch{}}).on("close",()=>app.quit());
app.whenReady().then(()=>{
  win=new BrowserWindow({width:380,height:100,show:false,frame:false,focusable:false,skipTaskbar:true,alwaysOnTop:true,resizable:false,
    backgroundColor:"#181323",webPreferences:{preload:path.join(__dirname,"preload.js"),sandbox:true,contextIsolation:true,nodeIntegration:false}});
  win.setAlwaysOnTop(true,"screen-saver");win.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});win.setIgnoreMouseEvents(true);
  win.webContents.once("did-finish-load",()=>{ready=true;paint();});
  win.loadFile(path.join(__dirname,"voice-hud.html"));
});
