const {app,ipcMain}=require("electron");
function register(){
  let state={message:"A forrásból indított példány fejlesztői változat.",version:app.getVersion()},check;
  if(app.isPackaged && require("./package.json").neutronStoreBuild){
    state.message="A frissítéseket a Microsoft Store kezeli.";
  }else if(app.isPackaged && (process.platform==="win32" || process.env.APPIMAGE)){
    const {autoUpdater}=require("electron-updater");
    autoUpdater.autoDownload=true;
    autoUpdater.autoInstallOnAppQuit=true;
    autoUpdater.allowPrerelease=false;
    const set=message=>{state={message,version:app.getVersion()};};
    set("Az automatikus frissítés be van kapcsolva.");
    autoUpdater.on("checking-for-update",()=>set("Új verzió keresése…"));
    autoUpdater.on("update-not-available",()=>set("A telepített verzió naprakész."));
    autoUpdater.on("update-available",info=>set("Új verzió letöltése · "+info.version));
    autoUpdater.on("download-progress",p=>set("Frissítés letöltése · "+Math.round(p.percent)+"%"));
    autoUpdater.on("update-downloaded",info=>set("A "+info.version+" verzió letöltve. Kilépéskor települ."));
    autoUpdater.on("error",()=>set("A frissítés ellenőrzése sikertelen. Később újrapróbáljuk."));
    check=()=>autoUpdater.checkForUpdates().catch(()=>{});
    app.whenReady().then(()=>{setTimeout(check,10000).unref();setInterval(check,6*60*60*1000).unref();});
  }
  ipcMain.handle("update:status",()=>({...state,enabled:!!check}));
  ipcMain.handle("update:check",async()=>{await check?.();return state;});
}
module.exports={register};
