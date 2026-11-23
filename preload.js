const { contextBridge, ipcRenderer, webUtils } = require("electron");

const on = (ch) => (fn) => {
  const h = (_, d) => fn(d);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

if (location.pathname.endsWith("/voice-hud.html")) contextBridge.exposeInMainWorld("onVoiceState", on("voice:hud-state"));
else if (process.isMainFrame && location.protocol === "file:") contextBridge.exposeInMainWorld("neutron", {
  uploads:{
    pick:id=>ipcRenderer.invoke("uploads:pick",id),
    drop:(id,files)=>ipcRenderer.invoke("uploads:drop",id,files.map(file=>webUtils.getPathForFile(file))),
    remove:(id,row)=>ipcRenderer.invoke("uploads:remove",id,row),
    reveal:(id,row)=>ipcRenderer.invoke("uploads:reveal",id,row),
  },
  video:{
    pick:kind=>ipcRenderer.invoke("video:pick",kind),
    drop:files=>ipcRenderer.invoke("video:drop","video",files.map(file=>webUtils.getPathForFile(file))),
    fromChat:(id,file)=>ipcRenderer.invoke("video:from-chat",id,file),
    plan:options=>ipcRenderer.invoke("video:plan",options),
    render:options=>ipcRenderer.invoke("video:render",options),
    save:(id,kind)=>ipcRenderer.invoke("video:save",id,kind),
    cancel:()=>ipcRenderer.invoke("video:cancel"),
    onProgress:on("video:progress"),
  },
  projects: { open: id => ipcRenderer.invoke("projects:open",id), list: () => ipcRenderer.invoke("projects:list"), create: name => ipcRenderer.invoke("projects:create", name) },
  artifacts: {
    list: scope => ipcRenderer.invoke("artifacts:list", scope),
    importPack: (scope,name) => ipcRenderer.invoke("artifacts:import",scope,name),
    close: () => ipcRenderer.invoke("artifacts:close"),
    collect: (scope,request) => ipcRenderer.invoke("artifacts:collect",scope,request),
    preview: (scope,name) => ipcRenderer.invoke("artifacts:preview", scope,name),
    export: (scope,name) => ipcRenderer.invoke("artifacts:export", scope,name),
  },
  updates: { notes:()=>ipcRenderer.invoke("update:notes"), status:()=>ipcRenderer.invoke("update:status"),check:()=>ipcRenderer.invoke("update:check") },
  discord:{
    connect:token=>ipcRenderer.invoke("discord:connect",token),
    status:()=>ipcRenderer.invoke("discord:status"),
    disconnect:()=>ipcRenderer.invoke("discord:disconnect"),
    decide:(id,approve)=>ipcRenderer.invoke("discord:decide",id,approve),
    portal:()=>ipcRenderer.invoke("discord:portal"),
    invite:id=>ipcRenderer.invoke("discord:invite",id),
    open:(guild,channel,message,client)=>ipcRenderer.invoke("discord:open",guild,channel,message,client),
  },
  spotify: {
    status:()=>ipcRenderer.invoke("spotify:status"),
    connect:id=>ipcRenderer.invoke("spotify:connect",id),
    disconnect:()=>ipcRenderer.invoke("spotify:disconnect")
  },
  mail: {
    status: batch=>ipcRenderer.invoke("mail:status",batch || ""), cancel: id=>ipcRenderer.invoke("mail:cancel",id),
    smtp: (email,password)=>ipcRenderer.invoke("mail:smtp",email,password), oauth: ()=>ipcRenderer.invoke("mail:oauth"),
    disconnect: sender=>ipcRenderer.invoke("mail:disconnect",sender), select:sender=>ipcRenderer.invoke("mail:select",sender), passwordPage: ()=>ipcRenderer.invoke("mail:password-page"),
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
  speech: {settings:()=>ipcRenderer.invoke("speech:settings"),connect:values=>ipcRenderer.invoke("speech:connect",values),disconnect:()=>ipcRenderer.invoke("speech:disconnect")},
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
    send: (chat, text, shot, attachments, retry) => ipcRenderer.send("cc:send", { chat, text, shot, attachments, retry }),
    reset: id=>ipcRenderer.send("cc:reset",id),
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
