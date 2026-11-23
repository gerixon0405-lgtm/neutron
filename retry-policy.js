"use strict";
const RATE_RETRY_DELAY = 60_000;
const RATE_RETRY_LIMIT = 10;

function isRateLimit(value) {
  const text=typeof value==="string"?value:JSON.stringify(value ?? "");
  return /\btoo many requests\b|\brate[ _-]limit(?:ed|[ _-]error|[ _-]exceeded)\b|(?:\bhttp(?: status)?|\bstatus(?:_code)?|\bapi error)\W{0,7}429\b|(?:^|\n)\s*(?:error[: ]+)?429\b/i.test(text);
}

function rateRetryDecision(failures, effects) {
  if(effects)return "effects";
  return failures>=RATE_RETRY_LIMIT?"limit":"wait";
}
if(typeof module!=="undefined")module.exports={isRateLimit,rateRetryDecision,RATE_RETRY_DELAY};
