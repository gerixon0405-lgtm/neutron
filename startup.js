const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const loginName = "io.github.gerixon0405.neutron";
const managedKey = "X-Neutron-Managed=true";

function desktopEntry(executable, extract=false) {
  if (!path.isAbsolute(executable) || /[\x00-\x1f=]/.test(executable)) throw Error("Az alkalmazás elérési útja nem használható indítófájlban.");
  const quoted = executable.replace(/["\\$`]/g, "\\$&").replace(/%/g,"%%").replace(/\\/g,"\\\\");
  // GLib verifies the executable name before unescaping percent codes.
  const launcher=extract ? "/usr/bin/env -- APPIMAGE_EXTRACT_AND_RUN=1 " : executable.includes("%") ? "/usr/bin/env -- " : "";
  return [
    "[Desktop Entry]", "Type=Application", "Name=Neutron", 'Exec='+launcher+'"'+quoted+'"',
    "Terminal=false", "Icon=neutron", managedKey, "",
  ].join("\n");
}

function linuxLogin(configDirectory) {
  const filename=path.join(configDirectory,"autostart",loginName+".desktop");
  function read() {
    try {
      if (!fs.lstatSync(filename).isFile()) throw Error("A Neutron indítófájlja nem hagyományos fájl.");
      return fs.readFileSync(filename,"utf8");
    } catch(error) {
      if (error.code==="ENOENT") return "";
      throw error;
    }
  }
  function status() {
    const data=read();
    if(data && !data.split(/\r?\n/).includes(managedKey))
      return {available:false,enabled:false,message:"Már létezik egy kézzel létrehozott Neutron-indító."};
    return {available:true,enabled:!!data && !/^(?:Hidden=true|X-GNOME-Autostart-enabled=false)\s*$/mi.test(data)};
  }
  function set(enabled, executable, extract) {
    const current=status();
    if(!current.available)throw Error(current.message);
    if(!enabled)fs.rmSync(filename,{force:true});
    else {
      const content=desktopEntry(executable,extract);
      fs.mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});
      const temp=filename+"."+randomUUID()+".tmp";
      try {
        fs.writeFileSync(temp,content,{flag:"wx",mode:0o600});
        fs.renameSync(temp,filename);
      }finally{fs.rmSync(temp,{force:true});}
    }
    return status();
  }
  return {status,set};
}

function loginController(app) {
  const format=process.platform;
  const appImage=process.env.APPIMAGE;
  const extract=["1","true"].includes(process.env.APPIMAGE_EXTRACT_AND_RUN);
  const supported=app.isPackaged && (format==="win32" || (format==="linux" && appImage));
  const directory=process.env.XDG_CONFIG_HOME;
  const linux=linuxLogin(directory && path.isAbsolute(directory)?directory:path.join(os.homedir(),".config"));
  const unavailable={available:false,enabled:false,message:"A kapcsoló a telepített Windows-verzióban és a Linux AppImage-ben érhető el."};
  function status() {
    if(!supported)return unavailable;
    if(format==="linux")return linux.status();
    const items=app.getLoginItemSettings({path:process.execPath,args:[]}).launchItems;
    return {available:true,enabled:items.some(item=>item.scope==="user" && item.name===loginName && item.enabled)};
  }
  function set(enabled) {
    if(!supported)throw Error(unavailable.message);
    if(format==="linux")return linux.set(enabled,appImage,extract);
    app.setLoginItemSettings({openAtLogin:enabled,enabled,path:process.execPath,args:[],name:loginName});
    return status();
  }
  function updateAppImage(executable) {
    if(format==="linux" && supported && linux.status().enabled)linux.set(true,executable,extract);
  }
  return {status,set,updateAppImage};
}

async function systemBootId() {
  if(process.platform==="linux") {
    const id=(await fs.promises.readFile("/proc/sys/kernel/random/boot_id","utf8")).trim();
    return /^[0-9a-f-]{36}$/i.test(id) ? "linux:"+id : "";
  }
  if(process.platform==="win32") {
    const command="(Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().Ticks";
    return new Promise((resolve,reject)=>execFile("powershell.exe",["-NoLogo","-NoProfile","-NonInteractive","-Command",command],
      {timeout:8000,windowsHide:true},(error,output)=>{
        if(error)return reject(error);
        const id=output.trim();
        resolve(/^\d{16,20}$/.test(id)?"windows:"+id:"");
      }));
  }
  return "";
}

module.exports={desktopEntry,linuxLogin,loginController,systemBootId};
