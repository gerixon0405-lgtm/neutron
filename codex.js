const fs = require("fs");
const path = require("path");
const os = require("os");
const spaces = require("./workspaces");
const readline = require("readline");
const { spawn } = require("child_process");

function binary() {
  return require("./runtime").binary("codex");
}

function models() {
  const dir = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(dir, "models_cache.json"), "utf8"));
    const entries = cache.models.filter(m => m.visibility === "list" && typeof m.slug === "string").map(m => ({
      id: m.slug, levels: m.supports_reasoning_effort_updates === false ? [] : (m.supported_reasoning_levels || []).map(l => l.effort),
    }));
    let selected;
    try { selected = /^model\s*=\s*["']([^"']+)/m.exec(fs.readFileSync(path.join(dir,"config.toml"),"utf8").split(/^\s*\[/m)[0])?.[1]; } catch {}
    return { entries, defaultModel: selected || entries[0]?.id || "" };
  } catch { return { entries: [], defaultModel: "" }; }
}

function options(chat) {
  const args = [...spaces.mcpArgs(chat, true), "--sandbox", chat.codexSandbox === "workspace-write" ? "workspace-write" : "read-only"];
  if (chat.model) args.push("--model", chat.model);
  if (["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(chat.codexEffort)) args.push("-c", "model_reasoning_effort=" + chat.codexEffort);
  return args;
}

function run(chat, text, notify, done, jpeg=null) {
  const args = ["exec", ...options(chat), "--json", "--skip-git-repo-check"];
  if (chat.codexThread) args.push("resume", chat.codexThread);
  let imageDir;
  if(jpeg) {
    imageDir=fs.mkdtempSync(path.join(os.tmpdir(),"neutron-screen-"));
    const file=path.join(imageDir,"screen.jpg");fs.writeFileSync(file,jpeg,{mode:0o600});args.push("--image",file);
  }
  args.push("-");
  const child = spawn(binary(), args, { cwd: chat.cwd, stdio: ["pipe", "pipe", "pipe"] });
  if(imageDir) child.once("close",()=>fs.rmSync(imageDir,{recursive:true,force:true}));
  let problem = "", diagnostics = "", completed = false;
  readline.createInterface({ input: child.stdout }).on("line", line => {
    let e;
    try { e = JSON.parse(line); } catch { return; }
    if (e.type === "thread.started") notify({ kind: "thread", id: e.thread_id });
    if (e.type === "item.completed" && e.item?.type === "agent_message") notify({ kind: "message", text: e.item.text });
    if (e.type === "item.completed" && e.item?.type === "command_execution")
      notify({ kind: "command", name: e.item.command, result: (e.item.aggregated_output || "").slice(-12000), failed: e.item.exit_code !== 0 });
    if(e.type==="item.completed" && e.item?.type==="file_change" && e.item.status!=="failed")
      notify({kind:"files",paths:(e.item.changes || []).filter(f=>f.kind!=="delete").map(f=>f.path)});
    if (e.type==="item.completed" && e.item?.type==="mcp_tool_call" && e.item.server==="neutron" && e.item.status==="completed" && !e.item.result?.isError)
      notify({kind:"output",tool:"mcp__neutron__"+e.item.tool,input:e.item.arguments,body:(e.item.result?.content || []).map(x=>x.text || "").join("\n")});
    if (e.type === "turn.completed") completed = true;
    if (e.type === "turn.failed" || e.type === "error") problem = e.error?.message || e.message || "A Codex nem adott választ.";
  });
  child.stderr.on("data", d => { diagnostics = (diagnostics + d).slice(-1800); });
  child.on("error", err => { problem = err.code === "ENOENT" ? "A Codex CLI vagy a kiválasztott munkamappa nem található." : err.message; });
  child.stdin.on("error", err => { if (err.code !== "EPIPE") problem = err.message; });
  child.once("close", code => done(code, completed && code === 0 ? "" : problem || diagnostics.trim() || "A Codex futása megszakadt."));
  const persona = !chat.codexThread && chat.character ? `A karaktered neve: ${chat.character.name}\n${chat.character.prompt}\n\n` : "";
  child.stdin.end((chat.codexThread ? "" : spaces.guidance + "\n\n") + persona + text);
  return child;
}

module.exports = { binary, models, options, run };
