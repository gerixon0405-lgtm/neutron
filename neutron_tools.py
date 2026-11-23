"""Neutron's per-workspace MCP server. stdout is reserved for JSON-RPC."""
import io
import json
import zipfile
from xml.etree import ElementTree
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from html.parser import HTMLParser
from urllib.parse import urlsplit, parse_qs, urljoin

import requests
import modpacks
import mail_outbox
import web_results
import pc_maintenance
import neutron_music
import prism_instances as prism

ROOT = Path(sys.argv[1])
TOOLS = {}


def tool(description, **fields):
    def register(fn):
        props = {}
        for k, descriptor in fields.items():
            if descriptor == list:
                props[k] = {"type":"array", "items":{"type":"string"}}
            elif isinstance(descriptor, tuple):
                props[k] = {"type":"string", "enum":descriptor}
            else:
                props[k] = {"type":"string"}
        import inspect
        req = [p.name for p in inspect.signature(fn).parameters.values() if p.default is inspect.Parameter.empty]
        TOOLS[fn.__name__] = (fn, dict(name=fn.__name__, description=description, inputSchema=dict(
            type="object", properties=props, required=req, additionalProperties=False)))
        return fn
    return register


def artifact(name):
    if not isinstance(name, str) or not name.strip() or name.startswith(".") or re.search(r'[/\\\x00-\x1f]', name) or len(name) > 160:
        raise ValueError("Az artifact neve egyetlen fájlnév legyen.")
    file = ROOT / name
    if ROOT.is_symlink() or file.is_symlink():
        raise ValueError("Szimbolikus hivatkozás nem használható.")
    return file


def write(name, data):
    path = artifact(name)
    if len(data) > 8_000_000:
        raise ValueError("Az artifact mérethatára 8 MB.")
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=ROOT, prefix=".building-", delete=False) as f:
        try:
            f.write(data)
            f.flush()
            f.close()
            os.replace(f.name, path)
        finally:
            Path(f.name).unlink(missing_ok=True)
    return name


TEXT = (".html", ".htm", ".svg", ".md", ".txt", ".json", ".css", ".js", ".py", ".csv")


@tool("Create or update an artifact in the current project or chat. For runnable apps bundle HTML, CSS and JS in one .html. Preview is offline. Supply all content.", name=str, content=str)
def artifact_write(name, content):
    if not name.lower().endswith(TEXT):
        raise ValueError("Válassz HTML-, SVG-, Markdown-, szöveg- vagy forrásfájlt.")
    return write(name, content.encode())


@tool("List shared project artifacts or artifacts in this standalone chat.")
def artifact_list():
    return sorted(p.name for p in ROOT.iterdir() if not p.name.startswith(".") and p.is_file() and not p.is_symlink()) if ROOT.is_dir() and not ROOT.is_symlink() else []


@tool("Read a text artifact before revising it.", name=str)
def artifact_read(name):
    p = artifact(name)
    if p.suffix.lower() not in TEXT or p.stat().st_size > 8_000_000:
        raise ValueError("A fájl nem olvasható szöveges artifactként.")
    return p.read_text()


@tool("Publish the current project's existing dist or build directory as a downloadable ZIP artifact. Run the project's build first. Includes compiled files and their relative paths.", folder=("dist","build"), name=str)
def artifact_publish(folder, name):
    if folder not in ("dist", "build"):
        raise ValueError("A build közzétételéhez dolgozz egy Neutron-projektben.")
    source = Path(sys.argv[2] if len(sys.argv)>2 else os.environ.get("NEUTRON_WORKDIR",os.getcwd())) / folder
    if source.is_symlink() or not source.is_dir():
        raise ValueError("A buildmappa nem található. Előbb futtasd a projekt buildjét.")
    name = name if name.lower().endswith(".zip") else name + ".zip"
    artifact(name)
    output = io.BytesIO()
    count = total = 0
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for root, dirs, files in os.walk(source):
            dirs[:] = [d for d in dirs if not d.startswith(".") and not (Path(root)/d).is_symlink()]
            for f in files:
                path = Path(root)/f
                if f.startswith(".") or path.is_symlink() or not path.is_file():
                    continue
                total += path.stat().st_size
                count += 1
                if total > 48_000_000 or count > 5000:
                    raise ValueError("A build túl nagy a közzétételhez.")
                archive.write(path,path.relative_to(source))
    if not count:
        raise ValueError("Üres a buildmappa.")
    return {"artifact":write(name,output.getvalue()),"files":count}


