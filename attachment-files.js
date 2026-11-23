const fs=require("node:fs");
const path=require("node:path");
const os=require("node:os");
const crypto=require("node:crypto");
const root=path.join(os.homedir(),".neutron-workspaces","uploads");
const maxSize=20*1024*1024;
const imageExt=/\.(png|jpe?g|webp|gif)$/i;
function storage(chatId){
  if(typeof chatId!=="string" || !chatId || chatId.length>160)throw Error("Hiányzó csevegésazonosító.");
  return path.join(root,crypto.createHash("sha256").update(chatId).digest("hex"));
}
async function importFiles(chatId, paths){
  if(!Array.isArray(paths)||paths.length>8)throw Error("Legfeljebb 8 fájlt csatolhatsz egyszerre.");
  const added=[];
  const dir=storage(chatId);
  try{
    for(const file of paths){
      if(typeof file!=="string" || !path.isAbsolute(file))throw Error("Érvénytelen fájl.");
      const stat=await fs.promises.stat(file);
      if(!stat.isFile()||stat.size>maxSize)throw Error("Csak fájl csatolható, legfeljebb 20 MB méretig.");
      const name=path.basename(file), id=crypto.randomUUID();
      const ext=path.extname(name).replace(/[^.a-zA-Z0-9]/g,"").slice(0,16);
      const copy=path.join(dir,id+ext);
      await fs.promises.mkdir(dir,{mode:0o700,recursive:true});
      await fs.promises.copyFile(file,copy,fs.constants.COPYFILE_EXCL);
      const row={id:id+ext,name,size:stat.size};
      added.push(row);
      if((await fs.promises.stat(copy)).size>maxSize)throw Error("A fájl mérete csatolás közben megváltozott.");
    }
    return added;
  }catch(error){
    await Promise.allSettled(added.map(row=>fs.promises.unlink(path.join(dir,row.id))));
    throw error;
  }
}
function resolveFile(chatId,row){
  if(!/^[a-f\d-]{36}(?:\.[a-z\d]{0,15})?$/i.test(row?.id||""))throw Error("Érvénytelen melléklet.");
  const filename=path.join(storage(chatId),row.id);
  const stat=fs.statSync(filename,{throwIfNoEntry:false});
  if(!stat?.isFile() || stat.size>maxSize)throw Error("A melléklet már nem érhető el.");
  return filename;
}
function removeChat(chatId){
  return fs.promises.rm(storage(chatId),{recursive:true,force:true});
}
function removeFile(chatId,row){
  return fs.promises.unlink(resolveFile(chatId,row));
}
module.exports={importFiles,resolveFile,removeFile,removeChat,imageExt};
