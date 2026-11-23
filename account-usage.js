const os = require("node:os");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");

function claudeMeters(report) {
  const limits = report?.rate_limits?.limits;
  if (!Array.isArray(limits)) return [];
  return limits.filter(row => Number.isFinite(row?.percent)).map(row => ({
    window: row.kind === "session" || row.group === "session" ? "session" : row.group === "weekly" || String(row.kind).startsWith("weekly_") ? "weekly" : "",
    scope: [row.scope?.model?.display_name, row.scope?.surface?.display_name].filter(Boolean).join(" · "),
    percent: row.percent,
    reset: row.resets_at ? Date.parse(row.resets_at) : null,
  }));
}

function codexMeters(result) {
  const scopes = Object.values(result?.rateLimitsByLimitId || {});
  if (!scopes.length && result?.rateLimits) scopes.push(result.rateLimits);
  return scopes.filter(Boolean).flatMap(scope => [scope.primary, scope.secondary].filter(row => Number.isFinite(row?.usedPercent)).map(row => ({
    window: row.windowDurationMins === 10080 ? "weekly" : row.windowDurationMins === 300 ? "session" : "",
    minutes: row.windowDurationMins,
    scope: scope.limitName || (scope.limitId !== "codex" ? scope.limitId : "") || "",
    percent: row.usedPercent,
    reset: row.resetsAt > 0 ? row.resetsAt * 1000 : null,
  })));
}

function readUsage(spec, codex) {
  const args = codex ? ["app-server", "--listen", "stdio://"] : [
    "-p", "--no-session-persistence", "--strict-mcp-config", "--settings", '{"disableAllHooks":true}',
    "--tools", "", "--output-format", "stream-json", "--verbose", "--", "/usage",
  ];
  return new Promise(resolve => {
    const child = spawn(spec.bin, args, { env: spec.env, cwd: os.tmpdir(), windowsHide:true, stdio:["pipe", "pipe", "ignore"] });
    const lines = createInterface({ input:child.stdout });
    let meters = [], settled = false;
    const timeout = setTimeout(() => finish([]), 25000);
    function finish(rows) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      lines.close();
      if (child.exitCode === null) child.kill();
      resolve(rows);
    }
    const send = message => child.stdin.write(JSON.stringify(message) + "\n");
    child.stdin.on("error", () => {});
    child.once("error", () => finish([]));
    child.once("close", () => finish(meters));
    lines.on("line", line => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (!event || typeof event !== "object") return;
      if (codex) {
        if (event.id === 1 && event.result) {
          send({ method:"initialized" });
          send({ id:2, method:"account/rateLimits/read" });
        } else if (event.id === 2) finish(codexMeters(event.result));
        else if (event.id === 1 && event.error) finish([]);
      } else {
        if (event.type === "assistant" && event.usage_report) meters = claudeMeters(event.usage_report);
        if (event.type === "result") finish(meters);
      }
    });
    if (codex) send({ id:1, method:"initialize", params:{ clientInfo:{ name:"neutron", title:"Neutron", version:require("./package.json").version } } });
    else child.stdin.end();
  });
}

module.exports = { readUsage, claudeMeters, codexMeters };
