const fs=require("node:fs");
const path=require("node:path");
const os=require("node:os");
const crypto=require("node:crypto");
const root=path.join(os.homedir(),".neutron-workspaces","uploads");

function storage(chatId){
  if(typeof chatId!=="string" || !chatId || chatId.length>160)throw Error("Hiányzó csevegésazonosító.");
  return path.join(root,crypto.createHash("sha256").update(chatId).digest("hex"));
}

function attachmentPath(chatId,row){
  if(!/^[a-f\d-]{36}(?:\.[a-z\d]{0,15})?$/i.test(row?.id||""))throw Error("Érvénytelen melléklet.");
  return path.join(storage(chatId),row.id);
}

async function importFiles(chatId, paths){
  if(!Array.isArray(paths)||paths.length>8)throw Error("Legfeljebb 8 fájlt csatolhatsz egyszerre.");
  const dir=storage(chatId);
  const added=[];
  try {
    for (const file of paths) {
      if(typeof file!=="string" || !path.isAbsolute(file))throw Error("Érvénytelen fájl.");
      const stat=await fs.promises.stat(file);
      if(!stat.isFile())throw Error("Csak fájlt csatolhatsz.");
      const row={id:crypto.randomUUID(),name:path.basename(file),size:stat.size};
      await fs.promises.mkdir(dir,{mode:0o700,recursive:true});
      const ref=attachmentPath(chatId,row)+".ref.json";
      await fs.promises.writeFile(ref,JSON.stringify({path:file}),{mode:0o600,flag:"wx"});
      added.push(row);
    }
    return added;
  } catch(error) {
    await Promise.allSettled(added.map(row=>removeFile(chatId,row)));
    throw error;
  }
}

function resolveFile(chatId,row){
  const local=attachmentPath(chatId,row),ref=local+".ref.json";
  let filename=local;
  try { filename=JSON.parse(fs.readFileSync(ref,"utf8")).path; }
  catch(error) { if(error.code!=="ENOENT")throw error; }
  // Earlier versions stored a chat-owned copy directly at this path.
  if(typeof filename!=="string" || !path.isAbsolute(filename) || !fs.statSync(filename,{throwIfNoEntry:false})?.isFile())
    throw Error("A melléklet eredeti fájlja már nem érhető el. Ha áthelyezted, csatold újra.");
  return filename;
}
function removeChat(chatId){
  return fs.promises.rm(storage(chatId),{recursive:true,force:true});
}
async function removeFile(chatId,row){
  const local=attachmentPath(chatId,row);
  try { await fs.promises.unlink(local+".ref.json"); }
  catch(error) { if(error.code!=="ENOENT")throw error; await fs.promises.rm(local,{force:true}); }
}
module.exports={importFiles,resolveFile,removeFile,removeChat};
