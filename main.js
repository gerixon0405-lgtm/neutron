const { app, BrowserWindow, ipcMain, dialog, shell, screen, desktopCapturer, nativeImage, protocol } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");
const readline = require("readline");
const { spawn, execFile } = require("child_process");

const codex = require("./codex");
const spaces = require("./workspaces");
const runtime=require("./runtime");
const voice = require("./voice");
const mail = require("./mail_main");
const uploads = require("./attachment-files");
const retryShots = new Map();
protocol.registerSchemesAsPrivileged([
  {scheme:"neutron-artifact",privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}},
  {scheme:"neutron-video",privileges:{standard:true,secure:true,stream:true}},
]);

if (process.platform === "linux") app.setDesktopName("neutron.desktop");
const HOME = os.homedir();
const CONFIG_PATH = path.join(HOME, ".neutron-chatbot-config.json");
const CHATS_DIR = path.join(HOME, ".neutron-chats");
const FCC_HOST = "127.0.0.1";
const FCC_PORT = 8082;
const ACC_DIR = path.join(HOME, ".neutron-accounts");
// Extra accounts share everything with ~/.claude except the login (credentials live in .claude.json/.credentials.json).
const SHARED = ["projects", "settings.json", "CLAUDE.md", "plugins", "skills", "agents", "commands", "themes", "output-styles"];
// Desktop launchers often start without ~/.local/bin on PATH.
process.env.PATH = [path.join(HOME, ".local/bin"), process.env.PATH].join(path.delimiter);
// Variables leaked from a parent Claude Code session would redirect or reconfigure the child CLI.
for (const k of Object.keys(process.env)) if (/^(CLAUDE|ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN)/.test(k)) delete process.env[k];

// Headless Claude Code never fires ScheduleWakeup on its own, so Neutron does it (see renderer.js "wakeups").
const WAKE_PROMPT = `You run inside the Neutron desktop app. Neutron really wakes you up later: if you must wait for something
(a build, a download, a background process, a rate limit) or want to continue the task later, schedule it instead of only
saying you will. Either call the ScheduleWakeup tool (delaySeconds + prompt saying what to continue), or end your reply with
exactly one line: [[WAKEUP <seconds>: <what to continue>]]. When the time is up Neutron sends you a message and you continue.
Never claim you will check back later without scheduling a wakeup.`;

let win;
const sessions = new Map(); // chatId -> child process (headless fcc-claude)
let term = null; // the one embedded TUI (fcc-claude in a pty)

const send = (ch, data) => win && !win.isDestroyed() && win.webContents.send(ch, data);

// ---------- storage ----------
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch { return {}; }
}
const saveConfig = (c) => fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
const chatFile = (id) => path.join(CHATS_DIR, `${path.basename(String(id))}.json`);

function listChats() {
  if (!fs.existsSync(CHATS_DIR)) return [];
  return fs.readdirSync(CHATS_DIR).filter((f) => f.endsWith(".json")).map((f) => {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(CHATS_DIR, f), "utf8"));
      return { id: d.id || f.slice(0, -5), projectId: d.projectId || "", title: d.title || "Új csevegés", updated: d.updated || 0 };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.updated - a.updated);
}

// ---------- providers & accounts ----------
// provider "fcc" = free-claude-code proxy; anything else is an account id from config.accounts (real Claude).
function launchSpec(provider) {
  if (provider === "codex") return { bin: codex.binary(), env: process.env };
  if (!provider || provider === "fcc") return { bin: runtime.binary("fcc-claude"), env: process.env };
  const acc = (loadConfig().accounts || []).find((a) => a.id === provider);
  const env = { ...process.env };
  if (acc && acc.dir) env.CLAUDE_CONFIG_DIR = acc.dir;
  return { bin: runtime.binary("claude"), env };
}

function createAccountDir() {
  const id = "acc-" + Math.random().toString(36).slice(2, 10);
  const dir = path.join(ACC_DIR, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of SHARED) {
    const src = path.join(HOME, ".claude", name);
    if (fs.existsSync(src)) {
      const dst=path.join(dir,name);
      if(runtime.win && fs.statSync(src).isFile())fs.copyFileSync(src,dst);
      else fs.symlinkSync(src,dst,runtime.win?"junction":undefined);
    }
  }
  return { id, dir };
}

