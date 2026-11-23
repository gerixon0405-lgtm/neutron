if (process.argv.includes("--neutron-voice-overlay")) require("./voice-overlay");
else {
  const {app}=require("electron");
  if(app.requestSingleInstanceLock())require("./main");
  else app.quit();
}