class Results(HTMLParser):
    def __init__(self):
        super().__init__()
        self.rows = []
        self.field = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        classes = (a.get("class") or "").split()
        if tag == "a" and any(c in classes for c in ("result-link", "result__a")):
            url = urljoin("https://duckduckgo.com/", a.get("href") or "")
            parsed = urlsplit(url)
            if parsed.hostname in ("duckduckgo.com", "www.duckduckgo.com") and parsed.path.startswith("/l/"):
                url = parse_qs(parsed.query).get("uddg", [""])[0]
            self.field = None
            if urlsplit(url).scheme in ("http", "https"):
                self.rows.append({"title":"", "url":url, "snippet":""})
                self.field = ("title", tag)
        elif self.rows and any(c in classes for c in ("result-snippet", "result__snippet")):
            self.field = ("snippet", tag)

    def handle_endtag(self, tag):
        if self.field and self.field[1] == tag:
            self.field = None

    def handle_data(self, data):
        if self.field:
            self.rows[-1][self.field[0]] += data


@tool("Search the web. If a page refuses fetch or robots.txt returns 403, repeat the topic search with excluded_host set to the blocked hostname to find independent sources. Snippets are not full page content.", query=str, excluded_host=str)
def ddg_search(query, excluded_host=""):
    q = web_results.query_text(query)
    host = excluded_host.strip().lower().rstrip(".")
    if host and not re.fullmatch(r"(?:[a-z0-9-]+\.)+[a-z0-9-]+",host):
        raise ValueError("A kizáráshoz csak a webhely nevét add meg.")
    keywords = q + (" -site:"+host if host else "")
    responded = False
    def accepted(rows):
        found = {}
        for row in rows:
            url = row["url"]
            try:
                parts = urlsplit(url)
                domain = (parts.hostname or "").lower().rstrip(".")
            except ValueError:
                continue
            if not domain or parts.scheme not in ("http","https") or (host and (domain == host or domain.endswith("."+host))):
                continue
            if row["title"].strip():
                found.setdefault(url,{k:v.strip() for k,v in row.items()})
        return list(found.values())[:10]

    for url,terms in (("https://lite.duckduckgo.com/lite/",q), ("https://html.duckduckgo.com/html/",keywords)):
        try:
            r = requests.get(url, params={"q":terms}, headers=web_results.HEADERS, timeout=6)
            r.raise_for_status()
            parser = Results()
            parser.feed(r.text)
            rows = accepted(parser.rows)
            if rows:
                return rows
            responded |= bool(parser.rows) or "no results" in r.text.lower()
        except requests.RequestException:
            continue
    try:
        r = requests.get("https://www.bing.com/search",params={"q":q,"format":"rss"},headers=web_results.HEADERS,timeout=6)
        r.raise_for_status()
        channel = ElementTree.fromstring(r.content).find("channel")
        if channel is not None:
            rows = accepted([{"title":item.findtext("title") or "","url":item.findtext("link") or "",
                              "snippet":item.findtext("description") or ""} for item in channel.findall("item")])
            responded = True
            if rows: return rows
    except (requests.RequestException,ElementTree.ParseError):
        pass
    # The encyclopedia index is independent of both DDG endpoints.
    for language in ("hu","en"):
        try:
            r = requests.get(f"https://{language}.wikipedia.org/w/api.php", params={
                "action":"query","generator":"search","gsrsearch":q,"gsrlimit":8,"format":"json",
                "prop":"info|extracts","inprop":"url","exintro":1,"explaintext":1,"exsentences":2},
                headers=web_results.HEADERS,timeout=6)
            r.raise_for_status()
            data = r.json()
            if "error" in data: continue
            pages = sorted(data.get("query",{}).get("pages",{}).values(),key=lambda p:p.get("index",0))
            rows = accepted([{"title":p["title"],"url":p["fullurl"],"snippet":p.get("extract","")[:500]}
                              for p in pages if p.get("fullurl")])
            responded = True
            if rows: return rows
        except (requests.RequestException,ValueError):
            continue
    if responded: return []
    raise ValueError("A keresőforrások jelenleg nem érhetők el.")


