const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const win=process.argv[2]==="win";
const dir=path.join(__dirname,"../dist");
const file=fs.readdirSync(dir).find(name=>name.endsWith(win?".exe":".AppImage"));
const metadata=fs.readFileSync(path.join(dir,win?"latest.yml":"latest-linux.yml"),"utf8");
const digest=crypto.createHash("sha512").update(fs.readFileSync(path.join(dir,file))).digest("base64");
if(!metadata.includes(file)||!metadata.includes(digest)) throw Error("Installer does not match update manifest");
const feed=fs.readFileSync(path.join(dir,win?"win-unpacked":"linux-unpacked","resources/app-update.yml"),"utf8");
if(!feed.includes("gerixon0405-lgtm")||!feed.includes("repo: neutron")) throw Error("Unexpected update feed");
