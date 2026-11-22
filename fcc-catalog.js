const efforts = ["low", "medium", "high", "xhigh", "max"];

async function listModels(base, request = fetch) {
  async function read(endpoint, field) {
    const response = await request(base + endpoint, {signal: AbortSignal.timeout(5000)});
    if (!response.ok) throw Error("FCC " + response.status);
    const rows = (await response.json())[field];
    if (!Array.isArray(rows)) throw Error("Érvénytelen FCC-modellista.");
    return rows;
  }
  const results = await Promise.allSettled([
    read("/admin/api/models", "models"),
    read("/v1/models?view=responses", "data"),
    read("/v1/models?view=messages", "data"),
  ]);
  if (results.every(r => r.status === "rejected")) throw results[2].reason;
  const models = new Map();
  // Prefer the Messages wire ID when the same provider model has multiple aliases.
  for (const result of results) {
    for (const row of result.value || []) {
      const id = typeof row === "string" ? row : row?.id;
      if (typeof id !== "string" || !id.trim()) continue;
      const ref = row.provider_model_ref || id;
      const previous = models.get(ref);
      const reasoning = row.supportsReasoning ?? row.supports_reasoning;
      const allowed = row.reasoningEfforts ?? row.reasoning_efforts;
      const levels = reasoning === false ? [] : Array.isArray(allowed) ? efforts.filter(v => allowed.includes(v))
        : previous?.levels?.length ? previous.levels : reasoning === true ? efforts : [];
      models.set(ref, {id, levels});
    }
  }
  return [...new Map([...models.values()].map(m => [m.id,m])).values()].sort((a,b) => a.id.localeCompare(b.id));
}

module.exports = {listModels};
