(function (api) {
  if(typeof module==="undefined")window.ClaudeSessionPolicy=api;
  else module.exports=api;
})((()=>{
  const turnLimit=12;
  const enabled=(provider,setting)=>!!provider && !["fcc","codex"].includes(provider) && setting!==false;
  const effort=(requested,economy)=>requested || (economy?"low":"");
  function quota(info, text="", now=Date.now()){
    const stamp=Number(info?.resetsAt);
    const reset=stamp>1e12?stamp:stamp*1000;
    if(info?.status==="rejected" && (info.errorCode==="credits_required" || reset>now+60000))
      return {reset:Number.isFinite(reset)&&reset>now?reset:null};
    if(/(?:usage|weekly|session|five.hour|5.hour)[ -]limit[^\n]{0,200}resets?|(?:hit|reached|used up)[^\n]{0,80}(?:usage|weekly|session|five.hour|5.hour)[ -]limit|\b(?:rate limited|hit your limit)\s*[·.–-]\s*resets?/i.test(text))
      return {reset:null};
    return null;
  }
  function accounted(usage){
    return Number(usage?.input_tokens || 0)+Number(usage?.cache_creation_input_tokens || 0)+
      Number(usage?.cache_read_input_tokens || 0)+Number(usage?.output_tokens || 0)>0;
  }
  function tokenLabel(usage){
    if(!usage)return "";
    const input=usage.input_tokens || 0, written=usage.cache_creation_input_tokens || 0;
    const read=usage.cache_read_input_tokens || 0, output=usage.output_tokens || 0;
    const counts=[`${input} új be`,written?`${written} cache-írás`:"",read?`${read} cache-találat`:"",`${output} ki token`];
    return counts.filter(Boolean).join(" / ");
  }
  return {turnLimit,enabled,effort,quota,accounted,tokenLabel};
})());