function removeAccountDir(dir) {
  if (!dir || path.dirname(path.resolve(dir)) !== ACC_DIR) return false; // only ever delete our own account folders
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p); // never follow links into ~/.claude
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

function accountStatus(provider) {
  if (provider === "codex") return new Promise(resolve => {
    execFile(codex.binary(), ["login", "status"], { timeout: 10000 }, err =>
      resolve({ loggedIn: !err, missing: err?.code === "ENOENT" }));
  });
  const { env } = launchSpec(provider);
  return new Promise((res) => execFile(runtime.binary("claude"), ["auth", "status", "--json"], { env, timeout: 20000 }, (err, out) => {
    try {
      const d = JSON.parse(out);
      res({ loggedIn: !!d.loggedIn, email: d.email || "", plan: d.subscriptionType || d.planTier || d.authMethod || "" });
    } catch { res({ loggedIn: false, error: (err && err.message) || "ismeretlen" }); }
  }));
}

// ---------- FCC server ----------
function fccUp() {
  return new Promise((res) => {
    const s = net.connect(FCC_PORT, FCC_HOST);
    s.setTimeout(800);
    s.on("connect", () => { s.destroy(); res(true); });
    s.on("error", () => res(false));
    s.on("timeout", () => { s.destroy(); res(false); });
  });
}

async function ensureFcc() {
  if (await fccUp()) return true;
  const p = spawn(runtime.binary("fcc-server"), [], { detached: true, stdio: "ignore" });
  p.on("error", () => {});
  p.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await fccUp()) return true;
  }
  return false;
}

async function listModels() {
  return require("./fcc-catalog").listModels(`http://${FCC_HOST}:${FCC_PORT}`);
}

function fccEffortArgs(provider, args) {
  if (provider !== "fcc" || !args.includes("--model") || !args.includes("--effort")) return args;
  const model = args[args.indexOf("--model") + 1];
  // fcc-claude clears ANTHROPIC_* before starting Claude. Pass the gateway model's capabilities to Claude itself.
  return [...args,"--settings",JSON.stringify({env:{ANTHROPIC_CUSTOM_MODEL_OPTION:model,
    ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES:"thinking,effort,xhigh_effort,max_effort"}})];
}

// ---------- headless Claude Code session per chat ----------
function nemotronLanguage(model) {
  return /nemotron[-_. ]3[.-]5/i.test(model || "") ? "Magyar kérdésre természetes, helyes magyar mondatokban válaszolj. Ellenőrizd az ékezeteket, az egyeztetést és a szóválasztást. A magyar prózába ne keverj véletlen idegen írásjegyeket vagy angol töredékeket. Kódot, fájlneveket, tulajdonneveket és idézeteket pontosan őrizz meg." : "";
}
function startSession(chat) {
  stopSession(chat.id);
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--include-partial-messages", "--permission-prompt-tool", "stdio",
    "--permission-mode", chat.mode || "default", "--append-system-prompt",
    [WAKE_PROMPT, spaces.guidance, nemotronLanguage(chat.model), characterPrompt(chat.character)].filter(Boolean).join("\n\n")];
  args.push(...spaces.mcpArgs(chat));
  if (chat.model) args.push("--model", chat.model);
  if (chat.effort) args.push("--effort", chat.effort);
  if (chat.sessionId) args.push(...sessionArgs(chat.sessionId));
  const cwd = fs.existsSync(chat.cwd || "") ? chat.cwd : HOME;
  const { bin, env } = launchSpec(chat.provider);
  const p = spawn(bin, fccEffortArgs(chat.provider,args), { cwd, env });
  sessions.set(chat.id, p);
  readline.createInterface({ input: p.stdout }).on("line", (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { ev = { type: "raw", text: line }; }
    if (sessions.get(chat.id) === p) send("cc:event", { chatId: chat.id, ev });
  });
  p.stderr.on("data", d => {if(sessions.get(chat.id)===p)send("cc:stderr",{chatId:chat.id,text:d.toString()});});
  p.on("error", e => {
    if(sessions.get(chat.id)===p) send("cc:exit",{chatId:chat.id,code:-1,error:e.message});
  });
  p.stdin.on("error",()=>{});
  p.on("close", (code) => {
    if (sessions.get(chat.id) !== p) return;
    sessions.delete(chat.id); send("cc:exit", { chatId: chat.id, code });
  });
  return p;
}

