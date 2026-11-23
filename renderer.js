/* Neutron renderer: chat UI on top of fcc-claude's stream-json protocol. */
const N = window.neutron;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const MODES = {
  default: "Alap (rákérdez)",
  acceptEdits: "Szerkesztések elfogadása",
  plan: "Tervezés",
  bypassPermissions: "Minden engedélyezve",
};
const CLAUDE_MODELS = [["", "Alapértelmezett", "a fiók saját alapmodellje"], ["claude-opus-5-5", "Opus 5.5", "Rögzített verzió"], ["claude-sonnet-5-5", "Sonnet 5.5", "Rögzített verzió"], ["claude-haiku-5-5", "Haiku 5.5", "Rögzített verzió"], ["claude-fable-5-2", "Fable 5.2", "Rögzített verzió"], ["fable", "Fable", "legújabb Fable"], ["opus", "Opus", "legújabb Opus"],
  ["sonnet", "Sonnet", "legújabb Sonnet"], ["haiku", "Haiku", "legújabb Haiku, a leggyorsabb"]];
const EFFORTS = { "": "Auto", none: "None", minimal: "Minimal", ultra: "Ultra", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
const accStatus = new Map(); // account id -> { loggedIn, email, plan }
const FALLBACK_SLASH = ["compact", "clear", "context", "cost", "init", "review", "model", "config", "mcp", "agents", "memory", "doctor", "help"];

let cfg = {}, home = "", models = [], chats = [], chat = null, view = "chat";
const open = new Map();     // chatId -> chat object (loaded)
const pendingFiles = new Map();
const live = new Map();     // chatId -> { idx: Map(index->block), streamed: Set(msgId), stderr: "" }
const blockEls = new WeakMap();
let slashMeta = { slash: [], term: [] };
let term = null, fit = null, termChatId = null;

// ---------- utils ----------
function toast(text, bad = false) {
  const t = document.createElement("div");
  t.className = "toast" + (bad ? " bad" : "");
  t.textContent = text;
  $("#toasts").append(t);
  setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 400); }, bad ? 6000 : 3000);
}
const shortDir = (d) => (d && home && d.startsWith(home) ? "~" + d.slice(home.length) : d || "~");
const shortModel = (m) => (m ? m.split("/").pop() : "Modell…");
const save = (c) => N.chats.save(JSON.parse(JSON.stringify(c, (k, v) => (k === "json" ? undefined : v))));

marked.setOptions({ gfm: true, breaks: true });
function md(text) {
  const div = document.createElement("div");
  div.className = "md";
  setMd(div, text);
  return div;
}
function setMd(div, text) {
  div.innerHTML = DOMPurify.sanitize(marked.parse(text || ""));
  div.querySelectorAll("pre code").forEach((c) => {
    hljs.highlightElement(c);
    const b = document.createElement("button");
    b.className = "copy"; b.textContent = "Másolás";
    b.onclick = () => { navigator.clipboard.writeText(c.innerText); b.textContent = "Másolva ✓"; setTimeout(() => (b.textContent = "Másolás"), 1500); };
    c.parentElement.append(b);
  });
}

// ---------- starfield ----------
(function stars() {
  const cv = $("#stars"), ctx = cv.getContext("2d");
  const accent = { primary:"#a78bfa", secondary:"#67e8f9" };
  let W, H, pts = [], mouse = { x: -999, y: -999 };
  const resize = () => {
    W = cv.width = innerWidth * devicePixelRatio; H = cv.height = innerHeight * devicePixelRatio;
    cv.style.width = innerWidth + "px"; cv.style.height = innerHeight + "px";
    pts = Array.from({ length: Math.round((innerWidth * innerHeight) / 9000) }, () => ({
      x: Math.random() * W, y: Math.random() * H, r: Math.random() * 1.4 + .3,
      vx: (Math.random() - .5) * .15, vy: (Math.random() - .5) * .15, p: Math.random() * 6.28,
    }));
  };
  addEventListener("resize", resize);
  addEventListener("mousemove", (e) => { mouse = { x: e.clientX * devicePixelRatio, y: e.clientY * devicePixelRatio }; });
  resize();
  let frameId;
  addEventListener("neutron-appearance", () => {
    const style = getComputedStyle(document.documentElement);
    accent.primary = style.getPropertyValue("--a1");
    accent.secondary = style.getPropertyValue("--a2");
    cancelAnimationFrame(frameId);
    ctx.clearRect(0, 0, W, H);
    if (document.documentElement.dataset.background==="ambient" && document.documentElement.dataset.motion!=="reduced") frame();
  });
  function frame() {
    if (!document.hidden) {
      ctx.clearRect(0, 0, W, H);
      for (const s of pts) {
        s.x = (s.x + s.vx + W) % W; s.y = (s.y + s.vy + H) % H; s.p += .02;
        const d = Math.hypot(s.x - mouse.x, s.y - mouse.y), near = d < 160 * devicePixelRatio;
        ctx.globalAlpha = .35 + Math.sin(s.p) * .3 + (near ? .4 : 0);
        ctx.fillStyle = near ? accent.secondary : accent.primary;
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r * devicePixelRatio, 0, 6.28); ctx.fill();
        if (near) {
          ctx.globalAlpha = (1 - d / (160 * devicePixelRatio)) * .35; ctx.strokeStyle = accent.primary;
          ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(mouse.x, mouse.y); ctx.stroke();
        }
      }
    }
    frameId = requestAnimationFrame(frame);
  }
})();

