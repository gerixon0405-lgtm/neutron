const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {ScheduleStore,nextOccurrence}=require("../neutron-schedules");
const hybrid=require("../nemotron-hybrid");

const primary={id:"nvidia_nim/nvidia/nemotron-3-ultra-550b-a55b",levels:["low","high"]};
const secondary={id:"nvidia_nim/nvidia/nemotron-3.5-super-vl-120b-a12b",levels:["high","max"]};
const alternative={id:"open_router/nvidia/nemotron-3.5-super-vl:free",levels:["low"]};
const models=[alternative,secondary,primary];
assert.deepEqual(hybrid.levels(models),["high"]);
assert.equal(hybrid.route(models,"Építs egy Minecraft-modot.").row,primary);
assert.equal(hybrid.route(models,"Elemezd ezt a tanulmányt és foglald össze.").row,secondary);
assert.equal(hybrid.route(models,"Please summarize this.").reason,"Szövegelemzés");
assert.equal(hybrid.route(models,"Mi van a képen?").row,secondary);
assert.equal(hybrid.route(models,"Nézd meg",[{name:"fotó.PNG"}]).row,secondary);
assert.equal(hybrid.route(models,"Nézd meg",[],true).row,secondary);
assert.equal(hybrid.route([secondary],"Építs egy oldalt").row,secondary);
assert.throws(()=>hybrid.route([primary],"",[],true),/Super VL/);
assert.deepEqual(hybrid.textHistory([{role:"user",text:"A képről"},{role:"assistant",blocks:[{type:"text",text:"Leírás"}]},
  {role:"user",text:"Hozd létre"},{role:"assistant",blocks:[]}]),[{role:"user",text:"A képről"},{role:"assistant",text:"Leírás"}]);

process.env.TZ="Europe/Budapest";
const local=(d,h=8,m=15)=>new Date(2026,2,d,h,m).getTime();
assert.equal(nextOccurrence(local(27),"daily",local(30,15)),local(31));
assert.equal(nextOccurrence(local(21),"weekly",local(28,8,14)),local(28));
assert.equal(new Date(nextOccurrence(local(28,2,30),"daily",local(29,0),150)).getHours(),3);
assert.equal(new Date(nextOccurrence(local(29,3,30),"daily",local(29,4),150)).getHours(),2);
assert.equal(nextOccurrence(local(27),"once",local(28)),null);

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"neutron-schedule-test-"));
try{
  const file=path.join(tmp,"schedules.json");
  let store=new ScheduleStore(file);
  const start=local(25), tomorrow=local(26);
  const reminder=store.save({kind:"reminder",title:"Számla",text:"",nextAt:tomorrow,repeat:"once"},start);
  const task=store.save({kind:"task",title:"Jelentés",text:"Írj összefoglalót",chatId:"chat-example",nextAt:tomorrow,repeat:"daily"},start);
  assert.equal(store.claim(start,true),null);
  assert.equal(store.claim(tomorrow,false).id,reminder.id);
  assert.equal(store.list().find(x=>x.id===reminder.id).lastStatus,"done");
  const running=store.claim(tomorrow,true);
  assert.equal(running.id,task.id);
  assert.equal(store.claim(tomorrow,true),null);
  assert.equal(store.finish(task.id,"wrong-id","done",tomorrow),null);
  store.finish(task.id,running.runId,"busy",tomorrow);
  assert.equal(store.claim(tomorrow,true),null);
  const retried=store.claim(tomorrow+15000,true);
  store=new ScheduleStore(file);
  assert.equal(store.list().find(x=>x.id===retried.id).lastStatus,"interrupted");
  assert.equal(store.claim(tomorrow,true),null);
  store.retireChat("chat-example");
  assert.equal(store.list().find(x=>x.id===task.id).enabled,false);
  store.remove(reminder.id);
  assert.equal(store.list().length,1);
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