@tool("Inspect Windows device driver names, providers, versions and signatures (list), or device error codes (problems). Filter using query and continue with next_offset. For requested updates open Windows Update (updates). For an explicitly requested local driver installation, install lets the user pick the specific INF package and approve Windows elevation. Afterward recheck devices and versions; processing a package does not guarantee it replaced the active driver.", action=("list","problems","updates","install"), query=str, offset=str)
def windows_drivers(action,query="",offset="0"):
    return pc_maintenance.drivers(action,query,offset)


@tool("Measure actual Windows CPU, memory and disk metrics (inspect). For an explicit optimization request call optimize to start Windows' built-in drive optimization task; Windows may ask for permission. Use status to inspect its actual state and last run. A start request alone does not mean completion or improved speed.", action=("inspect","optimize","status"))
def windows_maintenance(action):
    return pc_maintenance.maintain(action)


@tool("Search for Minecraft mod projects specifically on CurseForge. Returns real CurseForge project links. With web-index search, verify exact game and loader compatibility on the linked project before installation.", query=str, game_version=str, loader=str)
def curseforge_search(query, game_version="", loader=""):
    return web_results.curseforge(query,game_version,loader,ddg_search)


@tool("Find products and live listed Hungarian prices with photos and source links. Neutron displays the returned offers as shopping cards. Report only the listed price, distinguish shipping, and never invent missing offers.", query=str)
def product_search(query):
    return {"products":web_results.products(query)}


@tool("Search Wikimedia Commons for real photographs and illustrations. Neutron displays thumbnail cards with original file pages and attribution links.", query=str)
def image_search(query):
    return {"images":web_results.images(query)}


@tool("Attach a completed deliverable from this chat's working directory. Use a relative, non-hidden path and call this after writing a requested file with other tools. For a built website use artifact_publish.", file=str)
def attach_file(file):
    base = Path(os.environ.get("NEUTRON_WORKDIR",os.getcwd())).resolve()
    rel = Path(file)
    if rel.is_absolute() or not rel.parts or any(p.startswith(".") for p in rel.parts):
        raise ValueError("Adj meg egy látható, munkamappán belüli relatív fájlnevet.")
    source = (base/rel).resolve(strict=True)
    if source != base/rel or not source.is_file() or source.stat().st_size > 8_000_000:
        raise ValueError("A fájl nem csatolható vagy meghaladja a 8 MB-os mérethatárt.")
    return {"artifact":write(source.name,source.read_bytes())}


@tool("Find real Modrinth mods by keyword, optionally filtered by Minecraft version and loader.", query=str, game_version=str, loader=str)
def mod_search(query, game_version="", loader=""):
    return modpacks.search(query, game_version, loader)


@tool("Build an importable Prism Launcher .mrpack from Modrinth slugs. Resolves required mods, checks game/loader compatibility and includes checksums. Omit loader_version for the recommended Prism release.", name=str, mods=list, game_version=str, loader=("fabric","quilt","forge","neoforge"), loader_version=str)
def prism_build(name, mods, game_version, loader, loader_version=""):
    filename = name if name.endswith(".mrpack") else name + ".mrpack"
    artifact(filename)
    data, count = modpacks.build(name.removesuffix(".mrpack"), mods, game_version, loader, loader_version)
    return {"artifact":write(filename, data), "mods":count}


