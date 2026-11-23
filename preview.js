const runtime=require("./runtime");
const {app,protocol} = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const {randomUUID} = require("node:crypto");
const {promisify} = require("node:util");
const run = promisify(require("node:child_process").execFile);
const scheme = "neutron-artifact";
const types = {html:"text/html",htm:"text/html",svg:"image/svg+xml",js:"text/javascript",mjs:"text/javascript",css:"text/css",json:"application/json",png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",webp:"image/webp",gif:"image/gif",ico:"image/x-icon",woff:"font/woff",woff2:"font/woff2",wasm:"application/wasm"};
let current, version=0;
async function clear() {
  version++;
  const old=current; current=null;
  if(old?.dir) await fs.rm(old.dir,{recursive:true,force:true});
}
function register() {
  protocol.handle(scheme, async req => {
    const url=new URL(req.url), entry=current;
    if (!entry || entry.key!==url.hostname) return new Response(null,{status:404});
    try {
      const sub=decodeURIComponent(url.pathname).slice(1);
      if(!sub || sub.split("/").some(p=>!p || p.startsWith(".") || p.includes("\\"))) return new Response(null,{status:404});
      if(!entry.dir && sub!==entry.name) return new Response(null,{status:404});
      const file=entry.dir ? path.join(entry.dir,sub) : entry.file;
      const ext=path.extname(file).slice(1).toLowerCase();
      const mime=entry.dir ? types[ext] : (["html","htm","svg","png","jpg","jpeg","webp","gif"].includes(ext) ? types[ext] : "text/plain");
      const origin=scheme+"://"+entry.key;
      return new Response(await fs.readFile(file), {headers:{
        "Content-Type":(mime||"application/octet-stream") + (/^(text\/|image\/svg)/.test(mime||"") ? "; charset=utf-8" : ""),
        "Content-Security-Policy":`default-src 'none'; script-src ${origin} 'unsafe-inline'; style-src ${origin} 'unsafe-inline'; img-src ${origin} data: blob:; font-src ${origin} data:; media-src ${origin} blob:; connect-src ${origin}; form-action 'none'; base-uri 'none'; frame-src 'none'`,
        "Access-Control-Allow-Origin":"*", "X-Content-Type-Options":"nosniff", "Cache-Control":"no-store"
      }});
    } catch { return new Response(null,{status:404}); }
  });
}
async function open(file) {
  const job=++version;
  const ext=path.extname(file).toLowerCase();
  let dir,name=path.basename(file);
  if(!/^[.](zip|html?|svg|png|jpe?g|webp|gif|md|txt|css|m?js|json|py|csv|xml|yaml|yml)$/.test(ext)) return null;
  if((await fs.stat(file)).size>8000000) throw Error("Az előnézet mérethatára 8 MB.");
  try {
    if(ext===".zip") {
      dir=await fs.mkdtemp(path.join(os.tmpdir(),"neutron-preview-"));
      await run(runtime.python,[path.join(__dirname,"preview_bundle.py"),file,dir],{timeout:12000});
      name="index.html";
    }
    if(job!==version) return null;
    const old=current;
    current={file,dir,name,key:randomUUID()};
    dir=null;
    if(old?.dir) fs.rm(old.dir,{recursive:true,force:true}).catch(()=>{});
    return scheme+"://"+current.key+"/"+encodeURIComponent(name);
  } finally { if(dir) await fs.rm(dir,{recursive:true,force:true}); }
}
app.on("before-quit",()=>{if(current?.dir) require("node:fs").rmSync(current.dir,{recursive:true,force:true});});
module.exports={register,open,clear};