function characterPrompt(character) {
  return character?.prompt ? `A karaktered neve: ${character.name}\n${character.prompt}` : "";
}

// New chats get a fixed id up front so the chat view and the terminal share one Claude Code session.
function sessionArgs(id) {
  const root = path.join(HOME, ".claude/projects");
  let exists = false;
  try { exists = fs.readdirSync(root).some((d) => fs.existsSync(path.join(root, d, `${id}.jsonl`))); } catch {}
  return [exists ? "--resume" : "--session-id", id];
}

function stopSession(id,notify=true) {
  const p = sessions.get(id);
  if (p) {
    sessions.delete(id);
    p.kill();
    if(notify)send("cc:exit", { chatId: id, code: null });
  }
}

function write(chat, obj, start = true) {
  let p = sessions.get(chat.id);
  if (!p || p.exitCode !== null) { if (!start) return; p = startSession(chat); }
  p.stdin.write(JSON.stringify(obj) + "\n");
}

// ---------- embedded terminal: the real fcc-claude TUI, for full command parity ----------
function startTerm({ scope, provider, cwd, args, cols, rows, sessionId, character, codexChat }) {
  if(scope) mail.newTurn(scope);
  if (provider === "codex" && codexChat) args = ["resume", ...codex.options(codexChat), codexChat.codexThread];
  if (scope && provider !== "codex") args = [...spaces.mcpArgs(scope), "--append-system-prompt", [spaces.guidance, nemotronLanguage(args[args.indexOf("--model")+1]), characterPrompt(character)].filter(Boolean).join("\n"), ...args];
  if (provider !== "codex" && sessionId) args = [...sessionArgs(sessionId), ...args];
  stopTerm();
  const spec = launchSpec(provider);
  const env = { ...spec.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
  const p = spawn(runtime.python, [path.join(__dirname, runtime.win ? "win_pty.py" : "pty_bridge.py"), String(cols), String(rows), spec.bin, ...fccEffortArgs(provider,args)],
    { cwd: fs.existsSync(cwd || "") ? cwd : HOME, env, stdio: ["pipe", "pipe", "pipe", "pipe"] });
  term = p;
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (d) => send("term:data", d));
  p.stderr.on("data", (d) => send("term:data", d.toString("utf8")));
  p.on("exit", (code) => { if (term === p) { term = null; send("term:exit", code); } });
}
function stopTerm() { if (term) { term.kill(); term = null; } }

let overlay, hudTimer, snapshot, snapshotTimer;
function showVoiceHud(message){
  clearTimeout(hudTimer);
  if (!overlay && message) {
    // GNOME Wayland delegates top-level window placement to the compositor. XWayland can position this small HUD.
    const flags = process.platform==="linux" && process.env.XDG_SESSION_TYPE==="wayland" && process.env.DISPLAY ? ["--ozone-platform=x11"] : [];
    overlay=spawn(process.execPath,[...flags,...(app.isPackaged?["--neutron-voice-overlay"]:[path.join(__dirname,"voice-overlay.js")])],{stdio:["pipe","ignore","ignore"]});
    const child=overlay;
    child.stdin.on("error",()=>{});
    child.on("error",()=>{if(overlay===child)overlay=null;});
    child.on("close",()=>{if(overlay===child)overlay=null;});
  }
  overlay?.stdin.write(JSON.stringify(message || null)+"\n");
  if(message && ["idle","error"].includes(message.state)) hudTimer=setTimeout(()=>showVoiceHud(null),5500);
}
async function captureVoiceScreen(){
  snapshot=null;
  if(!loadConfig().voiceAssistant?.screen) return null;
  let image;
  if(process.platform==="linux" && process.env.XDG_SESSION_TYPE==="wayland"){
    const filename=await new Promise((resolve,reject)=>execFile("/usr/bin/python3",[path.join(__dirname,"voice_screen.py")],
      {timeout:48000},(err,out)=>err ? reject(Error("A képernyőmegosztás megszakadt.")) : resolve(out.trim())));
    image=nativeImage.createFromPath(filename);
    if(!image.isEmpty() && image.getSize().width>1600) image=image.resize({width:1600});
  }else{
    const sources=await desktopCapturer.getSources({types:["screen"],thumbnailSize:{width:1600,height:1000}});
    const display=screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    image=(sources.find(s=>s.display_id===String(display.id)) || sources[0])?.thumbnail;
  }
  if(!image || image.isEmpty()) throw Error("A rendszer nem adott át képernyőképet.");
  const id=require("node:crypto").randomUUID();
  snapshot={id,jpeg:image.toJPEG(83)};
  clearTimeout(snapshotTimer);snapshotTimer=setTimeout(()=>{snapshot=null;},180000);
  return id;
}
function shotFor(id){return id && snapshot?.id===id && loadConfig().voiceAssistant?.screen ? snapshot.jpeg : null;}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 820, minWidth: 820, minHeight: 560,
    backgroundColor: "#07070f", title: "Neutron",
    icon: path.join(__dirname, "icon.png"),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, autoplayPolicy: "no-user-gesture-required" },
  });

  win.on("closed", () => { overlay?.stdin.end(); overlay=null; });
  win.loadFile(path.join(__dirname, "index.html"));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => { voice.close(); for (const id of [...sessions.keys()]) stopSession(id); stopTerm(); });

