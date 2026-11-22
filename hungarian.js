// Only fix reversible UTF-8/Latin-1 mixups in prose. Preserve code and URLs verbatim.
const repairHungarian = (() => {
  const wrong = new Map(), bytes = new TextEncoder(), win = new TextDecoder("windows-1252");
  for (const letter of "áéíóöőúüűÁÉÍÓÖŐÚÜŰ") {
    const encoded = bytes.encode(letter);
    wrong.set(win.decode(encoded),letter);
    wrong.set(String.fromCharCode(...encoded),letter);
  }
  const pattern = new RegExp([...wrong.keys()].join("|"),"g");
  return text => text.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*(?:`|$)|https?:\/\/[^\s<>]+)/g)
    .map((piece,i) => i%2 ? piece : piece.replace(pattern,s=>wrong.get(s)).normalize("NFC")).join("");
})();
if(typeof module!=="undefined") module.exports=repairHungarian;
