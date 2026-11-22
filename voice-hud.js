window.onVoiceState(message => {
  if (!message) return;
  document.getElementById("phase").textContent=({starting:"Starting",recording:"Listening",working:"Transcribing",thinking:"Thinking",acting:"Working",speaking:"Speaking",permission:"Approval",error:"Error"})[message.state] || "";
  document.body.dataset.state = message.state;
  document.getElementById("name").textContent = message.name;
  document.getElementById("status").textContent = message.text;
  document.getElementById("picture").src = message.avatar?.startsWith("data:image/webp;base64,") ? message.avatar : "icon.png";
});
