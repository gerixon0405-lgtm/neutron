const fs=require("node:fs");
const path=require("node:path");
const {app,ipcMain,safeStorage}=require("electron");
const voices=new Set(["hu-HU-NoemiNeural","hu-HU-TamasNeural"]);
let saved;
const location=()=>path.join(app.getPath("userData"),"speech.key");
function config(){
  if(saved!==undefined)return saved;
  try { saved=JSON.parse(safeStorage.decryptString(fs.readFileSync(location()))); }
  catch { saved=null; }
  return saved;
}
function credentialsAvailable(){
  return safeStorage.isEncryptionAvailable() &&
    !(process.platform==="linux" && safeStorage.getSelectedStorageBackend()==="basic_text");
}
function escapeXml(text){
  return text.replace(/[<>&"']/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;","'":"&apos;"}[c]));
}
async function call(settings, endpoint, headers, body, signal) {
  const response=await fetch("https://"+settings.resource+".cognitiveservices.azure.com"+endpoint,{
    method:"POST",headers:{"Ocp-Apim-Subscription-Key":settings.key,...headers},body,
    redirect:"error",signal:signal?AbortSignal.any([signal,AbortSignal.timeout(45000)]):AbortSignal.timeout(45000),
  });
  if(!response.ok)throw Error("Az Azure Speech elutasította a kérést (HTTP "+response.status+").");
  return response;
}
async function transcribe(wav){
  const settings=config();
  if(!settings)return null;
  const response=await call(settings,"/stt/speech/recognition/conversation/cognitiveservices/v1?language=hu-HU&format=simple",
    {"Content-Type":"audio/wav; codecs=audio/pcm; samplerate=16000"},wav);
  const result=await response.json();
  if(result.RecognitionStatus!=="Success" || !result.DisplayText?.trim())throw Error("A felvételben nem sikerült magyar beszédet felismerni.");
  return result.DisplayText.trim();
}
async function speak(text, signal){
  const settings=config();
  if(!settings)return null;
  const ssml=`<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="hu-HU"><voice name="${settings.voice}"><prosody rate="-4%">${escapeXml(text)}</prosody></voice></speak>`;
  const response=await call(settings,"/tts/cognitiveservices/v1",{
    "Content-Type":"application/ssml+xml","X-Microsoft-OutputFormat":"riff-24khz-16bit-mono-pcm"
  },ssml,signal);
  return new Uint8Array(await response.arrayBuffer());
}
function register(){
  ipcMain.handle("speech:settings",()=>{
    const settings=config();
    return {resource:settings?.resource || "",voice:settings?.voice || "hu-HU-NoemiNeural",connected:!!settings,
      canStore:credentialsAvailable()};
  });
  ipcMain.handle("speech:connect",(_,values)=>{
    const resource=String(values.resource||"").trim().toLowerCase();
    const previous=config();
    const key=String(values.key||"").trim() || (previous?.resource===resource?previous.key:"");
    const voice=values.voice;
    if(!credentialsAvailable())throw Error("A kulcs titkosításához a rendszer kulcstartója szükséges.");
    if(!/^[a-z0-9][a-z0-9-]{0,62}$/.test(resource) || !/^[a-z0-9]{16,128}$/i.test(key) || !voices.has(voice))
      throw Error("Adj meg érvényes Azure Speech-erőforrásnevet, kulcsot és hangot.");
    const next={resource,key,voice};
    const file=location(), temp=file+".tmp";
    fs.writeFileSync(temp,safeStorage.encryptString(JSON.stringify(next)),{mode:0o600});
    fs.renameSync(temp,file);
    saved=next;
    return true;
  });
  ipcMain.handle("speech:disconnect",()=>{
    fs.rmSync(location(),{force:true});
    saved=null;
  });
}
module.exports={register,transcribe,speak,config};