// ---------- sidebar ----------
function renderList() {
  const q = $("#search").value.toLowerCase();
  const list = $("#chatList");
  list.innerHTML = "";
  chats.filter((c) => (c.projectId || "") === (cfg.activeProject || "") && c.title.toLowerCase().includes(q)).forEach((c, i) => {
    const el = document.createElement("div");
    el.className = "chat-item" + (chat && c.id === chat.id ? " active" : "") + (live.has(c.id) ? " busy" : "");
    el.style.setProperty("--i", i);
    el.innerHTML = `<span>${esc(c.title)}</span><button class="del" title="Törlés" aria-label="Törlés">✕</button>`;
    el.onclick = () => selectChat(c.id);
    el.querySelector(".del").onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Törlöd ezt a csevegést?\n„${c.title}”`)) return;
      clearTimeout(live.get(c.id)?.retryTimer);
      pendingFiles.delete(c.id);
      await N.chats.delete(c.id);
      open.delete(c.id); live.delete(c.id);
      if (chat && chat.id === c.id) chat = null;
      await refreshList();
      if (!chat) newChat();
    };
    list.append(el);
  });
}
async function refreshList() { chats = await N.chats.list(); renderList(); }

// ---------- chats ----------
function newChat(character, provider = cfg.provider || "fcc") {
  const c = {
    id: "chat-" + crypto.randomUUID().slice(0, 12), title: "Új csevegés", items: [],
    projectId: activeProject()?.id || "", cwd: activeProject()?.cwd || cfg.lastCwd || home, provider, effort: "", mode: cfg.mode || "default",
    model: provider === "codex" ? cfg.codexModel || "" : provider !== "fcc" ? cfg.claudeModel || "" : cfg.model || defaultModel(),
    sessionId: crypto.randomUUID(),
  };
  if (character) {
    c.character = { id: character.id, name: character.name, prompt: character.prompt, avatar: character.avatar || "" };
    c.provider = character.provider;
    c.model = character.model;
    c.title = character.name;
  }
  open.set(c.id, c);
  chat = c;
  renderChat();
  renderList();
  $("#input").focus();
}

async function selectChat(id) {
  const c = await getChat(id);
  if (!c) return toast("Nem sikerült betölteni a csevegést.", true);
  if ((cfg.activeProject || "") !== (c.projectId || "")) return;
  chat = c;
  if (view !== "chat") setView("chat");
  renderChat();
  renderList();
}

async function getChat(id) {
  let c = open.get(id);
  if (!c) {
    c = await N.chats.load(id);
    if (!c) return null;
    if (!c.items) { // chats from the older Neutron version
      c.items = (c.messages || []).map((m) => m.role === "user"
        ? { role: "user", text: m.content || m.text || "" }
        : { role: "assistant", blocks: [{ type: "text", text: m.content || m.text || "" }] });
      delete c.messages;
    }
    c.sessionId ||= crypto.randomUUID();
    c.cwd ||= home; c.mode ||= "default"; c.provider ||= "fcc"; c.effort ||= ""; c.model ??= c.provider === "fcc" ? cfg.model || defaultModel() : "";
    open.set(id, c);
  }
  return c;
}

function defaultModel() {
  return models.find((m) => /nemotron-3\.5-super/.test(m)) || models[0] || "";
}

// ---------- rendering ----------

function renderChat() {
  renderQuickPermission();
  showEffort(false);
  renderComposerFiles();
  updateArtifacts();
  const th = $("#thread");
  th.innerHTML = "";
  $("#title").textContent = chat.title;
  updateChips();
  if (!chat.items.length) { setBusyUi(); return renderHero(); }
  chat.items.forEach((it) => th.append(itemEl(it)));
  setBusyUi();
  scrollDown(true);
}

function renderHero() {
  const th = $("#thread");
  const name = cfg.appearance?.name;
  const shortcuts = [
    ["Tervezés", "Építs egy interaktív heti tervezőt HTML-ben."],
    ["Minecraft", "Hozz létre egy Fabric-példányt a Prismben, és telepítsd bele a Sodiumot."],
    ["Keresés", "Keress rá a Prism Launcher legújabb kiadására, és adj forrásokat."],
    ["Zene", "Nézd meg, melyik szám szól most a Spotifyon."],
  ];
  th.innerHTML = `<div class="hero">
    <div class="hero-panel">
      <div class="hero-intro"><h2>${chat.character ? esc(chat.character.name) : name ? "Szia, " + esc(name) + "!" : "Miben segíthetek?"}</h2>
        <p id="typer"></p><button class="switch-character">Karakter választása <span aria-hidden="true">↗</span></button></div>
      <div class="orbit-mark hero-orbit">${chat.character ? portrait(chat.character, "large") : '<img src="icon.png" alt="">'}</div>
    </div>
    <div class="cards">
      ${shortcuts.map(([label,prompt], i) => `<button class="card" style="--i:${i}" data-starter="${esc(prompt)}"><b>${label}</b><span>${prompt}</span><i aria-hidden="true">↗</i></button>`).join("")}
    </div></div>`;
  th.querySelectorAll(".card").forEach((b) => (b.onclick = () => {
    $("#input").value = b.dataset.starter;
    autoGrow(); $("#input").focus();
  }));
  $("#typer").textContent = providerLabel(chat.provider, chat.model);
  th.querySelector(".switch-character").onclick = showChooser;
}

function itemEl(it) {
  const wrap = document.createElement("div");
  if (it.role === "user") {
    wrap.className = "msg user";
    wrap.innerHTML = `<div class="bubble${it.wake ? " wake" : ""}">${esc(it.text)}</div>`;
    const owner=chat?.id;
    for(const row of it.files || []){
      const file=document.createElement("button");
      file.className="sent-file";file.type="button";file.textContent=row.name;
      file.title="A helyi fájl megjelenítése";
      file.onclick=()=>N.uploads.reveal(owner,row).catch(error=>toast(error.message,true));
      wrap.firstElementChild.append(file);
    }
    return wrap;
  }
  wrap.className = "msg assistant";
  wrap.innerHTML = `${chat?.character ? portrait(chat.character, "avatar") : '<div class="avatar"><img width="26" src="icon.png" alt=""></div>'}<div class="body"></div>`;
  blockEls.set(it, wrap);
  const body = wrap.querySelector(".body");
  if (it.auto) body.insertAdjacentHTML("afterbegin", `<div class="meta auto">↻ Magától folytatta</div>`);
  (it.blocks || []).forEach((b) => body.append(blockEl(b)));
  if (it.meta) body.insertAdjacentHTML("beforeend", `<div class="meta">${esc(it.meta)}</div>`);
  return wrap;
}

function blockEl(b) {
  let el;
  if (b.type === "attachment") return attachmentBlock(b);
  if (b.type === "cards") return resultCards(b);
  if (b.type === "text") el = md(b.text);
  else if (b.type === "thinking") {
    el = document.createElement("details");
    el.className = "think";
    el.innerHTML = `<summary><span>Gondolkodás</span></summary><div class="tx"></div>`;
    el.querySelector(".tx").textContent = b.text;
  } else if (b.type === "tool") {
    el = document.createElement("details");
    el.className = "tool";
    el.innerHTML = `<summary><span class="st"></span><b></b><span class="arg"></span></summary><pre class="in"></pre><pre class="out"></pre>`;
  } else if (b.type === "perm") {
    el = document.createElement("div");
    el.className = "perm";
    el.innerHTML = `<h4>🔐 Engedélyt kér: <code></code></h4><pre></pre><div class="row"></div>`;
  } else if (b.type === "discord-review") {
    el=document.createElement("button");
    el.type="button";el.className="btn discord-review";
    el.textContent="Discord-jóváhagyás · "+b.target;
    el.onclick=()=>openDiscordReview(b.id);
  } else if (b.type === "status") {
    el = document.createElement("div"); el.className="retry-status"; el.textContent=b.text; el.setAttribute("role","status");
  } else if (b.type === "error") {
    el = document.createElement("div");
    el.className = "error-box";
  } else if (b.type === "wake") {
    el = document.createElement("div");
    el.className = "wakecard";
    el.innerHTML = `<div class="ring"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15.9" class="bg"/><circle cx="18" cy="18" r="15.9" class="fg"/></svg><span>⏰</span></div>
      <div class="info"><b></b><small></small></div><div class="cd"></div><div class="row"></div>`;
  }
  blockEls.set(b, el);
  updateBlock(b);
  return el;
}

function toolArg(input) {
  if (!input) return "";
  return input.command || input.file_path || input.path || input.pattern || input.url || input.query || input.description || input.prompt || "";
}

function updateBlock(b) {
  const el = blockEls.get(b);
  if (!el) return;
  if (b.type === "text") setMd(el, (b.hu ? repairHungarian(b.text) : b.text).replace(WAKE_RE, "").trimEnd());
  else if (b.type === "thinking") {
    el.querySelector(".tx").textContent = b.text;
    el.classList.toggle("live", !b.done);
    el.querySelector("summary span").textContent = b.done ? "Gondolkodás" : "Gondolkodik…";
  } else if (b.type === "tool") {
    el.querySelector("b").textContent = b.name;
    el.querySelector(".arg").textContent = String(toolArg(b.input)).split("\n")[0];
    el.querySelector(".in").textContent = b.input ? JSON.stringify(b.input, null, 2) : b.json || "";
    const out = el.querySelector(".out");
    out.textContent = b.result ?? "";
    out.hidden = b.result == null;
    el.classList.toggle("done", b.result != null && !b.isError);
    el.classList.toggle("err", !!b.isError);
  } else if (b.type === "perm") {
    el.querySelector("code").textContent = b.tool;
    el.querySelector("pre").textContent = toolArg(b.input) || JSON.stringify(b.input, null, 2);
    const row = el.querySelector(".row");
    el.classList.toggle("answered", !!b.answer);
    if (b.answer || !pendingPermissions.has(b)) {
      row.textContent = b.answer === "deny" ? "✕ Elutasítva" : b.answer ? "✓ Engedélyezve" : "A kérés lejárt.";
      return;
    }
    row.innerHTML = "";
    const btn = (label, cls, ans) => {
      const x = document.createElement("button");
      x.className = "btn " + cls; x.textContent = label;
      x.onclick = () => answerPerm(b, ans);
      row.append(x);
    };
    btn("Engedélyezés", "go", "allow");
    if (b.suggestions?.length) btn("Mindig engedélyez", "", "always");
    btn("Elutasítás", "no", "deny");
  } else if (b.type === "error") el.textContent = b.text;
  else if (b.type === "wake") {
    const left = Math.max(0, Math.round((b.at - Date.now()) / 1000));
    el.className = "wakecard " + b.state;
    el.querySelector("b").textContent = { pending: "Ébresztés ütemezve", fired: "Felébresztve, folytatja", cancelled: "Ébresztés törölve" }[b.state];
    el.querySelector("small").textContent = b.prompt || "Folytatja a feladatot ott, ahol abbahagyta.";
    el.querySelector(".cd").textContent = b.state === "pending" ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "";
    el.querySelector(".fg").style.strokeDashoffset = b.state === "pending" ? 100 - (100 * left) / b.delay : 100;
    const row = el.querySelector(".row");
    if (b.state !== "pending") { row.innerHTML = ""; return; }
    if (!row.children.length) {
      const c = () => open.get(b.chatId);
      row.innerHTML = `<button class="btn go">Most</button><button class="btn no">Mégse</button>`;
      row.children[0].onclick = () => { b.at = Date.now(); b.source = "marker"; arm(c(), b); };
      row.children[1].onclick = () => cancelWake(c(), b);
    }
  }
}

// ---------- wakeups: headless Claude Code never fires ScheduleWakeup itself, so Neutron does ----------
const WAKE_RE = /\[\[\s*WAKEUP\s+(\d+(?:[.,]\d+)?)\s*(s|sec|mp|m|min|perc|h|óra)?\s*:?\s*([^\]]*)\]\]/i;
const wakeTimers = new Map(); // chatId -> timeout
const wakes = new Set();      // pending wake blocks, for the countdown

function scanWake(c, it) {
  let delay, prompt;
  const tool = [...it.blocks].reverse().find((b) => b.type === "tool" && b.name === "ScheduleWakeup" && b.input);
  if (tool) {
    // Claude Code clamps/rounds the delay; its tool result says the real one ("in 136s")
    delay = +(/in (\d+)s/.exec(tool.result || "")?.[1] || tool.input.delaySeconds);
    prompt = /^<<autonomous/.test(tool.input.prompt || "") ? "" : tool.input.prompt;
  } else {
    for (const b of [...it.blocks].reverse()) {
      const m = b.type === "text" && WAKE_RE.exec(b.text);
      if (!m) continue;
      const unit = /^(m|min|perc)$/i.test(m[2] || "") ? 60 : /^(h|óra)$/i.test(m[2] || "") ? 3600 : 1;
      delay = parseFloat(m[1].replace(",", ".")) * unit; prompt = m[3].trim();
      break;
    }
  }
  if (!(delay > 0)) return;
  delay = Math.min(Math.max(delay, 5), 6 * 3600);
  for (const old of c.items.flatMap((i) => i.blocks || [])) if (old.type === "wake" && old.state === "pending") cancelWake(c, old, true);
  const b = { type: "wake", chatId: c.id, at: Date.now() + delay * 1000, delay, prompt, state: "pending", source: tool ? "tool" : "marker" };
  appendBlock(c, it, b);
  arm(c, b);
}

function arm(c, b) {
  clearTimeout(wakeTimers.get(c.id));
  wakes.add(b);
  // tool wakeups are fired by Claude Code itself; Neutron only steps in if that did not happen (process restarted, app closed)
  const grace = b.source === "tool" ? 15000 : 0;
  wakeTimers.set(c.id, setTimeout(() => fireWake(c, b), Math.max(0, b.at - Date.now() + grace)));
}

function fireWake(c, b) {
  if (b.state !== "pending") return;
  if (!hasChatProvider(c)) return cancelWake(c, b);
  // busy or the terminal owns the session: try again shortly
  if (live.has(c.id) || termChatId === c.id) return wakeTimers.set(c.id, setTimeout(() => fireWake(c, b), 5000));
  b.state = "fired"; wakes.delete(b); updateBlock(b);
  if (chat?.id !== c.id) toast(`⏰ „${c.title}” felébredt és folytatja.`);
  submit(c, `⏰ Ébresztés: ${b.prompt || "folytasd a feladatot ott, ahol abbahagytad."}`, true);
}

function cancelWake(c, b, quiet) {
  b.state = "cancelled"; wakes.delete(b); updateBlock(b);
  if (wakeTimers.has(c.id)) { clearTimeout(wakeTimers.get(c.id)); wakeTimers.delete(c.id); }
  if (!quiet) save(c);
}
setInterval(() => wakes.forEach(updateBlock), 1000);

const pendingPermissions = new Set();

function renderQuickPermission() {
  const b = [...pendingPermissions].find(request => request.chatId === chat?.id);
  $("#quickPermission").hidden = !b;
  if (!b) return;
  $("#quickPermissionTool").textContent = b.tool;
  $("#quickPermissionInput").textContent = b.input?.command || JSON.stringify(b.input ?? {}, null, 2);
  $("#quickPermissionAllow").onclick = () => answerPerm(b, "allow");
  $("#quickPermissionDeny").onclick = () => answerPerm(b, "deny");
}

function answerPerm(b, ans) {
  const c = open.get(b.chatId);
  if (!c || !live.has(c.id) || !pendingPermissions.delete(b)) return;
  const resp = ans === "deny"
    ? { behavior: "deny", message: "A felhasználó elutasította ezt a műveletet." }
    : { behavior: "allow", updatedInput: b.input, ...(ans === "always" ? { updatedPermissions: b.suggestions } : {}) };
  N.cc.respond(c, b.requestId, resp);
  b.answer = ans;
  updateBlock(b);
  renderQuickPermission();
}

let rafPending = new Set();
function schedule(c, b) {
  if (!chat || c.id !== chat.id) return;
  rafPending.add(b);
  if (rafPending.size > 1) return;
  requestAnimationFrame(() => {
    const stick = nearBottom();
    rafPending.forEach(updateBlock);
    rafPending.clear();
    if (stick) scrollDown();
  });
}

function appendBlock(c, it, b) {
  if (b.type==="text" && /nemotron[-_. ]3[.-]5/i.test(c.model)) b.hu=true;
  it.blocks.push(b);
  if (!chat || c.id !== chat.id) return;
  const wrap = blockEls.get(it);
  if (!wrap) return;
  const stick = nearBottom();
  wrap.querySelector(".body").querySelector(".typing")?.remove();
  wrap.querySelector(".body").append(blockEl(b));
  if (stick) scrollDown();
}

const nearBottom = () => { const s = $("#scroll"); return s.scrollHeight - s.scrollTop - s.clientHeight < 140; };
function scrollDown(instant) { const s = $("#scroll"); s.scrollTo({ top: s.scrollHeight, behavior: instant || document.documentElement.dataset.motion==="reduced" ? "instant" : "smooth" }); }

function setBusyUi() {
  const busy = chat && live.has(chat.id);
  $("#composer").classList.toggle("busy", busy);
  $("#send").title = busy ? "Leállítás (Esc)" : "Küldés (Enter)";
  $("#modelChip").disabled = $("#effortChip").disabled = !!busy;
  if (busy) showEffort(false);
  $("#effortSlider").disabled = $("#resetEffort").disabled = !!busy || view === "term";
  $("#dirChip").disabled = !!(chat && (chat.items.length || chat.projectId));
  renderList();
}

function updateChips() {
  if (!chat) return;
  const isCodex = chat.provider === "codex";
  $("#input").placeholder = isCodex ? "Kérdezz a Codextől, vagy adj neki feladatot…" : "Írj üzenetet, vagy / a parancsokhoz…";
  $("#slashHint").hidden = isCodex;
  const claude = !isCodex && chat.provider !== "fcc";
  $("#modelName").textContent = isCodex ? providerLabel("codex", chat.model) : claude
    ? `${accName(chat.provider)} · ${CLAUDE_MODELS.find((m) => m[0] === chat.model)?.[1] || chat.model}`
    : shortModel(chat.model);
  $("#modelChip").classList.toggle("claude", claude);
  $("#modelChip").title = isCodex ? "OpenAI Codex" : claude ? `Claude-fiók: ${accName(chat.provider)}` : `Free Claude Code: ${chat.model}`;
  renderEffort();
  $("#dirName").textContent = activeProject()?.name || shortDir(chat.cwd);
  $("#dirChip").title = chat.cwd;
  $("#modeName").textContent = isCodex ? (chat.codexSandbox === "workspace-write" ? "Szerkesztés" : "Olvasás") : MODES[chat.mode] || chat.mode;
}

// ---------- sending ----------
function currentTurn(c) {
  const last = c.items[c.items.length - 1];
  if (last && last.role === "assistant" && live.has(c.id)) return last;
  return newTurn(c);
}

function newTurn(c, auto = false) {
  const it = { role: "assistant", blocks: [], started:Date.now(), auto };
  c.items.push(it);
  if (chat && c.id === chat.id) {
    const el = itemEl(it);
    el.querySelector(".body").insertAdjacentHTML("beforeend", `<div class="typing"><i></i><i></i><i></i></div>`);
    $("#thread").append(el);
    scrollDown();
  }
  return it;
}

function hasChatProvider(c) {
  if (c.provider === "fcc" || c.provider === "codex" || accounts().some(a => a.id === c.provider)) return true;
  toast("A beszélgetéshez tartozó fiókot eltávolították. Válassz másikat a modellválasztóban.", true);
  return false;
}

function renderComposerFiles(){
  const tray=$("#composerFiles"), owner=chat?.id, rows=pendingFiles.get(owner) || [];
  tray.replaceChildren();tray.hidden=!rows.length;
  rows.forEach(row=>{
    const chip=document.createElement("div");chip.className="file-chip";
    const name=document.createElement("span");name.textContent=row.name;name.title=row.name;
    const remove=document.createElement("button");remove.type="button";remove.textContent="×";
    remove.setAttribute("aria-label",row.name+" eltávolítása");
    remove.onclick=()=>{
      pendingFiles.set(owner,(pendingFiles.get(owner)||[]).filter(file=>file.id!==row.id));
      renderComposerFiles();
      N.uploads.remove(owner,row).catch(error=>toast(error.message,true));
    };
    chip.append(name,remove);tray.append(chip);
  });
}

async function addComposerFiles(load) {
  const owner=chat?.id;
  if(!owner)return;
  let added;
  try {
    added=await load(owner);
    if(!open.has(owner)){
      await Promise.allSettled(added.map(row=>N.uploads.remove(owner,row)));
      return;
    }
    const existing=pendingFiles.get(owner)||[];
    if(existing.length+added.length>8){
      await Promise.allSettled(added.map(row=>N.uploads.remove(owner,row)));
      return toast("Legfeljebb 8 fájlt csatolhatsz üzenetenként.",true);
    }
    pendingFiles.set(owner,[...existing,...added]);
    if(chat?.id===owner)renderComposerFiles();
  } catch(error){toast(error.message,true);}
}
$("#attachFiles").onclick=()=>addComposerFiles(id=>N.uploads.pick(id));
const chatDrop=$("#chatView");
chatDrop.addEventListener("dragover",event=>{
  if(!event.dataTransfer.types.includes("Files"))return;
  event.preventDefault();event.dataTransfer.dropEffect="copy";
  $("#composer").classList.add("file-drop");
});
chatDrop.addEventListener("dragleave",event=>{
  if(!chatDrop.contains(event.relatedTarget))$("#composer").classList.remove("file-drop");
});
chatDrop.addEventListener("drop",event=>{
  $("#composer").classList.remove("file-drop");
  const files=Array.from(event.dataTransfer.files);
  if(!files.length)return;
  event.preventDefault();
  addComposerFiles(id=>N.uploads.drop(id,files));
});
window.addEventListener("dragover",event=>{if(event.dataTransfer.types.includes("Files"))event.preventDefault();});
window.addEventListener("drop",event=>{if(event.dataTransfer.types.includes("Files"))event.preventDefault();});

function send() {
  const box = $("#input");
  const text = box.value.trim();
  if (!chat || (!text && !pendingFiles.get(chat.id)?.length)) return;
  if (live.has(chat.id)) return toast("Várd meg a választ, vagy állítsd le (Esc).");
  closePop();
  const files=pendingFiles.get(chat.id)||[];
  if(wantsVideoEditor(text)){
    box.value="";autoGrow();
    openVideoFromChat(chat.id,text,files);return;
  }
  const cmd = text.startsWith("/") ? text.slice(1).split(/\s/)[0] : null;
  const meta = slashMeta.term.length ? slashMeta : cfg.slashCache || slashMeta;
  if (chat.provider !== "codex" && !pendingFiles.get(chat.id)?.length && cmd && meta.term?.includes(cmd) && !meta.slash?.includes(cmd)) {
    box.value = ""; autoGrow();
    toast(`A /${cmd} interaktív parancs, a Terminál fülön nyílik meg.`);
    return setView("term", () => startTerm([text]));
  }
  box.value = ""; autoGrow();
  submit(chat, text || "Nézd meg a csatolt fájlokat.",false,null,pendingFiles.get(chat.id)||[]);
}

async function submit(c, text, wake = false, shot = null, files=[]) {
  const optimize = !wake && !files.length && await N.maintenance.matches(text);
  if (live.has(c.id) || (!optimize && !hasChatProvider(c))) return;
  const active = chat && c.id === chat.id;
  if (!c.items.length) {
    if (active) $("#thread").innerHTML = "";
    const title = (c.character ? c.character.name + " · " : "") + text.replace(/\s+/g, " ");
    c.title = title.slice(0, 64) + (title.length > 64 ? "…" : "");
    if (active) $("#title").textContent = c.title;
    if (!c.projectId) { cfg.lastCwd = c.cwd; N.config.set(cfg); }
  }
  if (!wake) window.dispatchEvent(new Event("neutron-send"));
  if(files.length){
    pendingFiles.delete(c.id);
    if(active)renderComposerFiles();
  }
  const u = { role: "user", text, wake, ...(files.length?{files}: {}) };
  c.items.push(u);
  if (active) $("#thread").append(itemEl(u));
  live.set(c.id, { idx: new Map(), streamed: new Set(), stderr: "" });
  const it = currentTurn(c);
  if (optimize) live.get(c.id).maintenance = true;
  if (active) setBusyUi(); else renderList();
  if (optimize) {
    appendBlock(c,it,{type:"text",text:"A Windows a rendszermeghajtóhoz illő optimalizálást futtatja. Ha jóváhagyást kér, engedélyezd a Windows ablakában."});
    try {
      const {drive,exit_code,before} = await N.maintenance.optimize();
      const free = (before.system_drive_free_bytes / 2 ** 30).toFixed(1);
      const measurements = `Induláskor ${before.cpu_percent_sample}% CPU-terhelés, ${before.memory_percent}% memóriahasználat és ${free} GiB szabad tárhely.`;
      if (exit_code !== 0) throw Error(`A Windows nem fejezte be sikeresen a ${drive} optimalizálását. Kilépési kód: ${exit_code}. ${measurements}`);
      appendBlock(c,it,{type:"text",text:`A Windows sikeresen befejezte a ${drive} rendszermeghajtó optimalizálását. ${measurements}`});
    } catch (error) {
      appendBlock(c,it,{type:"error",text:error.message});
    }
    it.meta = "Windows meghajtóoptimalizálás";
    finishTurn(c,it);
    return;
  }
  const actual = { ...c };
  const effortKey = c.provider === "codex" ? "codexEffort" : "effort";
  if (!effortLevels(c).includes(actual[effortKey])) actual[effortKey] = "";
  const state=live.get(c.id);
  state.request={actual,text,shot,files};
  state.rateFailures=0;
  N.cc.send(actual, text, shot, files);
  save(c).then(refreshList);
}

function stop() {
  if (!chat || !live.has(chat.id)) return;
  const c = chat;
  const state=live.get(c.id);
  if(state.retryTimer) {
    clearTimeout(state.retryTimer);
    const it=currentTurn(c);
    it.meta="Leállítva";
    finishTurn(c,it);
    return;
  }
  if (state.maintenance) return toast("A futó Windows-művelet állapota a Windows ablakában látható.");
  if (c.provider === "codex") return N.cc.stop(c.id);
  N.cc.control(c, { subtype: "interrupt" });
  setTimeout(() => { if (live.get(c.id)===state && !state.retryTimer) N.cc.stop(c.id); }, 4000);
}

// ---------- protocol ----------
function retryRateLimit(c, st, it, error) {
  if(!st.request || !(st.rateError || isRateLimit(error)))return false;
  st.rateFailures++;
  const decision=rateRetryDecision(st.rateFailures,st.effects || it.blocks.some(b=>b.type==="tool" || b.type==="perm"));
  if(decision!=="wait"){
    appendBlock(c,it,{type:"error",text:decision==="limit"?
      "A szolgáltató egymás után tízszer túl sok kérést jelzett. Az újrapróbálás leállt.":
      "A szolgáltató túl sok kérést jelzett. A már megkezdett műveletek miatt a Neutron nem ismétli meg automatikusan a teljes kérést."});
    it.meta="API-korlát";
    finishTurn(c,it);
    return true;
  }
  N.cc.reset(c.id);
  it.blocks=[];
  appendBlock(c,it,{type:"status",text:`A szolgáltató túl sok kérést jelzett (${st.rateFailures}/10). Újrapróbálás 1 perc múlva…`});
  if(chat?.id===c.id)renderChat();
  st.retryTimer=setTimeout(()=>{
    if(live.get(c.id)!==st)return;
    st.retryTimer=null;
    st.rateError=false;
    st.stderr="";
    st.idx.clear();
    st.streamed.clear();
    it.blocks=[];
    if(chat?.id===c.id)renderChat();
    const {actual,text,shot,files}=st.request;
    N.cc.send({...actual,sessionId:c.sessionId,codexThread:c.codexThread},text,shot,files,true);
  }, RATE_RETRY_DELAY);
  return true;
}

N.cc.onEvent(({ chatId, ev }) => {
  const c = open.get(chatId);
  if (!c) return;
  let st = live.get(chatId);
  if(st?.retryTimer)return;
  if(st && ev.error && isRateLimit(ev.error))st.rateError=true;
  if (ev.type === "codex") {
    if (!st) return;
    if (ev.kind === "effects") st.effects=true;
    if (ev.kind === "thread") { c.codexThread = ev.id; save(c); }
    if (ev.kind==="files") { const it=currentTurn(c);it.changedPaths=[...(it.changedPaths || []),...ev.paths]; }
    if (ev.kind === "output") receiveOutput(c,currentTurn(c),ev.tool,ev.input,ev.body);
    if (ev.kind === "message") appendBlock(c, currentTurn(c), { type: "text", text: ev.text });
    if (ev.kind === "command") appendBlock(c, currentTurn(c), { type: "tool", name: "Codex", input: { command: ev.name }, result: ev.result, isError: ev.failed });
    return;
  }
  // Claude Code starts turns on its own (finished background task, ScheduleWakeup): show them as a new live turn.
  if (!st && ["stream_event", "assistant", "user", "control_request"].includes(ev.type) && !ev.parent_tool_use_id) {
    st = { idx: new Map(), streamed: new Set(), stderr: "" };
    live.set(chatId, st);
    newTurn(c, true);
    for (const b of wakes) if (b.chatId === chatId && b.source === "tool" && Date.now() >= b.at - 15000) { b.state = "fired"; wakes.delete(b); updateBlock(b); }
    if (chat?.id === chatId) setBusyUi(); else { renderList(); toast(`⏰ „${c.title}” folytatja a munkát.`); }
  }

  if (ev.type === "system" && ev.subtype === "init") {
    c.sessionId = ev.session_id;
    slashMeta = { slash: ev.slash_commands || [], term: ev.terminal_slash_commands || [] };
    cfg.slashCache = slashMeta; N.config.set(cfg);
    return;
  }
  if (!st) return;
  // shortcut: subagent (Task) inner streams are hidden; only the top-level conversation is shown
  if (ev.parent_tool_use_id) return;

  if (ev.type === "stream_event") {
    const e = ev.event, it = currentTurn(c);
    if (e.type === "message_start") st.streamed.add(e.message.id);
    else if (e.type === "content_block_start") {
      const cb = e.content_block;
      const b = cb.type === "tool_use" ? { type: "tool", id: cb.id, name: cb.name, json: "" }
        : cb.type === "thinking" || cb.type === "redacted_thinking" ? { type: "thinking", text: "" }
        : cb.type === "text" ? { type: "text", text: cb.text || "" } : null;
      if (!b) return;
      st.idx.set(e.index, b);
      appendBlock(c, it, b);
      if (chat && c.id === chat.id) blockEls.get(it)?.classList.add("streaming");
    } else if (e.type === "content_block_delta") {
      const b = st.idx.get(e.index), d = e.delta;
      if (!b) return;
      if (d.type === "text_delta") b.text += d.text;
      else if (d.type === "thinking_delta") b.text += d.thinking;
      else if (d.type === "input_json_delta") b.json += d.partial_json;
      schedule(c, b);
    } else if (e.type === "content_block_stop") {
      const b = st.idx.get(e.index);
      if (!b) return;
      if (b.type === "tool") { try { b.input = JSON.parse(b.json || "{}"); } catch { b.input = { raw: b.json }; } delete b.json; }
      if (b.type === "thinking") b.done = true;
      schedule(c, b);
    } else if (e.type === "message_stop") st.idx.clear();
    return;
  }

  if (ev.type === "assistant") {
    if (st.streamed.has(ev.message.id)) return;
    const it = currentTurn(c);
    for (const cb of ev.message.content || []) {
      if (cb.type === "text" && cb.text) appendBlock(c, it, { type: "text", text: cb.text });
      else if (cb.type === "thinking") appendBlock(c, it, { type: "thinking", text: cb.thinking, done: true });
      else if (cb.type === "tool_use") appendBlock(c, it, { type: "tool", id: cb.id, name: cb.name, input: cb.input });
    }
    return;
  }

  if (ev.type === "user") {
    const content = ev.message?.content;
    if (!Array.isArray(content)) return;
    const it = currentTurn(c);
    for (const r of content) {
      if (r.type !== "tool_result") continue;
      const b = it.blocks.find((x) => x.type === "tool" && x.id === r.tool_use_id);
      if (!b) continue;
      b.result = Array.isArray(r.content) ? r.content.map((x) => x.text ?? `[${x.type}]`).join("\n") : String(r.content ?? "");
      if (!r.is_error) receiveOutput(c,it,b.name,b.input,b.result);
      if (b.result.length > 20000) b.result = b.result.slice(0, 20000) + "\n… (levágva)";
      b.isError = !!r.is_error;
      schedule(c, b);
    }
    return;
  }

  if (ev.type === "control_request" && ev.request?.subtype === "can_use_tool") {
    const it = currentTurn(c);
    if ([...pendingPermissions].some(b => b.chatId === chatId && b.requestId === ev.request_id)) return;
    const request = {
      type: "perm", chatId, requestId: ev.request_id, tool: ev.request.tool_name,
      input: ev.request.input, suggestions: ev.request.permission_suggestions,
    };
    pendingPermissions.add(request);
    appendBlock(c, it, request);
    renderQuickPermission();
    window.dispatchEvent(new CustomEvent("neutron-permission",{detail:chatId}));
    if (chat?.id !== chatId) toast(`„${c.title}”: engedélyt kér (${ev.request.tool_name})`);
    return;
  }

  if (ev.type === "result") {
    const it = currentTurn(c);
    c.sessionId = ev.session_id || c.sessionId;
    if(ev.is_error && retryRateLimit(c,st,it,[ev.result,ev.errors,st.stderr,...it.blocks.filter(b=>b.type==="text").map(b=>b.text)].filter(Boolean).join("\n")))return;
    if (ev.is_error && ev.result) appendBlock(c, it, { type: "error", text: ev.result });
    else if (!it.blocks.some((b) => b.type === "text") && typeof ev.result === "string" && ev.result.trim())
      appendBlock(c, it, { type: "text", text: ev.result });
    c.sessionId = ev.session_id || c.sessionId;
    const secs = ((ev.duration_ms || 0) / 1000).toFixed(1);
    const tok = ev.usage ? ` · ${(ev.usage.input_tokens || 0) + (ev.usage.cache_read_input_tokens || 0)} be / ${ev.usage.output_tokens || 0} ki token` : "";
    it.meta = `${secs} mp${ev.num_turns ? ` · ${ev.num_turns} lépés` : ""}${tok}`;
    finishTurn(c, it);
  }
});

function finishTurn(c, it) {
  for(const b of it.blocks) if(b.hu && b.type==="text") b.text=repairHungarian(b.text);
  const paths=new Set(it.changedPaths || []);
  delete it.changedPaths;
  const success=it.blocks.filter(b=>b.type==="tool" && !b.isError && b.result!=null);
  for(const b of success) if(["Write","Edit","MultiEdit"].includes(b.name) && b.input?.file_path) paths.add(b.input.file_path);
  const build=success.some(b=>/\b(?:build|vite|webpack|parcel)\b/i.test(b.input?.command || ""));
  if(it.started && (paths.size || build)) {
    const existing=it.blocks.filter(b=>b.type==="attachment").map(b=>b.name);
    N.artifacts.collect({id:c.id,projectId:c.projectId,cwd:c.cwd},{paths:[...paths],build,started:it.started,existing}).then(names=>{
      for(const name of names) appendBlock(c,it,{type:"attachment",name});
      if(names.length){save(c);if(chat?.id===c.id) showFiles(names.find(n=>n.endsWith(".zip")) || names.find(n=>/\.html?$/i.test(n)) || names[0]);}
    }).catch(e=>toast(e.message,true));
  }
  window.dispatchEvent(new CustomEvent("neutron-turn-ended",{detail:{id:c.id,turn:it}}));
  live.delete(c.id);
  if (it.blocks.some(b=>b.type==="text") && !it.blocks.some(b=>b.type==="error") && it.meta!=="Leállítva") window.dispatchEvent(new Event("neutron-reply"));
  for (const request of pendingPermissions) {
    if (request.chatId === c.id) pendingPermissions.delete(request);
  }
  renderQuickPermission();
  if (c.provider !== "codex" && it.meta !== "Leállítva") scanWake(c, it);
  it.blocks.forEach((b) => { if (b.type === "thinking") b.done = true; if (b.type === "tool" && b.result == null) { b.result = "(megszakítva)"; b.isError = true; } });
  if (chat && c.id === chat.id) {
    const el = blockEls.get(it);
    if (el) {
      el.classList.remove("streaming");
      el.querySelector(".typing")?.remove();
      it.blocks.forEach(updateBlock);
      if (it.meta) el.querySelector(".body").insertAdjacentHTML("beforeend", `<div class="meta">${esc(it.meta)}</div>`);
    }
    setBusyUi();
  } else renderList();
  save(c).then(refreshList);
}

N.cc.onStderr(({ chatId, text }) => {
  const st = live.get(chatId);
  if (st) st.stderr = (st.stderr + text).slice(-3000);
});

N.cc.onExit(({ chatId, code, error }) => {
  const c = open.get(chatId), st = live.get(chatId);
  if (!c || !st || st.retryTimer) return;
  const it = currentTurn(c);
  const msg = error || st.stderr.split("\n").filter((l) => l && !l.includes("unrecognized_model")).slice(-8).join("\n");
  if (code !== 0 && code !== null && retryRateLimit(c,st,it,msg))return;
  if (code !== 0 && code !== null) appendBlock(c, it, { type: "error", text: `${c.provider === "codex" ? "A Codex" : "A Claude CLI"} kilépett (${code}).\n${msg}` });
  else if (code === null) it.meta = "Leállítva";
  finishTurn(c, it);
});

// ---------- popovers (model, mode, slash) ----------
let popEl = null;
function closePop() { popEl?.remove(); popEl = null; }
function popover(anchor, { items, search, onPick, current, up }) {
  closePop();
  showEffort(false);
  const p = document.createElement("div");
  p.className = "pop";
  document.body.append(p);
  popEl = p;
  const r = anchor.getBoundingClientRect();
  p.style.left = Math.min(r.left, innerWidth - 470) + "px";
  if (up) { p.style.bottom = innerHeight - r.top + 8 + "px"; p.style.transformOrigin = "bottom"; }
  else p.style.top = r.bottom + 8 + "px";
  let sel = 0, shown = items;
  const draw = (q = "") => {
    const rows = [];
    let hdr = null;
    for (const i of items) {
      if (i.header) { hdr = i; continue; }
      if (!(i.label + (i.sub || "") + (i.group || "")).toLowerCase().includes(q.toLowerCase())) continue;
      if (hdr) { rows.push(hdr); hdr = null; }
      rows.push(i);
    }
    shown = rows.filter((i) => !i.header);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    list.innerHTML = "";
    let n = -1;
    rows.slice(0, 260).forEach((i) => {
      if (i.header) { list.insertAdjacentHTML("beforeend", `<div class="grp">${esc(i.label)}</div>`); return; }
      n++;
      const o = document.createElement("button");
      o.className = "opt" + (i.value === current ? " cur" : "") + (n === sel ? " sel" : "");
      o.innerHTML = `<b>${esc(i.label)}</b>${i.sub ? `<small>${esc(i.sub)}</small>` : ""}`;
      // stopPropagation: otherwise the window "click outside" handler closes a popover that onPick just opened
      o.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); closePop(); onPick(i.value); };
      list.append(o);
    });
    if (!shown.length) list.innerHTML = `<div class="opt"><small>${!items.length ? "Írd be, majd nyomj Entert" : `Nincs találat${search ? " — Enter: használd ezt a nevet" : ""}`}</small></div>`;
  };
  let input = null;
  if (search) {
    input = document.createElement("input");
    input.placeholder = search;
    p.append(input);
    input.oninput = () => draw(input.value);
    input.onkeydown = (e) => {
      if (e.key === "Enter") { const v = shown[sel]?.value ?? input.value.trim(); closePop(); onPick(v); }
      else if (e.key === "Escape") closePop();
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") { sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length; draw(input.value); }
    };
  }
  const list = document.createElement("div");
  p.append(list);
  draw();
  input?.focus();
  p.move = (d) => { sel = (sel + d + shown.length) % Math.max(1, shown.length); draw(p.query || ""); };
  p.pick = () => { const i = shown[sel]; if (i) { closePop(); onPick(i.value); } };
  p.filter = (q) => { p.query = q; sel = 0; draw(q); };
  return p;
}
addEventListener("mousedown", (e) => { if (popEl && !popEl.contains(e.target)) closePop(); });

function restartSession(c) { if (!live.has(c.id)) N.cc.stop(c.id); }

$("#modelChip").onclick = async () => {
  try { await refreshModels(); } catch { toast("Az FCC modellistája most nem frissíthető.", true); }
  const items = [{ header: true, label: "OpenAI Codex" }, { value: "codex|", label: "Codex · alapmodell" },
    ...codexModels.map(m => ({ value: "codex|" + m, label: m, group: "codex" })),
    { header: true, label: "Free Claude Code (ingyenes modellek)" },
    ...models.map((m) => ({ value: `fcc|${m}`, label: shortModel(m), sub: m.split("/").slice(0, -1).join("/"), group: "fcc free" }))];
  for (const a of accounts()) {
    const st = accStatus.get(a.id);
    items.push({ header: true, label: `Claude · ${a.name}${st?.email ? ` · ${st.email}` : ""}${st?.plan ? ` (${st.plan})` : ""}` });
    if (st && !st.loggedIn) items.push({ value: `login|${a.id}`, label: "Bejelentkezés…", sub: "Ez a fiók még nincs bejelentkezve", group: a.name });
    for (const [v, label, sub] of CLAUDE_MODELS) items.push({ value: `${a.id}|${v}`, label, sub, group: `claude ${a.name}` });
  }
  popover($("#modelChip"), {
    up: true, items, search: "Modell keresése vagy teljes azonosító…", current: `${chat.provider}|${chat.model}`,
    onPick: (v) => {
      if (!v) return;
      const [provider, ...rest] = v.includes("|") ? v.split("|") : [chat.provider, v];
      const model = rest.join("|");
      if (provider === "login") return loginAccount(accounts().find((a) => a.id === model));
      if (!switchModel(provider, model)) return;
      toast(`Modell: ${$("#modelName").textContent}`);
    },
  });
};
function switchModel(provider, model) {
  if (live.has(chat.id) || view === "term") { toast("Modellváltáshoz térj vissza egy befejezett chathez."); return false; }
  if (chat.items.length && (chat.provider === "codex") !== (provider === "codex")) {
    const character = chat.character ? { ...chat.character, provider, model } : null;
    newChat(character, provider);
    toast("A szolgáltatóváltáshoz új csevegés indult.");
  }
  restartSession(chat);
  chat.provider = cfg.provider = provider;
  chat.model = model;
  cfg[provider === "codex" ? "codexModel" : provider === "fcc" ? "model" : "claudeModel"] = model;
  N.config.set(cfg); save(chat); renderChat();
  return true;
}

$("#modeChip").onclick = () => {
  const target = chat;
  const cx = target.provider === "codex";
  popover($("#modeChip"), {
    items: Object.entries(cx ? { "read-only": "Csak olvasás", "workspace-write": "A munkamappa szerkesztése" } : MODES)
      .map(([value, label]) => ({ value, label })).concat(
        [{value:"add-folder",label:"Mappa vagy meghajtó hozzáadása…"}],
        (target.extraDirs || []).map(dir=>({value:"remove:"+dir,label:"Hozzáadott mappa eltávolítása",sub:dir}))),
      current: cx ? chat.codexSandbox || "read-only" : chat.mode,
    onPick: async m => {
      if (live.has(target.id)) return toast("Várd meg a futó választ a jogosultságok módosításához.");
      if (m === "add-folder" || m.startsWith("remove:")) {
        if (m === "add-folder") {
          const dir = await N.pickDir();
          if (!dir || target !== chat || live.has(target.id)) return;
          target.extraDirs = [...new Set([...(target.extraDirs || []),dir])];
          if (cx) target.codexSandbox = "workspace-write";
        } else target.extraDirs = target.extraDirs.filter(dir=>dir!==m.slice(7));
        restartSession(target);
        if (termChatId === target.id) { N.term.stop(); termChatId = null; }
        updateChips(); await save(target); return;
      }
      if (cx) chat.codexSandbox = m; else { chat.mode = cfg.mode = m; N.config.set(cfg); }
      restartSession(chat); updateChips(); save(chat);
    },
  });
};
let fccLevels = {}, codexLevels = {}, defaultCodex = "";
function effortLevels(c) {
  if (c.provider === "fcc") return fccLevels[c.model] || [];
  if (c.provider === "codex") return codexLevels[c.model || defaultCodex] || [];
  if (/(opus|sonnet)-4[.-]6/i.test(c.model)) return ["low","medium","high","max"];
  if (!c.model || /^(fable|opus|sonnet|haiku)$|fable-|(?:opus|sonnet)-5|haiku-5[.-]5|opus-4[.-][78]/i.test(c.model))
    return ["low","medium","high","xhigh","max"];
  return [];
}
function showEffort(opened) {
  $("#effortBar").hidden=!opened;
  $("#effortChip").setAttribute("aria-expanded",opened);
}
$("#effortChip").onclick=()=>{
  closePop();
  const opened=$("#effortBar").hidden;
  showEffort(opened);
  if(opened)$("#effortSlider").focus();
};
addEventListener("pointerdown",event=>{
  if(!event.target.closest(".effort-control"))showEffort(false);
});
$("#effortBar").onkeydown=event=>{
  if(event.key==="Escape"){event.stopPropagation();showEffort(false);$("#effortChip").focus();}
};
function renderEffort() {
  const levels = ["", ...effortLevels(chat)], key = chat.provider === "codex" ? "codexEffort" : "effort";
  const index = Math.max(0, levels.indexOf(chat[key]));
  if (chat.provider !== "fcc" || models.length) chat[key] = levels[index];
  $("#effortChip").hidden = levels.length < 2;
  if (levels.length < 2) showEffort(false);
  const slider = $("#effortSlider");
  slider.style.setProperty("--steps",Math.max(1,levels.length-1));
  slider.max = levels.length - 1; slider.value = index;
  $("#resetEffort").disabled=slider.disabled = live.has(chat.id) || view === "term";
  $("#effortModel").textContent=shortModel(chat.model || (chat.provider==="codex"?defaultCodex:"") || "Alapmodell");
  const ticks=$("#effortTicks");
  if(ticks.childElementCount!==levels.length)ticks.replaceChildren(...levels.map(()=>document.createElement("i")));
  const label = () => {
    const value = EFFORTS[levels[slider.value]] || levels[slider.value];
    $("#effortChip").textContent = $("#effortName").textContent = value; slider.setAttribute("aria-valuetext", value);
    slider.style.setProperty("--fill", (100 * Number(slider.value) / Math.max(1,levels.length - 1)) + "%");
  };
  label(); slider.oninput = label;
  slider.onchange = () => { chat[key] = levels[slider.value]; label(); restartSession(chat); save(chat); };
  $("#resetEffort").onclick=()=>{slider.value=0;slider.onchange();};
}
let catalogRequest, lastCatalog;
function refreshModels() {
  if (!catalogRequest) catalogRequest = loadModels().finally(() => { catalogRequest = null; });
  return catalogRequest;
}
async function loadModels() {
  const catalog = await N.fcc.models();
  $("#fccDot").className = "status-dot ok";
  $("#fccText").textContent = `FCC · ${catalog.length} modell`;
  const snapshot = JSON.stringify(catalog);
  if (lastCatalog === snapshot) return;
  lastCatalog = snapshot;
  models = catalog.map(m => m.id);
  fccLevels = Object.fromEntries(catalog.map(m => [m.id, m.levels]));
  if(view==="video")fillVideoModels();
  if (chat) renderEffort();
  if (characterDialog.open && profileProvider.value === "fcc") fillCharacterModels(profileModel.value);
  if ($("#voiceDialog").open && $("#assistantProvider").value === "fcc") fillVoiceModels($("#assistantModel").value);
}

// ---------- reusable characters ----------
const characterDialog = $("#characters");
let editingId = "", avatar = "", avatarJob = 0, codexModels = [];
const profileProvider = $("#characterProvider"), profileModel = $("#characterModel");

function providerLabel(provider, model) {
  const brand = { codex: "Codex", fcc: "FCC" }[provider] || accName(provider);
  return model ? brand + " · " + shortModel(model) : brand;
}

function portrait(profile, extra = "") {
  const name = profile.name || "✦";
  const initials = name.trim().split(/\s+/u).slice(0, 2).map(word => Array.from(word)[0]).join("");
  const hue = Array.from(name).reduce((h, char) => (h * 31 + char.codePointAt(0)) % 360, 247);
  const img = /^data:image\/webp;base64,[A-Za-z0-9+/=]+$/.test(profile.avatar || "");
  return `<span aria-hidden="true" class="portrait ${extra}" style="--hue:${hue}">${img ? '<img alt="" src="' + profile.avatar + '">' : esc(initials)}</span>`;
}

function choice(profile, sub, action, current = false) {
  const button = document.createElement("button");
  button.type = "button"; button.className = "choice";
  button.setAttribute("aria-current", String(current));
  button.innerHTML = portrait(profile) + `<span class="captions"><b>${esc(profile.name)}</b><small>${esc(sub)}</small></span>`;
  button.onclick = action;
  return button;
}

function startProfile(profile, provider) {
  if (profile?.provider === "web") return showStudio(profile.id);
  if (view !== "chat") setView("chat");
  newChat(profile, provider);
}

function showChooser() {
  const dialog = $("#newChooser");
  const start = (profile, provider) => { dialog.close(); startProfile(profile, provider); };
  const card = choice({name: "Neutron"}, "Alapkarakter", () => start(null, cfg.provider || "fcc"));
  card.querySelector(".portrait").innerHTML = '<img alt="" src="icon.png">';
  $("#quickChoices").replaceChildren(card);
  const list = $("#savedChoices");
  list.replaceChildren(...(cfg.characters || []).filter(c => c.provider !== "web").map(c => choice(c, providerLabel(c.provider, c.model), () => start(c))));
  if (!list.children.length) list.innerHTML = '<p class="gallery-empty">Még nincs mentett karaktered.</p>';
  dialog.showModal();
}
$("#closeChooser").onclick = () => $("#newChooser").close();
$("#addFromChooser").onclick = () => { $("#newChooser").close(); showStudio(""); };

function drawPortrait() {
  $("#avatarPreview").innerHTML = portrait({name: $("#characterName").value, avatar}, "large");
  $("#clearAvatar").hidden = !avatar;
}
$("#characterName").oninput = drawPortrait;
$("#pickAvatar").onclick = () => $("#avatarFile").click();
$("#clearAvatar").onclick = () => { avatarJob++; avatar = ""; $("#characterForm").removeAttribute("aria-busy"); $("#studioStatus").textContent = ""; drawPortrait(); };
async function profileImage(file) {
  if (file.size > 12 * 1024 * 1024 || !["image/jpeg","image/png","image/webp"].includes(file.type))
    throw Error("Legfeljebb 12 MB-os PNG-, JPG- vagy WebP-képet válassz.");
  const image = await createImageBitmap(file);
  try {
    const side = Math.min(image.width, image.height), canvas = document.createElement("canvas");
    canvas.width = canvas.height = 192;
    canvas.getContext("2d").drawImage(image,(image.width-side)/2,(image.height-side)/2,side,side,0,0,192,192);
    return canvas.toDataURL("image/webp",0.87);
  } finally { image.close(); }
}
$("#avatarFile").onchange = async event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  const job = ++avatarJob;
  $("#characterForm").removeAttribute("aria-busy");
  const status = $("#studioStatus");
  status.textContent = "A kép betöltése…";
  $("#characterForm").setAttribute("aria-busy", "true");
  try {
    const image = await profileImage(file);
    if (job !== avatarJob) return;
    avatar = image;
    drawPortrait(); status.textContent = "";
  } catch { if (job === avatarJob) status.textContent = "Ezt a képet nem sikerült betölteni."; }
  finally { if (job === avatarJob) $("#characterForm").removeAttribute("aria-busy"); }
};

function modelField(input) {
  const field = input.closest(".model-picker");
  const list = field.querySelector('[role="listbox"]'), toggle = field.querySelector("button");
  let options = [], active = -1;
  function close() {
    list.hidden = true;
    active = -1;
    input.removeAttribute("aria-activedescendant");
    input.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-expanded", "false");
  }
  function show(query = "") {
    const needle = query.toLocaleLowerCase();
    active = -1;
    input.removeAttribute("aria-activedescendant");
    const matches = options.filter(([id, name]) => (id + " " + name).toLocaleLowerCase().includes(needle));
    list.replaceChildren(...matches.map(([id, name], index) => {
      const row = document.createElement("div");
      row.id = list.id + "-" + index;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(id === input.value));
      row.dataset.value = id;
      row.textContent = name || id;
      row.title = id || name;
      return row;
    }));
    if (!matches.length) { close(); return; }
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    toggle.setAttribute("aria-expanded", "true");
    list.scrollTop = 0;
  }
  function pick(row) {
    input.value = row.dataset.value;
    close();
    input.focus({preventScroll:true});
    input.dispatchEvent(new Event("change", {bubbles:true}));
  }
  toggle.onclick = () => {
    if (!list.hidden) return close();
    input.focus({preventScroll:true}); show();
  };
  input.onclick = () => show();
  input.oninput = () => show(input.value);
  input.onkeydown = e => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (list.hidden) show();
      if (list.hidden) return;
      const rows = list.children;
      if (active >= 0) rows[active].classList.remove("highlight");
      active = e.key === "ArrowDown" ? Math.min(active + 1, rows.length - 1) : (active < 0 ? rows.length - 1 : Math.max(0, active - 1));
      const row = rows[active];
      row.classList.add("highlight");
      input.setAttribute("aria-activedescendant", row.id);
      row.scrollIntoView({block:"nearest"});
    } else if (!list.hidden && (e.key === "Escape" || e.key === "Enter")) {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Enter" && active >= 0) pick(list.children[active]);
      else close();
    }
  };
  list.onmousedown = e => { if (e.target.closest('[role="option"]')) e.preventDefault(); };
  list.onclick = e => { const row = e.target.closest('[role="option"]'); if (row) pick(row); };
  function outside(e) { if (!list.hidden && !field.contains(e.target)) close(); }
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("focusin", outside);
  field.closest("dialog").addEventListener("close", close);
  return (provider, value) => {
    close();
    options = provider === "fcc" ? models.map(id => [id,id]) : provider === "codex" ?
      [["","A fiók alapmodellje"], ...codexModels.map(id => [id,id])] : CLAUDE_MODELS;
    input.value = value;
    input.required = provider === "fcc";
    input.placeholder = input.required ? "Válassz vagy írj be egy modellazonosítót" : "A fiók alapmodellje";
  };
}
const setCharacterModels = modelField(profileModel);
function fillCharacterModels(value) { setCharacterModels(profileProvider.value, value); }

function editCharacter() {
  const profile = cfg.characters.find(c => c.id === editingId);
  $("#characterForm").removeAttribute("aria-busy");
  avatarJob++; avatar = profile?.avatar || "";
  $("#studioStatus").textContent = "";
  $("#characterName").value = profile?.name || ""; drawPortrait();
  $("#characterPrompt").value = profile?.prompt || "";
  $("#deleteCharacter").hidden = !profile;
  profileProvider.replaceChildren(new Option("Free Claude Code", "fcc"), new Option("OpenAI Codex", "codex"),
    ...accounts().map(a => new Option("Claude Code · " + a.name, a.id)));
  profileProvider.value = profile?.provider || chat?.provider || "fcc";
  if (!profileProvider.value) profileProvider.add(new Option("Válassz új szolgáltatót", "", true, true));
  fillCharacterModels(profile?.model ?? chat?.model ?? "");
}

function listCharacters(id = "") {
  editingId = cfg.characters.some(c => c.id === id) ? id : "";
  $("#studioProfiles").replaceChildren(...cfg.characters.map(c =>
    choice(c, providerLabel(c.provider, c.model), () => listCharacters(c.id), c.id === editingId)));
  editCharacter();
}
function showStudio(id) {
  cfg.characters ||= [];
  listCharacters(id);
  characterDialog.showModal();
}
$("#charactersBtn").onclick = () => showStudio(chat?.character?.id || cfg.characters?.[0]?.id);
$("#closeCharacters").onclick = () => characterDialog.close();
$("#addProfile").onclick = () => { listCharacters(); $("#characterName").focus(); };
profileProvider.onchange = () => fillCharacterModels(profileProvider.value === "fcc" ? cfg.model || defaultModel() : "");
$("#deleteCharacter").onclick = async () => {
  if (!confirm("Törlöd ezt a karaktert? A korábbi beszélgetéseit továbbra is eléred.")) return;
  try {
    const characters = cfg.characters.filter(c => c.id !== editingId);
    await N.config.set({ ...cfg, characters });
    cfg.characters = characters;
    listCharacters();
  } catch { toast("A karakter törlése sikertelen.", true); }
};
$("#characterForm").onsubmit = async event => {
  event.preventDefault();
  if (event.currentTarget.getAttribute("aria-busy") === "true") return;
  const status = $("#studioStatus");
  const start = event.submitter === $("#startCharacter");
  const provider = profileProvider.value;
  const profile = { id: editingId || crypto.randomUUID(), avatar, name: $("#characterName").value.trim(),
    prompt: $("#characterPrompt").value.trim(), provider, model: profileModel.value.trim() };
  if (!profile.name) return status.textContent = "Adj nevet a karakternek.";
  if (!provider || (provider === "fcc" && !profile.model)) return status.textContent = "Válassz elérhető fiókot és modellt.";
  const characters = editingId ? cfg.characters.map(c => c.id === editingId ? profile : c) : [...cfg.characters, profile];
  try {
    await N.config.set({ ...cfg, characters });
    cfg.characters = characters;
    listCharacters(profile.id);
    if (!start) { $("#studioStatus").textContent = "Karakter mentve."; return; }
    characterDialog.close(); startProfile(profile);
  } catch (err) { status.textContent = "Sikertelen mentés: " + err.message; }
};

// ---------- Claude accounts (each extra one is its own CLAUDE_CONFIG_DIR) ----------
function accounts() {
  cfg.accounts ||= [];
  if (!cfg.accounts.some((a) => a.id === "default")) cfg.accounts.unshift({ id: "default", name: "Fő fiók", dir: null });
  return cfg.accounts;
}
const accName = (id) => accounts().find((a) => a.id === id)?.name || id;

async function refreshAccounts() {
  await Promise.all([...accounts(), {id: "codex"}].map(async (a) => accStatus.set(a.id, await N.accounts.status(a.id))));
}

function loginAccount(a) {
  if (!a) return;
  if (chat && live.has(chat.id)) return toast("Előbb várd meg a választ.");
  setView("term", () => {
    term.reset();
    N.cc.stop(chat.id);
    termChatId = "login:" + a.id;
    N.term.start({ provider: a.id, cwd: home, args: a.id === "codex" ? ["login"] : ["auth", "login"], cols: term.cols, rows: term.rows });
    $("#termInfo").textContent = `Bejelentkezés: ${a.name} — kövesd a böngészőben megnyíló oldalt`;
    term.focus();
  });
}

$("#dirChip").onclick = async () => {
  if (chat.items.length) return toast("A munkakönyvtár csak új csevegésnél választható.");
  const d = await N.pickDir();
  if (!d) return;
  chat.cwd = d; cfg.lastCwd = d; N.config.set(cfg); updateChips();
};

function slashMenu() {
  if (chat?.provider === "codex") return;
  const v = $("#input").value;
  const m = /^\/(\S*)$/.exec(v);
  if (!m) { if (popEl?.slash) closePop(); return; }
  const meta = slashMeta.slash.length ? slashMeta : cfg.slashCache || { slash: FALLBACK_SLASH, term: [] };
  if (!popEl?.slash) {
    const items = [...new Set([...(meta.slash || []), ...(meta.term || [])])]
      .map((s) => ({ value: s, label: "/" + s, sub: meta.slash?.includes(s) ? "" : "interaktív · Terminál fülön fut" }));
    popover($("#composer"), {
      items, up: true,
      onPick: (s) => { $("#input").value = "/" + s + " "; $("#input").focus(); },
    }).slash = true;
  }
  popEl.filter(m[1]);
}

// ---------- terminal (real fcc-claude TUI) ----------
function ensureTerm() {
  if (term) return;
  term = new Terminal({
    fontFamily: "JetBrains Mono, Fira Code, ui-monospace, monospace", fontSize: 13.5, cursorBlink: true, allowProposedApi: true,
    theme: { background: "#05050c", foreground: "#ecebff", cursor: "#22d3ee", selectionBackground: "#8b5cf655",
      black: "#1e1e2e", magenta: "#c084fc", cyan: "#22d3ee", blue: "#818cf8", green: "#34d399", red: "#fb7185", yellow: "#fbbf24" },
  });
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($("#termBox"));
  term.onData((d) => N.term.input(d));
  term.onResize(({ cols, rows }) => N.term.resize({ cols, rows }));
  new ResizeObserver(() => view === "term" && fit.fit()).observe($("#termBox"));
  N.term.onData((d) => term.write(d));
  N.term.onExit((code) => {
    if (termChatId?.startsWith("login:")) refreshAccounts().then(() => { updateChips(); toast("Fiókállapot frissítve."); });
    termChatId = null;
    term.write(`\r\n\x1b[38;5;141m— a terminálfolyamat kilépett (${code}). Újraindítás a gombbal. —\x1b[0m\r\n`);
  });
}

function startTerm(extra = []) {
  if (!hasChatProvider(chat)) return setView("chat");
  if (chat.provider === "codex" && !chat.codexThread) {
    setView("chat"); return toast("A terminálhoz küldd el az első üzenetet a Codex-chatben.");
  }
  ensureTerm();
  fit.fit();
  term.reset();
  N.cc.stop(chat.id); // one writer per session: the TUI takes over until we go back to chat
  termChatId = chat.id;
  const args = ["--permission-mode", chat.mode, ...(chat.model ? ["--model", chat.model] : []),
    ...(effortLevels(chat).includes(chat.effort) ? ["--effort", chat.effort] : []), ...extra];
  N.term.start({ scope: {...artifactScope(),cwd:chat.cwd,extraDirs:chat.extraDirs}, provider: chat.provider, cwd: chat.cwd, args, codexChat: chat.provider === "codex" ? {...artifactScope(), cwd:chat.cwd, model: chat.model, codexThread: chat.codexThread, codexSandbox: chat.codexSandbox, extraDirs:chat.extraDirs, codexEffort: effortLevels(chat).includes(chat.codexEffort) ? chat.codexEffort : ""} : null, character: chat.character, cols: term.cols, rows: term.rows, sessionId: chat.sessionId });
  $("#termInfo").textContent = `${chat.provider === "codex" ? "Codex" : chat.provider === "fcc" ? "fcc-claude" : "claude · " + accName(chat.provider)} · ${shortDir(chat.cwd)} · ${$("#modelName").textContent}`;
  term.focus();
}

function setView(v, start) {
  if (v === "term" && live.has(chat.id)) return toast("Előbb várd meg a választ, vagy állítsd le.");
  view = v; renderEffort();
  document.querySelectorAll("#viewToggle button").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
  movePill();
  $("#chatView").classList.toggle("hidden", v !== "chat");
  $("#termView").classList.toggle("hidden", v !== "term");
  $("#videoView").classList.toggle("hidden", v !== "video");
  for(const [mode,id] of [["chat","chatView"],["term","termView"],["video","videoView"]])$("#"+id).inert=mode!==v;
  if (v === "term") {
    ensureTerm();
    fit.fit();
    if (start) start();
    else if (termChatId !== chat.id) startTerm();
    else { fit.fit(); term.focus(); }
  } else {
    N.term.stop(); // the chat process resumes the same session on the next message
    termChatId = null;
    if(v==="video") {closeFiles();enterVideoEditor();}
    else { $("#videoPlayer").pause();$("#input").focus(); }
  }
}
function movePill() {
  const on = $("#viewToggle button.on"), pill = $("#viewToggle .pill");
  pill.style.width = on.offsetWidth + "px";
  pill.style.transform = `translateX(${on.offsetLeft - 4}px)`;
}
document.querySelectorAll("#viewToggle button").forEach((b) => (b.onclick = () => setView(b.dataset.view)));
$("#termRestart").onclick = () => startTerm();

// ---------- input & shortcuts ----------
function autoGrow() { const t = $("#input"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 240) + "px"; }
$("#input").addEventListener("input", () => { autoGrow(); slashMenu(); });
$("#input").addEventListener("keydown", (e) => {
  if (popEl?.slash) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); return popEl.move(e.key === "ArrowDown" ? 1 : -1); }
    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && /^\/\S*$/.test($("#input").value) && !$("#input").value.includes(" "))) {
      const exact = $("#input").value.slice(1);
      if (e.key === "Tab" || !(slashMeta.slash.includes(exact) || slashMeta.term.includes(exact))) { e.preventDefault(); return popEl.pick(); }
    }
    if (e.key === "Escape") { e.preventDefault(); return closePop(); }
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
$("#send").onclick = () => (chat && live.has(chat.id) ? stop() : send());
$("#newChat").onclick = showChooser;
$("#search").oninput = renderList;
$("#toggleSide").onclick = () => { $("#app").classList.toggle("collapsed"); setTimeout(movePill, 460); };
$("#adminBtn").onclick = () => N.fcc.admin();
$("#thread").addEventListener("click", (e) => {
  const a = e.target.closest("a[href]");
  if (a) { e.preventDefault(); window.open(a.href); }
});
addEventListener("keydown", (e) => {
  if (document.querySelector("dialog[open]")) return;
  if (e.ctrlKey && e.key.toLowerCase() === "n") { e.preventDefault(); $("#newChat").click(); }
  else if (e.ctrlKey && e.key.toLowerCase() === "b") { e.preventDefault(); $("#toggleSide").click(); }
  else if (e.ctrlKey && e.key === "`") { e.preventDefault(); setView(view === "chat" ? "term" : "chat"); }
  else if (e.key === "Escape" && view === "chat" && !popEl) stop();
});
addEventListener("resize", movePill);

// ---------- boot ----------
addEventListener("DOMContentLoaded", async function boot() {
  const [config, userHome, catalog] = await Promise.all([N.config.get(), N.home(), N.codexModels()]);
  const returning = Object.keys(config).length > 0;
  cfg = config; home = userHome; codexModels = catalog.entries.map(m => m.id);
  codexLevels = Object.fromEntries(catalog.entries.map(m => [m.id, m.levels])); defaultCodex = catalog.defaultModel;
  await initProjects();
  movePill();
  await refreshList();
  newChat();
  for (const { id } of chats) { // wakeups survive an app restart; overdue ones fire right away
    const c = await getChat(id);
    for (const b of c?.items.flatMap((i) => i.blocks || []) || []) if (b.type === "wake" && b.state === "pending") arm(c, b);
  }
  window.dispatchEvent(new CustomEvent("neutron-ready",{detail:{returning:returning || chats.length>0}}));
  refreshAccounts();
  const syncCatalog = () => { if (!document.hidden) refreshModels().catch(() => {}); };
  window.addEventListener("focus", syncCatalog);
  setInterval(syncCatalog, 30000);
  const ok = await N.fcc.ensure();
  $("#fccDot").className = "status-dot " + (ok ? "ok" : "bad");
  $("#fccText").textContent = ok ? "FCC kapcsolódva" : "FCC nem fut";
  if (!ok) return toast("Nem sikerült elindítani az fcc-server-t. Indítsd el kézzel: fcc-server", true);
  try {
    await refreshModels();
    renderEffort();
    $("#fccText").textContent = `FCC · ${models.length} modell`;
  } catch (e) { toast("Modellek lekérése sikertelen: " + e.message, true); }
  if (!chat.character && !chat.items.length && !chat.model && chat.provider === "fcc") { chat.model = defaultModel(); updateChips(); }
});
