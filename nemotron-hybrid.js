(function (api) {
  if (typeof module !== "undefined") module.exports = api;
  else window.NemotronHybrid = api;
})((() => {
  const id = "neutron:nemotron-hybrid";
  const label = "Nemotron Hybrid";
  const ultra = model => /(?:^|\/)nemotron-3-ultra(?:-|:|$)/i.test(model);
  const visual = model => /(?:^|\/)nemotron-3[._-]5-super-vl(?:-|:|$)/i.test(model);
  const imageFile = file => /\.(?:png|jpe?g|webp|gif)$/i.test(file);
  const normalize = text => String(text || "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  const score = model => /^nvidia[_-]nim\//i.test(model) ? 0 : /:free$/i.test(model) ? 1 : 2;

  function findModels(catalog) {
    const select = match => catalog.filter(row => match(row.id)).sort((a,b) => score(a.id)-score(b.id))[0];
    return {primary:select(ultra),secondary:select(visual)};
  }
  function levels(catalog) {
    const {primary,secondary}=findModels(catalog);
    if(!primary || !secondary)return (primary || secondary)?.levels || [];
    return primary.levels.filter(level=>secondary.levels.includes(level));
  }
  function route(catalog,text,files=[],screen=false) {
    const {primary,secondary}=findModels(catalog);
    const words=normalize(text);
    const image=screen || files.some(file=>imageFile(file.name)) ||
      /\b(?:mi (?:van|latszik) a kepen|mit latsz a kepen|olvasd le a keprol|ocr|whats? (?:in|on) (?:the|this) image)\b/.test(words);
    const analysis=/\b(?:szovegelemz\w*|dokumentumelemz\w*|osszefoglal\w*|osszegezd|kivonat\w*|foglal\w* ossze|osszefoglalot|summari[sz]\w*|extract (?:key|main|the)|text analysis|document analysis|proofread\w*|korrekturaz\w*)\b/.test(words) ||
      /\b(?:elemez\w*|ertekel\w*|hasonlits\w*|analy[sz]\w*|compare)\b.{0,120}\b(?:szoveg\w*|cikk\w*|dokumentum\w*|tanulmany\w*|vers\w*|transcript\w*|article\w*|document\w*|text|essay)\b/.test(words);
    if(image && !secondary)throw Error("A képekhez csatlakoztass egy Nemotron 3.5 Super VL modellt az FCC-ben.");
    const specialized=image || analysis;
    const preferred=specialized ? secondary : primary;
    const row=preferred || primary || secondary;
    if(!row)throw Error("A hibrid profilhoz adj hozzá egy Nemotron 3 Ultra vagy 3.5 Super VL modellt az FCC-ben.");
    return {row,reason:!preferred ? "Elérhető Nemotron" : image ? "Képelemzés" : analysis ? "Szövegelemzés" : "Általános feladat"};
  }
  function textHistory(items) {
    return (items || []).slice(0,-2).slice(-14).flatMap(item=>{
      const text=item.role==="user" ? item.text : (item.blocks || []).filter(b=>b.type==="text").map(b=>b.text).join("\n");
      return text ? [{role:item.role,text:text.slice(0,3500)}] : [];
    });
  }
  return {id,label,ultra,visual,imageFile,findModels,levels,route,textHistory};
})());
