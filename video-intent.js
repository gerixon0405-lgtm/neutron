"use strict";
function wantsVideoEditor(text){
  const value=text.normalize("NFD").replace(/\p{M}/gu,"").toLowerCase().trim();
  return /^\/(?:video|vagas)(?:\s|$)/.test(value) ||
    /^(?:kerlek[, ]+)?(?:vagd meg|vagj meg|vagj|szerkeszd meg|szerkessz|nyisd meg)\b.{0,160}\b(?:video\w*|felvetel\w*|editor[ -]?v1)\b/.test(value) ||
    /^(?:kerlek[, ]+)?editor[ -]?v1(?:\s|$)/.test(value);
}
if(typeof module!=="undefined")module.exports={wantsVideoEditor};
