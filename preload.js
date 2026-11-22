const { contextBridge, ipcRenderer } = require("electron");

const on = (ch) => (fn) => {
  const h = (_, d) => fn(d);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

if (location.pathname.endsWith("/voice-hud.html")) contextBridge.exposeInMainWorld("onVoiceState", on("voice:hud-state"));
else if (process.isMainFrame && location.protocol === "file:") contextBridge.exposeInMainWorld("neutron", {
  projects: { open: id => ipcRenderer.invoke("projects:open",id), list: () => ipcRenderer.invoke("projects:list"), create: name => ipcRenderer.invoke("projects:create", name) },
  artifacts: {
    list: scope => ipcRenderer.invoke("artifacts:list", scope),
    importPack: (scope,name) => ipcRenderer.invoke("artifacts:import",scope,name),
    close: () => ipcRenderer.invoke("artifacts:close"),
    collect: (scope,request) => ipcRenderer.invoke("artifacts:collect",scope,request),
    preview: (scope,name) => ipcRenderer.invoke("artifacts:preview", scope,name),
    export: (scope,name) => ipcRenderer.invoke("artifacts:export", scope,name),
  },
  updates: { status:()=>ipcRenderer.invoke("update:status"),check:()=>ipcRenderer.invoke("update:check") },
  mail: {
    status: batch=>ipcRenderer.invoke("mail:status",batch || ""), cancel: id=>ipcRenderer.invoke("mail:cancel",id),
    smtp: (email,password)=>ipcRenderer.invoke("mail:smtp",email,password), oauth: ()=>ipcRenderer.invoke("mail:oauth"),
    disconnect: ()=>ipcRenderer.invoke("mail:disconnect"), passwordPage: ()=>ipcRenderer.invoke("mail:password-page"),
  },
  config: { get: () => ipcRenderer.invoke("config:get"), set: (c) => ipcRenderer.invoke("config:set", c) },
  chats: {
    list: () => ipcRenderer.invoke("chats:list"),
    load: (id) => ipcRenderer.invoke("chats:load", id),
    save: (c) => ipcRenderer.invoke("chats:save", c),
    delete: (id) => ipcRenderer.invoke("chats:delete", id),
  },
  fcc: {
    ensure: () => ipcRenderer.invoke("fcc:ensure"),
    models: () => ipcRenderer.invoke("fcc:models"),
    admin: () => ipcRenderer.invoke("fcc:admin"),
  },
  voice: {
    hud: state => ipcRenderer.send("voice:hud", state),
    snapshot: () => ipcRenderer.invoke("voice:snapshot"),
    transcribe: bytes => ipcRenderer.invoke("voice:transcribe", bytes),
    plan: data => ipcRenderer.invoke("voice:plan", data),
    bind: key => ipcRenderer.invoke("voice:bind", key),
    speak: text => ipcRenderer.send("voice:speak", text),
    silence: () => ipcRenderer.send("voice:silence"),
    onEvent: on("voice:event"),
  },
  codexModels: () => ipcRenderer.invoke("codex:models"),
  maintenance: {
    matches: text => ipcRenderer.invoke("maintenance:matches", text),
    optimize: () => ipcRenderer.invoke("maintenance:optimize")
  },
  pickDir: () => ipcRenderer.invoke("dir:pick"),
  accounts: {
    create: () => ipcRenderer.invoke("accounts:create"),
    remove: (dir) => ipcRenderer.invoke("accounts:remove", dir),
    status: (id) => ipcRenderer.invoke("accounts:status", id),
  },
  home: () => ipcRenderer.invoke("home"),
  cc: {
    send: (chat, text, shot) => ipcRenderer.send("cc:send", { chat, text, shot }),
    control: (chat, request) => ipcRenderer.send("cc:control", { chat, request }),
    respond: (chat, requestId, response) => ipcRenderer.send("cc:respond", { chat, requestId, response }),
    stop: (id) => ipcRenderer.send("cc:stop", id),
    onEvent: on("cc:event"),
    onStderr: on("cc:stderr"),
    onExit: on("cc:exit"),
  },
  term: {
    start: (opts) => ipcRenderer.send("term:start", opts),
    input: (d) => ipcRenderer.send("term:input", d),
    resize: (s) => ipcRenderer.send("term:resize", s),
    stop: () => ipcRenderer.send("term:stop"),
    onData: on("term:data"),
    onExit: on("term:exit"),
  },
});