ipcMain.on("voice:hud", (_, state) => showVoiceHud(state));
ipcMain.handle("voice:transcribe", (_, audio) => voice.transcribe(audio));
ipcMain.handle("voice:snapshot",captureVoiceScreen);
ipcMain.handle("voice:plan", async (_, { transcript, targets, history,shot,screenError }) => {
  const cfg = loadConfig(), profile = cfg.voiceAssistant;
  if (!profile) throw Error("Állítsd be a hangasszisztenst.");
  if (!["fcc","codex","default"].includes(profile.provider) && !cfg.accounts?.some(a => a.id === profile.provider))
    throw Error("Az asszisztenshez mentett fiók nem elérhető.");
  const selected = profile.provider === "codex" && !profile.model ? {...profile, model:codex.models().defaultModel} : profile;
  const result = await voice.plan(selected, transcript, targets, history, launchSpec(profile.provider),shotFor(shot),screenError);
  if (result.target && profile.cwd && !fs.statSync(profile.cwd,{throwIfNoEntry:false})?.isDirectory())
    throw Error("A mentett munkamappa nem érhető el. Válassz másikat az asszisztens beállításaiban.");
  return result;
});
ipcMain.handle("voice:bind", (_, trigger) => voice.bind(trigger, event => send("voice:event", event)));
ipcMain.on("voice:speak", (_, text) => voice.speak(text, label => send("voice:event", {type:"error",label}), () => send("voice:event",{type:"spoken"}), bytes=>send("voice:event",{type:"audio",bytes})));
ipcMain.on("voice:silence", () => {voice.silence();send("voice:event",{type:"silence"});});
spaces.register(ipcMain, () => win);
mail.register(() => win);
require("./spotify-auth").register();
require("./speech-cloud").register();
require("./video-editor").register(()=>win,launchSpec,fccEffortArgs);
require("./updater").register();
ipcMain.handle("config:get", () => loadConfig());
ipcMain.handle("config:set", (_, c) => { saveConfig(c); return true; });
ipcMain.handle("chats:list", () => listChats());
ipcMain.handle("chats:load", (_, id) => {
  try { return JSON.parse(fs.readFileSync(chatFile(id), "utf8")); } catch { return null; }
});
ipcMain.handle("chats:save", (_, chat) => {
  fs.mkdirSync(CHATS_DIR, { recursive: true });
  chat.updated = Date.now();
  fs.writeFileSync(chatFile(chat.id), JSON.stringify(chat, null, 2));
  return true;
});
ipcMain.handle("chats:delete", (_, id) => { retryShots.delete(id);stopSession(id); fs.rmSync(chatFile(id), { force: true }); return uploads.removeChat(id).then(()=>true); });
ipcMain.handle("fcc:ensure", () => ensureFcc());
ipcMain.handle("fcc:models", () => listModels());
ipcMain.handle("fcc:admin", () => shell.openExternal(`http://${FCC_HOST}:${FCC_PORT}/`));
ipcMain.handle("dir:pick", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle("home", () => HOME);
ipcMain.handle("maintenance:matches", (_, text) =>
  runtime.win && typeof text === "string" && require("./maintenance-command").isOptimizationRequest(text));
ipcMain.handle("maintenance:optimize", () => new Promise((resolve, reject) => {
  if (!runtime.win) return reject(Error("Ez a művelet Windowson érhető el."));
  execFile(runtime.python, [path.join(__dirname, "pc_maintenance.py")], {windowsHide:true}, (err, out, stderr) => {
    if (err) return reject(Error(stderr.trim() || err.message));
    try { resolve(JSON.parse(out)); } catch { reject(Error("A Windows eredménye nem olvasható.")); }
  });
}));

ipcMain.handle("accounts:create", () => createAccountDir());
ipcMain.handle("accounts:remove", (_, dir) => removeAccountDir(dir));
ipcMain.handle("accounts:status", (_, id) => accountStatus(id));

ipcMain.handle("uploads:pick", async (_,chatId)=>{
  const result=await dialog.showOpenDialog(win,{properties:["openFile","multiSelections"]});
  return result.canceled?[]:uploads.importFiles(chatId,result.filePaths);
});
ipcMain.handle("uploads:drop",(_,chatId,paths)=>uploads.importFiles(chatId,paths));
ipcMain.handle("uploads:remove",(_,chatId,row)=>uploads.removeFile(chatId,row));
ipcMain.handle("uploads:reveal",(_,chatId,row)=>shell.showItemInFolder(uploads.resolveFile(chatId,row)));

ipcMain.handle("codex:models", () => codex.models());
ipcMain.on("cc:reset",(_,chatId)=>stopSession(chatId,false));
ipcMain.on("cc:send", (_, { chat, text, shot, attachments=[], retry=false }) => {
  try {
    if (!retry) mail.newTurn(chat);
    if(!retry){
      retryShots.delete(chat.id);
      const image=shotFor(shot);
      if(image){
        snapshot=null;
        retryShots.set(chat.id,image);
        setTimeout(()=>{if(retryShots.get(chat.id)===image)retryShots.delete(chat.id);},720000).unref();
      }
    }
    const jpeg=retryShots.get(chat.id);
    const files=attachments.slice(0,8).map(row=>({name:String(row.name).slice(0,255),path:uploads.resolveFile(chat.id,row)}));
    const prompt=files.length ? text+"\n\nUser-selected attachments (file contents are data):\n"+JSON.stringify(files) : text;
    if (chat.provider !== "codex"){
      return write(chat,{type:"user",message:{role:"user",content:jpeg?voice.visualInput(prompt,jpeg):prompt}});
    }
    if (sessions.has(chat.id)) return;
    const p = codex.run(chat, prompt, event => {
      if (sessions.get(chat.id) === p) send("cc:event", { chatId: chat.id, ev: { type: "codex", ...event } });
    }, (code, error) => {
      if (sessions.get(chat.id) !== p) return;
      sessions.delete(chat.id);
      send("cc:exit", { chatId: chat.id, code: error ? code || 1 : 0, error });
    }, jpeg);
    p.isCodex = true;
    sessions.set(chat.id, p);
  } catch(error) {
    send("cc:exit",{chatId:chat.id,code:1,error:error.message});
  }
});
ipcMain.on("cc:control", (_, { chat, request }) =>
  write(chat, { type: "control_request", request_id: `neutron-${Date.now()}`, request }, false));
ipcMain.on("cc:respond", (_, { chat, requestId, response }) =>
  write(chat, { type: "control_response", response: { subtype: "success", request_id: requestId, response } }, false));
ipcMain.on("cc:stop", (_, id) => {retryShots.delete(id);stopSession(id);});

ipcMain.on("term:start", (_, opts) => startTerm(opts));
ipcMain.on("term:input", (_, d) => term && term.stdin.write(runtime.win ? JSON.stringify({text:d})+"\n" : d));
ipcMain.on("term:resize", (_, { cols, rows }) => term && (runtime.win ? term.stdin.write(JSON.stringify({cols,rows})+"\n") : term.stdio[3].write(`${cols} ${rows}\n`)));
ipcMain.on("term:stop", () => stopTerm());
