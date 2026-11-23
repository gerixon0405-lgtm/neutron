"use strict";
function pcm16Wave(samples) {
  const bytes=new Uint8Array(44+samples.length*2);
  const view=new DataView(bytes.buffer);
  const label=(offset,value)=>{for(let i=0;i<value.length;i++)bytes[offset+i]=value.charCodeAt(i);};
  label(0,"RIFF");view.setUint32(4,bytes.length-8,true);label(8,"WAVE");label(12,"fmt ");
  view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
  view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);
  label(36,"data");view.setUint32(40,samples.length*2,true);
  for(let i=0;i<samples.length;i++){
    const sample=Math.min(1,Math.max(-1,samples[i]));
    view.setInt16(44+i*2,Math.round(sample*(sample<0?32768:32767)),true);
  }
  return bytes;
}
if(typeof module!=="undefined")module.exports={pcm16Wave};
