const {version} = require("../package.json");
const entry = require("../releases.json").find(note=>note.version===version);
if (!entry?.title || !entry?.changes?.length) throw Error("Missing release notes for "+version);
process.stdout.write("## "+entry.title+"\n\n"+entry.changes.map(change=>"- "+change).join("\n")+"\n");
