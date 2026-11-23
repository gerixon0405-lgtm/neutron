const fs = require("node:fs");
const { randomUUID } = require("node:crypto");

function nextOccurrence(at, repeat, now, clock) {
  if (repeat==="once") return null;
  const interval=repeat==="weekly"?7:1;
  const next=new Date(at), current=new Date(now);
  clock ??= next.getHours()*60+next.getMinutes();
  const day = date => Date.UTC(date.getFullYear(),date.getMonth(),date.getDate())/86400000;
  const steps=Math.max(1,Math.floor((day(current)-day(next))/interval));
  next.setDate(next.getDate()+steps*interval);
  next.setHours(Math.floor(clock/60),clock%60,0,0);
  if(next.getTime()<=now){
    next.setDate(next.getDate()+interval);
    next.setHours(Math.floor(clock/60),clock%60,0,0);
  }
  return next.getTime();
}

class ScheduleStore {
  constructor(filename, bootId="") {
    this.filename=filename;
    this.bootId=bootId;
    this.rows=[];
    this.deferred=new Map();
    try {
      this.rows=JSON.parse(fs.readFileSync(filename,"utf8"));
      if(!Array.isArray(this.rows))throw Error("Az ütemezések fájlja érvénytelen.");
    } catch(error) {
      if(error.code!=="ENOENT")throw error;
    }
    const now=Date.now();
    this.commit(this.rows.map(row=>row.runId?this.closed(row,"interrupted",now):row));
  }
  list() { return this.rows.map(row=>({...row})); }
  commit(rows) {
    if(rows.length===this.rows.length && rows.every((row,index)=>row===this.rows[index]))return;
    const temp=this.filename+"."+randomUUID()+".tmp";
    try {
      fs.writeFileSync(temp,JSON.stringify(rows,null,2),{mode:0o600,flag:"wx"});
      fs.renameSync(temp,this.filename);
      this.rows=rows;
    }finally{fs.rmSync(temp,{force:true});}
  }
  replace(row) { this.commit(this.rows.map(old=>old.id===row.id?row:old)); }
  closed(row,status,now) {
    if(row.repeat==="startup")return {...row,startupSeen:row.runBootId || this.bootId,runId:null,runBootId:null,lastAt:now,lastStatus:status};
    const nextAt=nextOccurrence(row.nextAt,row.repeat,now,row.clock);
    return {...row,nextAt,enabled:nextAt!==null && row.enabled,runId:null,lastAt:now,lastStatus:status};
  }
  save(input,now=Date.now()) {
    const title=String(input.title || "").trim(), text=String(input.text || "").trim();
    const startup=input.repeat==="startup";
    if(!["reminder","task"].includes(input.kind) || !["once","daily","weekly","startup"].includes(input.repeat) ||
      !title || title.length>100 || text.length>12000 || (input.kind==="task" && !text) ||
      (input.kind==="task" && !/^chat-[a-z0-9-]{1,100}$/i.test(input.chatId || "")))
      throw Error("Adj meg egy nevet és a feladathoz tartozó csevegést.");
    if(startup && !this.bootId)throw Error("A rendszerindítás időpontja most nem érhető el.");
    if(!startup && (!Number.isFinite(input.nextAt) || input.nextAt<=now || input.nextAt>8640000000000000))
      throw Error("Adj meg jövőbeli időpontot.");
    const old=this.rows.find(row=>row.id===input.id);
    if(input.id && !old)throw Error("Az ütemezés már nem található.");
    if(old?.runId)throw Error("A futó feladat az eredmény megérkezése után szerkeszthető.");
    if(!old && this.rows.length>=200)throw Error("Legfeljebb 200 ütemezés menthető.");
    const time=new Date(input.nextAt);
    const row={id:old?.id || randomUUID(),kind:input.kind,title,text,repeat:input.repeat,
      clock:startup?null:time.getHours()*60+time.getMinutes(),startupSeen:startup?this.bootId:undefined,
      chatId:input.kind==="task"?input.chatId:"",nextAt:startup?null:input.nextAt,
      enabled:old && (old.repeat==="startup" || old.nextAt!=null) ? old.enabled : true,
      lastAt:old?.lastAt || null,lastStatus:old?.lastStatus || ""};
    this.deferred.delete(row.id);
    if(old)this.replace(row);else this.commit([...this.rows,row]);
    return {...row};
  }
  toggle(id) {
    const row=this.rows.find(item=>item.id===id);
    if(!row || row.runId || (row.nextAt===null && row.repeat!=="startup"))return;
    const startupSeen=row.repeat==="startup" && !row.enabled ? this.bootId : row.startupSeen;
    this.replace({...row,enabled:!row.enabled,startupSeen});
  }
  remove(id) {
    this.commit(this.rows.filter(row=>row.id!==id || row.runId));
    this.deferred.delete(id);
  }
  retireChat(chatId,now=Date.now()) {
    this.commit(this.rows.map(row=>row.chatId===chatId ? {...row,enabled:false,runId:null,runBootId:null,lastStatus:"missing",lastAt:now} : row));
  }
  claim(now=Date.now(), canRun=false) {
    const due=this.rows.filter(row => row.enabled && !row.runId && (row.repeat==="startup" ?
      this.bootId && row.startupSeen!==this.bootId : row.nextAt!=null && row.nextAt<=now))
      .sort((a,b)=>(a.nextAt ?? now)-(b.nextAt ?? now));
    const taskBusy=this.rows.some(row=>row.runId);
    const row=due.find(item=>item.kind==="reminder" || (canRun && !taskBusy && (this.deferred.get(item.id)||0)<=now));
    if(!row)return null;
    if(row.kind==="reminder"){
      this.replace(this.closed(row,"done",now));
      return {...row};
    }
    // Persist the claim before dispatch so a crash cannot rerun an interrupted task.
    const running={...row,runId:randomUUID(),runBootId:row.repeat==="startup"?this.bootId:undefined};
    this.replace(running);
    return running;
  }
  finish(id,runId,status,now=Date.now()) {
    const row=this.rows.find(item=>item.id===id && item.runId===runId);
    if(!row)return null;
    if(status==="busy"){
      this.deferred.set(id,now+15000);
      this.replace({...row,runId:null,runBootId:null});
    }else if(status==="missing"){
      this.replace({...row,enabled:false,runId:null,runBootId:null,lastStatus:status,lastAt:now});
    }else{
      this.deferred.delete(id);
      this.replace(this.closed(row,status,now));
    }
    return {...row};
  }
}
module.exports={ScheduleStore,nextOccurrence};
