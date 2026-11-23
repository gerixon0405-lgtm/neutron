const assert = require("node:assert/strict");
const { claudeMeters, codexMeters } = require("../account-usage");

const reset = Date.parse("2026-11-24T12:00:00Z");
assert.deepEqual(claudeMeters({rate_limits:{limits:[
  {kind:"session",percent:24,resets_at:"2026-11-24T12:00:00Z"},
  {kind:"weekly_scoped",group:"weekly",percent:91,scope:{model:{display_name:"Sonnet"}}},
  {kind:"weekly_all",percent:2,is_active:false},
  {kind:"weekly_all",percent:null},
]}}), [
  {window:"session",scope:"",percent:24,reset},
  {window:"weekly",scope:"Sonnet",percent:91,reset:null},
  {window:"weekly",scope:"",percent:2,reset:null},
]);
assert.deepEqual(claudeMeters({rate_limits:null}), []);

const base = {limitId:"codex",primary:{usedPercent:0,windowDurationMins:300,resetsAt:reset / 1000},
  secondary:{usedPercent:49,windowDurationMins:10080}};
const meters = [
  {window:"session",minutes:300,scope:"",percent:0,reset},
  {window:"weekly",minutes:10080,scope:"",percent:49,reset:null},
];
assert.deepEqual(codexMeters({rateLimits:base}), meters);
assert.deepEqual(codexMeters({rateLimits:base,rateLimitsByLimitId:{codex:base,review:{
  limitId:"review",limitName:"Code Review",primary:{usedPercent:100,windowDurationMins:10080},
}}}), [...meters, {window:"weekly",minutes:10080,scope:"Code Review",percent:100,reset:null}]);
assert.deepEqual(codexMeters({}), []);