@tool("Open a built .mrpack in Prism Launcher's import dialog when the user asks to install/import it.", name=str)
def prism_import(name):
    path = artifact(name)
    if not path.is_file() or path.suffix != ".mrpack":
        raise ValueError("A kiválasztott modpack nem található.")
    exe = prism.launcher()
    args = [exe, "--import", str(path)] if exe else ["flatpak","run","--file-forwarding","org.prismlauncher.PrismLauncher","--import","@@",str(path),"@@"]
    proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        if proc.wait(timeout=.7):
            raise ValueError("A Prism Launcher nem indult el.")
    except subprocess.TimeoutExpired:
        pass
    return "Átadva a Prism Launchernek importálásra."


@tool("List local Prism Launcher instances, their exact folder IDs, Minecraft, mod loader and running state.")
def prism_instances():
    return prism.list_instances()


@tool("Create a real installed Prism instance, directly in its instance directory. Choose a Minecraft version and optionally a compatible loader.", name=str, game_version=str, loader=("vanilla","fabric","quilt","forge","neoforge"), loader_version=str)
def prism_create(name, game_version, loader="vanilla", loader_version=""):
    return prism.create(name, game_version, loader, loader_version)


@tool("Edit an existing stopped instance. rename changes the display name (ID stays), memory sets max MiB, loader sets or updates the mod loader. java takes auto or a runtime ID listed by runtimes. Originals are backed up.", instance=str, action=("rename","memory","loader","java","runtimes"), value=str, loader_version=str)
def prism_edit(instance, action, value="", loader_version=""):
    if action == "runtimes":
        return prism.runtimes()
    return prism.edit(prism.instance(instance),action,value,loader_version)


@tool("Inspect, search for or install compatible mods directly into an existing Prism instance. search takes query; versions takes a project slug in query and lists compatible releases and IDs; install takes mods (project slug or slug@ModrinthVersionID to pin a specific release, resolves dependencies); enable/disable take the exact jar filename in file. Disable is reversible. Install an update by providing the slug again.", instance=str, action=("list","search","versions","install","enable","disable"), query=str, mods=list, file=str)
def prism_mods(instance, action, query="", mods=None, file=""):
    p = prism.instance(instance)
    if action == "list":
        return prism.inspect_mods(p)
    if action == "search":
        info = prism.versions(p)
        return modpacks.search(query,info["minecraft"],info["loader"] if info["loader"] != "vanilla" else "")
    if action == "versions":
        info = prism.versions(p)
        rows = modpacks.get("/project/"+modpacks.ident(query)+"/version",loaders=json.dumps([info["loader"]]),game_versions=json.dumps([info["minecraft"]]))
        return [{"id":v["id"],"version":v["version_number"],"type":v["version_type"]} for v in rows]
    if action == "install":
        return prism.install(p,mods)
    if action in ("enable","disable"):
        return prism.toggle(p,file,action=="enable")
    raise ValueError("Ismeretlen modművelet.")


@tool("Launch and verify this specific Prism instance; status checks its actual Java process, fresh logs and crashes. wait samples startup for up to 15s; repeat while starting. diagnose returns crash/error evidence and possible repairs; history includes old reports. For a repair use prism_mods or prism_edit, then relaunch and compare fresh evidence. Never equate starting a process with an error-free game.", instance=str, action=("launch","status","wait","diagnose","history"))
def prism_run(instance, action):
    return prism.run(prism.instance(instance),action)


@tool("Control the user's installed Spotify desktop app. launch starts it. play_song searches and plays by name; play resumes; open takes a Spotify URI. play_playlist/create_playlist/add_to_playlist take a playlist name in value. For add_to_playlist put the song name in track, or omit for the current song. list_playlists returns names and links with the Spotify connection. remove_from_playlist takes a playlist name or link in value and song name or link in track. rename_playlist takes a playlist in value and the new name in track. delete_playlist removes a playlist from the current account library, only when explicitly requested. queue and like take a song name or the current track. volume is 0–100, seek is absolute seconds, repeat None/Track/Playlist, shuffle on/off.", action=tuple(neutron_music.LOCAL), value=str, track=str)
def spotify_player(action, value="", track=""):
    return neutron_music.local(action, value, track)


