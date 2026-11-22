const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const win=process.platform==="win32";
const bundled=path.join(process.resourcesPath || __dirname,"python","python.exe");
const python=process.env.NEUTRON_PYTHON || (win ? (fs.existsSync(bundled)?bundled:"python.exe") : "/usr/bin/python3");
if(win)process.env.PYTHONUTF8="1";
function binary(name){
  const dirs=(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  dirs.push(path.join(os.homedir(),".local","bin"));
  if(!win && name==="codex")dirs.push("/usr/lib/chatgpt/resources");
  for(const dir of dirs){
    const choices=[path.join(dir,name+(win?".exe":""))];
    if(win && name==="codex"){
      const arch=process.arch==="arm64"?"aarch64":"x86_64",vendor=path.join("vendor",arch+"-pc-windows-msvc","codex","codex.exe");
      const pkg=path.join(dir,"node_modules","@openai","codex");
      choices.push(path.join(pkg,vendor),path.join(pkg,"node_modules","@openai","codex-win32-"+process.arch,vendor));
    }
    for(const file of choices){try{fs.accessSync(file,fs.constants.X_OK);return file;}catch{}}
  }
  return win?name+".exe":name;
}
module.exports={python,win,binary};
