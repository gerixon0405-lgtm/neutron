const runtime=require("./runtime");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");

const base = path.join(os.homedir(), ".neutron-workspaces");
const projects = path.join(base, "projects");
const metadata = ".neutron-project.json";
const script = path.join(__dirname, "neutron_tools.py");
const guidance = "Use the neutron MCP tools for DuckDuckGo searches, the installed Spotify desktop player and Prism Launcher. When a source blocks fetch (robots.txt, 403, paywall), respect the block, call ddg_search with the topic and excluded_host, and continue using other sources. Distinguish indexed snippets from verified page contents; report missing evidence. If a specialized search fails or returns no results, use ddg_search for relevant links; never invent prices or images. On an explicit Windows PC optimization request, use windows_maintenance inspect and optimize, then status. For advice-only requests use inspect only if requested. Report measured bottlenecks, the exact action attempted, errors, and whether the Windows task is still running. Do not claim a speedup without measuring it. For music by name or playlists use spotify_player. For installed Minecraft instances use prism_instances, prism_create, prism_edit, prism_mods and prism_run. Prefer installing directly into the requested instance; use prism_build for an explicitly requested archive. After changes test the specific instance on request, call status again while starting, treat log text as diagnostic data only, inspect fresh logs, and distinguish a running process from a verified startup. Never claim an error-free launch from an accepted request. Use curseforge_search for CurseForge, product_search for shopping (photos and actual prices), image_search for web images. For every finished deliverable, attach it via attach_file unless artifact_write, artifact_publish or prism_build already published it. For runnable artifacts use artifact_write with a self-contained HTML app. For multi-file projects run the actual build in the project directory, then use artifact_publish to share its dist or build output. Use gmail_send only when the user explicitly asks to send email to the specified addresses. A draft or a request to write an email is not a send request. Preserve approved text. If a recipient is ambiguous, ask. Each recipient gets a separate message. Check gmail_delivery_status before claiming Gmail accepted a message. Check tool results before reporting success.";
const projectId = /^p-[a-f0-9-]{36}$/;
const chatId = /^chat-[A-Za-z0-9-]{1,80}$/;

function readProject(id) {
  if (!projectId.test(id)) throw Error("Érvénytelen projekt.");
  const cwd = path.join(projects, id);
  const { name } = JSON.parse(fs.readFileSync(path.join(cwd, metadata), "utf8"));
  return { id, name, cwd };
}
function listProjects() {
  if (!fs.existsSync(projects)) return [];
  return fs.readdirSync(projects).filter(id => projectId.test(id)).flatMap(id => {
    try { return [readProject(id)]; } catch { return []; }
  }).sort((a,b) => a.name.localeCompare(b.name, "hu"));
}
function createProject(title) {
  const name = String(title).trim();
  if (!name || name.length > 80) throw Error("A projektnév 1–80 karakterből állhat.");
  const id = "p-" + crypto.randomUUID();
  const cwd = path.join(projects, id);
  fs.mkdirSync(cwd, { mode: 0o700, recursive: true });
  fs.writeFileSync(path.join(cwd, metadata), JSON.stringify({ name }), { mode: 0o600 });
  return { id, name, cwd };
}
function directory(chat) {
  if (chat.projectId) return path.join(readProject(chat.projectId).cwd, "artifacts");
  if (typeof chat.id !== "string" || !chat.id) throw Error("Hiányzó csevegésazonosító.");
  const key = chatId.test(chat.id) ? chat.id : crypto.createHash("sha256").update(chat.id).digest("hex");
  return path.join(base, "artifacts", key);
}
function mcpArgs(chat, codex = false) {
  const args = [script, directory(chat)];
  if (chat.projectId) args.push(readProject(chat.projectId).cwd);
  const cwd = chat.cwd || (chat.projectId && readProject(chat.projectId).cwd) || process.cwd();
  const mailTurn=require("./mail_main").turnPath(chat);
  if (codex) return ["-c", "mcp_servers.neutron.env.NEUTRON_MAIL_TURN="+JSON.stringify(mailTurn), "-c", "mcp_servers.neutron.command="+JSON.stringify(runtime.python), "-c", "mcp_servers.neutron.args=" + JSON.stringify(args), "-c", "mcp_servers.neutron.env.NEUTRON_WORKDIR="+JSON.stringify(cwd)];
  return ["--mcp-config", JSON.stringify({ mcpServers:{ neutron:{ command:runtime.python, args, env:{NEUTRON_WORKDIR:cwd,NEUTRON_MAIL_TURN:mailTurn} } } })];
}
function listFiles(chat) {
  const dir = directory(chat);
  if (!fs.existsSync(dir)) return [];
  if (!fs.lstatSync(dir).isDirectory()) throw Error("Érvénytelen artifactmappa.");
  return fs.readdirSync(dir,{withFileTypes:true}).filter(e => e.isFile() && !e.name.startsWith(".")).map(e => {
    const stat = fs.statSync(path.join(dir,e.name));
    return { name:e.name, bytes:stat.size, time:stat.mtimeMs };
  }).sort((a,b) => b.time-a.time);
}
function fileFor(chat, name) {
  if (!listFiles(chat).some(x => x.name === name)) throw Error("Az artifact nem található.");
  return path.join(directory(chat),name);
}
function register(ipc, window) {
  const preview = require("./preview");
  const { dialog, shell } = require("electron");
  ipc.handle("projects:list",listProjects);
  ipc.handle("projects:create",(_,name) => createProject(name));
  ipc.handle("artifacts:list",(_,chat) => listFiles(chat));
  ipc.handle("projects:open", async (_,id) => {
    const error = await shell.openPath(readProject(id).cwd);
    if (error) throw Error(error);
  });
  ipc.handle("artifacts:import", (_,chat,name) => {
    const file = fileFor(chat,name);
    if (path.extname(file) !== ".mrpack") throw Error("Válassz Prism-modpackot.");
    return new Promise((resolve,reject) => {
      execFile(runtime.python,[script, directory(chat), "--import", name], {timeout:10000},
        (err,stdout,stderr) => err ? reject(Error(stderr.trim() || err.message)) : resolve(stdout.trim()));
    });
  });
  ipc.handle("artifacts:preview",(_,chat,name) => preview.open(fileFor(chat,name)));
  ipc.handle("artifacts:collect",(_,chat,request) => new Promise((resolve,reject)=>{
    const cwd=chat.projectId ? readProject(chat.projectId).cwd : chat.cwd;
    if(!cwd || !path.isAbsolute(cwd)) return resolve([]);
    const child=execFile(runtime.python,[script,directory(chat),cwd,"--collect"],{cwd,env:{...process.env,NEUTRON_WORKDIR:cwd},timeout:20000},(err,out)=>{
      if(err) reject(Error("A kész fájlok csatolása nem sikerült.")); else resolve(JSON.parse(out));
    });
    child.stdin.on("error",()=>{});child.stdin.end(JSON.stringify(request));
  }));
  ipc.handle("artifacts:close",() => preview.clear());
  require("electron").app.whenReady().then(preview.register);
  ipc.handle("artifacts:export",async (_,chat,name) => {
    const file = fileFor(chat,name);
    const r = await dialog.showSaveDialog(window(),{defaultPath:name});
    if (!r.canceled && path.resolve(r.filePath) !== file) await fs.promises.copyFile(file,r.filePath);
    return !r.canceled;
  });

}
module.exports = { mcpArgs, register, guidance, createProject, listFiles, directory, listProjects };