@tool("Queue Gmail delivery only on an explicit user instruction to send, to the email addresses the user specifies. Do not send a draft or infer an address from a name. Each recipient gets a private copy. Queueing is not confirmation of sending. Use gmail_delivery_status with the returned ID to check acceptance. For different subjects or bodies use separate calls.", recipients=list, subject=str, body=str)
def gmail_send(recipients, subject, body):
    turn = os.environ.get("NEUTRON_MAIL_TURN")
    if not turn or not Path(turn).is_file():
        raise ValueError("A Gmail-küldéshez nyiss Neutron-chatet.")
    return mail_outbox.enqueue(recipients,subject,body,Path(turn).read_text().strip())


@tool("Get connected sender and recent Gmail batches, or per-recipient delivery counts and errors for a batch ID. sent means Gmail accepted the message; pending/sending means still in progress; unknown must be checked in Gmail before resending.", batch=str)
def gmail_delivery_status(batch=""):
    return mail_outbox.status(batch,True)


def dispatch(req):
    method = req.get("method")
    if method == "initialize":
        supported = ("2024-11-05","2025-03-26","2025-06-18","2025-11-25")
        version = req.get("params", {}).get("protocolVersion")
        return dict(protocolVersion=version if version in supported else supported[-1], capabilities={"tools":{}}, serverInfo={"name":"neutron", "version":"1.0"})
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools":[d for fn,d in TOOLS.values()]}
    if method == "tools/call":
        params = req["params"]
        if params.get("name") not in TOOLS:
            raise ValueError("Ismeretlen eszköz.")
        try:
            result = TOOLS[params["name"]][0](**params.get("arguments", {}))
            return {"content":[{"type":"text","text":json.dumps(result, ensure_ascii=False) if not isinstance(result,str) else result}]}
        except Exception as exc:
            return {"isError":True, "content":[{"type":"text","text":str(exc)}]}
    raise KeyError(method)


def collect_outputs(request):
    base = Path(os.environ["NEUTRON_WORKDIR"]).resolve()
    started = request["started"]/1000 - 0.01
    attached = set(request.get("existing",[]))
    added = []
    candidates = request.get("paths",[])[:32]
    for name in candidates:
        f = Path(name)
        f = f if f.is_absolute() else base/f
        if not f.is_relative_to(base) or not f.is_file() or f.name in attached:
            continue
        rel = f.relative_to(base)
        if any(p.startswith(".") or p in ("node_modules","target","__pycache__","dist","build") for p in rel.parts):
            continue
        if f.suffix.lower() not in (".html",".htm",".css",".js",".jsx",".ts",".tsx",".svg",".py",".txt",".md",".json",".csv",".png",".jpg",".jpeg",".webp",".pdf",".docx",".xlsx",".pptx",".zip",".jar",".mrpack",".wav",".mp3",".gif"):
            continue
        if f.stat().st_mtime < started or f.stat().st_size>8_000_000:
            continue
        if f.resolve()!=f or (ROOT/f.name).resolve()==f.resolve():
            continue
        name = attach_file(str(rel))["artifact"]
        added.append(name)
        attached.add(name)
    if request.get("build") and not any(n.endswith(".zip") for n in attached):
        for folder in ("dist","build"):
            index=base/folder/"index.html"
            if index.is_file() and index.stat().st_mtime >= started and index.resolve()==index:
                added.append(artifact_publish(folder,base.name+"-app.zip")["artifact"])
                break
    return added


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[3] == "--collect":
        print(json.dumps(collect_outputs(json.load(sys.stdin))))
        sys.exit(0)
    if len(sys.argv) == 4 and sys.argv[2] == "--import":
        try:
            print(prism_import(sys.argv[3]))
        except Exception as error:
            sys.exit(str(error))
        sys.exit(0)
    for line in sys.stdin:
        req = {}
        try:
            req = json.loads(line)
            if "id" not in req:
                continue
            response = {"result":dispatch(req)}
        except Exception as e:
            response = {"error":{"code":-32601 if isinstance(e, KeyError) else -32602, "message":str(e)}}
        print(json.dumps({"jsonrpc":"2.0","id":req.get("id"), **response}), flush=True)
