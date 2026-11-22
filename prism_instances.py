"""Prism desktop instance management. World saves and account data are outside the editable surface."""
import contextlib
import csv
from desktop_lock import file_lock
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import tomllib
import zipfile

import requests
import modpacks

UID = {"fabric":"net.fabricmc.fabric-loader","quilt":"org.quiltmc.quilt-loader",
       "forge":"net.minecraftforge","neoforge":"net.neoforged"}


def data_root():
    if os.name=="nt":
        return Path(os.environ["APPDATA"])/"PrismLauncher"
    dirs = [Path.home()/".var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher",
            Path(os.environ.get("XDG_DATA_HOME", Path.home()/".local/share"))/"PrismLauncher"]
    return next((d for d in dirs if (d/"prismlauncher.cfg").is_file()), dirs[0])


def setting(text, key, default=""):
    match = re.search("^" + re.escape(key) + "=(.*)$",text,re.M)
    return match[1].strip() if match else default


def roots():
    base = data_root()
    if not base.is_dir():
        raise ValueError("A Prism adatkönyvtára nem található. Indítsd el egyszer a launchert.")
    cfg = base/"prismlauncher.cfg"
    text = cfg.read_text(errors="replace") if cfg.exists() else ""
    paths = [setting(text,"InstanceDir","instances")]
    extra = setting(text,"AdditionalInstanceDirs")
    if extra:
        paths.extend(next(csv.reader([extra],skipinitialspace=True)))
    return list(dict.fromkeys((base/x).resolve() for x in paths if x))


def child(parent, name):
    if not name or name in (".","..") or Path(name).name != name or "\\" in name or any(ord(c)<32 for c in name):
        raise ValueError("Érvénytelen fájl- vagy példánynév.")
    p = parent/name
    if p.is_symlink():
        raise ValueError("Szimbolikus hivatkozás ezen a helyen nem módosítható.")
    return p


def instance(name):
    if not name.startswith("."):
        for root in roots():
            p = child(root,name)
            if child(p,"instance.cfg").is_file():
                return p
    raise ValueError("A Prism-példány nem található.")


def game(p):
    return child(p, ".minecraft" if (p/".minecraft").is_dir() else "minecraft")


def components(p):
    return json.loads(child(p,"mmc-pack.json").read_text())


def versions(p):
    rows = components(p)["components"]
    ids = {r["uid"]:r.get("version") or r.get("cachedVersion","") for r in rows}
    loader = next((k for k,v in UID.items() if v in ids),"vanilla")
    return {"minecraft":ids.get("net.minecraft",""),"loader":loader,"loader_version":ids.get(UID.get(loader),"")}


def processes():
    found = {}
    if os.name=="nt":
        import psutil
        for proc in psutil.process_iter(["name"]):
            try:
                if (proc.info["name"] or "").lower() in ("java.exe","javaw.exe"):
                    found.setdefault(Path(proc.cwd()),[]).append(proc.pid)
            except (psutil.Error,OSError):
                pass
        return found
    for proc in Path("/proc").glob("[0-9]*"):
        try:
            if proc.stat().st_uid != os.getuid() or (proc/"comm").read_text().strip() not in ("java","javaw"):
                continue
            cwd = (proc/"cwd").readlink()
            found.setdefault(cwd,[]).append(int(proc.name))
        except OSError:
            continue
    return found


def list_instances():
    procs = processes()
    out = []
    by_id = {}
    for root in roots():
        if root.is_dir():
            for p in root.iterdir():
                if (p/"instance.cfg").is_file():
                    by_id.setdefault(p.name,p)
    for p in sorted(by_id.values(),key=lambda f:f.name.casefold()):
        if p.name.startswith(".") or p.is_symlink() or not (p/"instance.cfg").is_file():
            continue
        try:
            out.append(dict(id=p.name, name=setting(child(p,"instance.cfg").read_text(),"name",p.name),
                            running=bool(procs.get(game(p))), **versions(p)))
        except (OSError,ValueError,KeyError) as e:
            out.append({"id":p.name,"error":str(e)})
    return out


@contextlib.contextmanager
def lock(p):
    with file_lock(p/".neutron.lock"):
        yield


def atomic(path, text):
    with tempfile.NamedTemporaryFile(mode="w",dir=path.parent,prefix=".neutron-",delete=False) as f:
        try:
            f.write(text)
            f.flush()
            f.close()
            os.replace(f.name,path)
        finally:
            Path(f.name).unlink(missing_ok=True)


def validate_title(name):
    if not (name.strip() == name and 0 < len(name) <= 100) or any(ord(c)<32 for c in name):
        raise ValueError("Adj meg egy legfeljebb 100 karakteres, egysoros nevet.")


def configure_loader(doc, loader, mc, version):
    if loader not in UID:
        raise ValueError("Ismeretlen modloader.")
    version = modpacks.resolve_loader(loader,mc,version)
    doc["components"] = [r for r in doc["components"] if r["uid"] not in UID.values()]
    doc["components"].append({"uid":UID[loader],"version":version})


def create(name, mc, loader="vanilla", loader_version=""):
    validate_title(name)
    root = roots()[0]
    root.mkdir(parents=True,exist_ok=True)
    dest = child(root,name)
    if name.startswith(".") or any((d/name).exists() for d in roots()):
        raise ValueError("Válassz új, látható példánynevet.")
    mc = modpacks.ident(mc)
    resp = requests.get("https://meta.prismlauncher.org/v1/net.minecraft/" + mc + ".json",
                        headers=modpacks.HEADERS,timeout=15)
    resp.raise_for_status()
    if resp.json().get("version") != mc:
        raise ValueError("A Minecraft-verzió nem szerepel a Prism katalógusában.")
    doc = {"formatVersion":1,"components":[{"uid":"net.minecraft","version":mc,"important":True}]}
    if loader != "vanilla":
        configure_loader(doc,loader,mc,loader_version)
    with lock(root), tempfile.TemporaryDirectory(dir=root,prefix=".neutron-") as tmp:
        if dest.exists():
            raise ValueError("A példány már létezik.")
        p = Path(tmp)/"instance"
        (p/"minecraft/mods").mkdir(parents=True)
        (p/"instance.cfg").write_text("[General]\nInstanceType=OneSix\nConfigVersion=1.3\nname="+name+"\n")
        (p/"mmc-pack.json").write_text(json.dumps(doc,indent=2))
        p.rename(dest)
    return {"created":name,**versions(dest)}


def attempt(p):
    f = child(p,".neutron-launch.json")
    return json.loads(f.read_text()) if f.exists() else {}


def idle(p):
    if processes().get(game(p)):
        raise ValueError("A példány fut. A módosításhoz előbb zárd be a játékot.")
    last = attempt(p)
    if last.get("pending") and time.time()-last["time"] < 180:
        raise ValueError("A példány indítása folyamatban van. Ellenőrizd az állapotát.")


def runtimes():
    result = {}
    for f in (data_root()/"java").glob("*/bin/java"):
        base = f.parent.parent
        release = base/"release"
        if os.access(f,os.X_OK) and release.is_file():
            result[base.name] = {"version":setting(release.read_text(),"JAVA_VERSION").strip('"'),"path":str(f)}
    return result


def edit(p, action, value, loader_version=""):
    with lock(p):
        idle(p)
        if action == "loader":
            info = versions(p)
            if info["loader"] not in ("vanilla",value) and mod_files(p):
                raise ValueError("Modokat tartalmazó példányban másik loaderhez hozz létre új példányt.")
            f = child(p,"mmc-pack.json")
            doc = components(p)
            configure_loader(doc,value,info["minecraft"],loader_version)
            content = json.dumps(doc,indent=2)
        else:
            f = child(p,"instance.cfg")
            original = f.read_text()
            if action == "rename":
                validate_title(value)
                changes = {"name":value}
            elif action == "java":
                if value == "auto":
                    changes = {"OverrideJavaLocation":"false","AutomaticJava":"true"}
                else:
                    runtime = runtimes().get(value)
                    if not runtime:
                        raise ValueError("Válassz a Prism telepített Java-környezetei közül.")
                    changes = {"OverrideJavaLocation":"true","AutomaticJava":"false","JavaPath":runtime["path"]}
            elif action == "memory":
                mb = int(value)
                if not 512 <= mb <= 65536:
                    raise ValueError("A memória 512–65536 MiB között adható meg.")
                changes = {"OverrideMemory":"true","MaxMemAlloc":str(mb),"MinMemAlloc":str(min(mb,int(setting(original,"MinMemAlloc","512"))))}
            else:
                raise ValueError("Ismeretlen példánymódosítás.")
            lines = original.splitlines()
            start = lines.index("[General]")+1 if "[General]" in lines else 0
            end = next((i for i in range(start,len(lines)) if lines[i].startswith("[")),len(lines))
            lines[start:end] = [line for line in lines[start:end] if line.partition("=")[0] not in changes]+[k+"="+v for k,v in changes.items()]
            content = "\n".join(lines)+"\n"
        atomic(child(p,f.name+".neutron-backup"),f.read_text())
        atomic(f,content)
    return {"edited":p.name,"backup":f.name+".neutron-backup","note":"Ha a nyitott Prism a korábbi beállítást mutatja, a következő indítás előtt indítsd újra a launchert."}


def mod_files(p):
    mods = child(game(p),"mods")
    return sorted(f for f in mods.iterdir() if f.is_file() and not f.is_symlink() and
                  f.name.lower().endswith((".jar",".jar.disabled"))) if mods.is_dir() else []


def digest(p, algorithm):
    with p.open("rb") as stream:
        return hashlib.file_digest(stream,algorithm).hexdigest()


def mod_ids(p):
    try:
        with zipfile.ZipFile(p) as z:
            for file in ("fabric.mod.json","quilt.mod.json","META-INF/neoforge.mods.toml","META-INF/mods.toml"):
                if file not in z.namelist() or z.getinfo(file).file_size > 2_000_000:
                    continue
                data = z.read(file)
                if file.endswith("toml"):
                    return {m["modId"] for m in tomllib.loads(data.decode()).get("mods",[]) if "modId" in m}
                meta = json.loads(data)
                return {meta.get("quilt_loader",meta)["id"]}
    except (zipfile.BadZipFile,UnicodeError,ValueError,KeyError):
        pass
    return set()


def inspect_mods(p):
    return [{"file":f.name,"enabled":f.suffix==".jar","ids":sorted(mod_ids(f))} for f in mod_files(p)]


def toggle(p, name, enable):
    with lock(p):
        idle(p)
        mods = child(game(p),"mods")
        f = child(mods,name)
        suffix = ".jar.disabled" if enable else ".jar"
        if not f.is_file() or not f.name.endswith(suffix):
            raise ValueError("A listából válaszd ki a megfelelő állapotú jar pontos fájlnevét.")
        to = child(mods,f.name.removesuffix(".disabled") if enable else f.name+".disabled")
        if to.exists():
            raise ValueError("A célfájl már létezik.")
        if enable and any(mod_ids(f) & mod_ids(g) for g in mod_files(p) if g.suffix==".jar"):
            raise ValueError("Már van aktív példány ebből a modból.")
        f.rename(to)
    return {"file":to.name,"enabled":enable}


def installed_versions(paths):
    hashes = {digest(p,"sha1"):p for p in paths}
    known = {}
    keys = list(hashes)
    for i in range(0,len(keys),400):
        res = requests.post(modpacks.API+"/version_files",headers=modpacks.HEADERS,
                            json={"hashes":keys[i:i+400],"algorithm":"sha1"},timeout=30)
        res.raise_for_status()
        for h,v in res.json().items():
            if v["project_id"] in known:
                raise ValueError("Ugyanabból a Modrinth-modból több verzió aktív. Előbb kapcsold ki a fölöslegeset.")
            known[v["project_id"]] = (v,hashes[h])
    return known


def download(entry, path):
    with requests.get(entry["downloads"][0],headers=modpacks.HEADERS,stream=True,timeout=(8,45)) as response:
        response.raise_for_status()
        sha = hashlib.sha512()
        size = 0
        with path.open("xb") as stream:
            for block in response.iter_content(131072):
                size += len(block)
                if size > entry["fileSize"]:
                    raise ValueError("A letöltött jar túl nagy.")
                sha.update(block)
                stream.write(block)
        if size != entry["fileSize"] or sha.hexdigest() != entry["hashes"]["sha512"] or not zipfile.is_zipfile(path):
            raise ValueError("A letöltött mod ellenőrzése sikertelen: "+path.name)


def install(p, refs):
    with lock(p):
        idle(p)
        info = versions(p)
        mods = child(game(p),"mods")
        mods.mkdir(parents=True,exist_ok=True)
        existing = [f for f in mod_files(p) if f.suffix==".jar"]
        known = installed_versions(existing)
        files, selected = modpacks.resolve_mods(refs,info["minecraft"],info["loader"],{k:v for k,(v,f) in known.items()})
        disabled, additions = [], []
        known_files = {pair[1] for pair in known.values()}
        unknown_ids = {f:mod_ids(f) for f in existing if f not in known_files}
        with tempfile.TemporaryDirectory(dir=mods,prefix=".neutron-") as tmp:
            for entry,(pid,vid) in zip(files,selected.items(),strict=True):
                target = child(mods,Path(entry["path"]).name)
                if entry.get("env",{}).get("client") == "unsupported":
                    raise ValueError("Ez a mod csak szerveren használható: "+target.name)
                old_version, old = known.get(pid,({},None))
                if old_version.get("id") == vid:
                    continue
                if target.exists() and target != old:
                    raise ValueError("Már létezik eltérő tartalmú fájl: "+target.name)
                if old:
                    backup = child(mods,old.name+".disabled")
                    if backup.exists():
                        raise ValueError("Már létezik ilyen kikapcsolt mod: "+backup.name)
                    disabled.append((old,backup))
                f = child(Path(tmp),target.name)
                download(entry,f)
                ids = mod_ids(f)
                for other, other_ids in unknown_ids.items():
                    if ids & other_ids:
                        raise ValueError("Ütközés egy kézzel telepített moddal: "+other.name)
                additions.append((f,target))
            idle(p)
            applied = []
            try:
                for src,dst in disabled+additions:
                    if dst.exists():
                        raise ValueError("A fájl időközben megváltozott: "+dst.name)
                    src.rename(dst)
                    applied.append((src,dst))
            except Exception:
                for src,dst in reversed(applied):
                    dst.rename(src)
                raise
        return {"installed":[dst.name for _,dst in additions],"previous_versions":[b.name for _,b in disabled],"resolved":len(files)}

ERROR = re.compile(r"/(?:ERROR|FATAL)\]|\bCaused by:|\bException in thread\b|Mod resolution encountered|Incompatible mod set|Incompatible mods found|Loading errors encountered|Failed to start|OutOfMemoryError|UnsupportedClassVersionError",re.I)
DETAIL = re.compile(r"\brequires?\b|depends on|incompatible|duplicate|missing|corrupt|Failure message|Exception message|suspected mod|mod file:|\.jar\b.*(?:failed|broken)|Description:|^\s*(?:at |Caused by:)|a potential solution|replace mod|install .+version|which is missing",re.I)
READY = re.compile(r"Sound engine started|OpenAL initialized|Created: .*textures/atlas|Loaded \d+ advancements|joined the game",re.I)
SECRET = re.compile(r"access.?token|refresh.?token|authorization|--username|--uuid|client.?token|session.?id|\[CHAT\]|https?://\S*[?&]",re.I)


def excerpt(line):
    if SECRET.search(line):
        return ""
    line = line.replace(str(Path.home()),"~")
    return re.sub(r"\b[A-Za-z0-9_-]{48,}\b","[azonosító]",line.strip())[:550]


def read_log(path, offset=0):
    if not path.is_file() or path.is_symlink():
        return "", False
    size = path.stat().st_size
    with path.open("rb") as f:
        f.seek(min(offset,size))
        if size-f.tell() <= 2_000_000:
            return f.read().decode(errors="replace"), False
        first = f.read(500_000)
        f.seek(-1_500_000,2)
        return (first+b"\n...\n"+f.read()).decode(errors="replace"), True


def crash_files(p):
    base = child(game(p),"crash-reports")
    reports = list(base.glob("crash-*.txt")) if base.is_dir() else []
    reports += list(game(p).glob("hs_err_pid*.log"))
    return sorted((f for f in reports if f.is_file() and not f.is_symlink()),key=lambda f:f.stat().st_mtime_ns,reverse=True)


def signature(f):
    if f.is_file() and not f.is_symlink():
        s = f.stat()
        return [s.st_ino,s.st_size,s.st_mtime_ns]
    return []


def current_log(p):
    return child(child(game(p),"logs"),"latest.log")


def launcher_log():
    return data_root()/"logs"/"PrismLauncher-0.log"


def launcher_errors(p, rec):
    if not rec:
        return []
    path = launcher_log()
    stamp = signature(path)
    if not stamp or path.stat().st_mtime < rec["time"]:
        return []
    before = rec.get("launcher_log") or []
    offset = before[1] if before and before[0] == stamp[0] and before[1] <= stamp[1] else 0
    text = read_log(path,offset)[0]
    # The launcher log is global. Only attribute diagnostics explicitly naming this instance.
    needle = re.compile(r'(?<![\w.-])'+re.escape(p.name)+r'(?![\w.-])',re.I)
    return [msg for line in text.splitlines() if needle.search(line) and
            re.search(r"error|failed|failure|critical|fatal",line,re.I) and (msg:=excerpt(line))][-8:]


def diagnostics(p, latest=False):
    previous = attempt(p)
    log = current_log(p)
    this = signature(log)
    old = previous.get("log",[])
    offset = 0
    if latest and previous:
        if this == old:
            offset = this[1] if this else 0
        elif this and old and this[0] == old[0] and this[1] > old[1] and previous.get("prefix") == prefix_hash(log,min(old[1],4096)):
            offset = old[1]
    text, limited = read_log(log,offset if latest else 0)
    reports = crash_files(p)
    # For an externally started instance, reports from older sessions shouldn't affect its health.
    live_ids = processes().get(game(p),[])
    since = previous.get("time",0) if latest else 0
    if latest and live_ids and os.name!="nt":
        try:
            tick = os.sysconf("SC_CLK_TCK")
            boot = time.time()-float(Path("/proc/uptime").read_text().split()[0])
            started = min(boot+int((Path("/proc")/str(pid)/"stat").read_text().rsplit(")",1)[1].split()[19])/tick for pid in live_ids)
            since = max(since,started-2)
            if log.exists() and log.stat().st_mtime < since:
                text = ""
        except (OSError,ValueError,IndexError):
            pass
    if since:
        reports = [f for f in reports if f.stat().st_mtime >= since]
    crash = reports[0] if reports else None
    report = read_log(crash)[0] if crash else ""
    errors = [s for s in text.splitlines() if ERROR.search(s)]
    evidence = []
    for block in (report,text):
        for line in block.splitlines():
            if (ERROR.search(line) or DETAIL.search(line)) and (s:=excerpt(line)) and s not in evidence:
                evidence.append(s)
                if len(evidence) >= 45:
                    break
        if len(evidence) >= 45:
            break
    launcher = launcher_errors(p,previous) if latest else []
    evidence.extend(launcher)
    combined = "\n".join(evidence)
    hints = []
    if re.search("OutOfMemoryError|Java heap space",combined,re.I):
        hints.append("Ellenőrizd a szabad RAM-ot és a példány memóriakeretét. A prism_edit memory módosítja a keretet.")
    if re.search("UnsupportedClassVersionError|requires Java|class file version",combined,re.I):
        hints.append("Ellenőrizd a Minecraft- és Java-verzió párosítását a Prism Java-beállításaiban.")
    if re.search("requires|which is missing|depends on|install .+version",combined,re.I):
        hints.append("Azonosítsd a hiányzó függőséget és verziót. Keress a példány verziójára és loaderére, majd telepítsd a kompatibilis modot.")
    if re.search("duplicate|incompatib|corrupt|ZipException",combined,re.I):
        hints.append("Listázd a jar fájlokat, és kapcsold ki a hibában szereplő ütköző vagy sérült verziót. Az eredeti fájl visszakapcsolható.")
    return {"log":log.name if this else None,"crash_report":crash.name if crash else None,
            "launcher_errors":launcher, "errors_seen":len(errors)+len(launcher),"error_examples":[s for l in errors[-8:] if (s:=excerpt(l))],
            "fatal_seen":bool(re.search(r"/FATAL\]|Incompatible mods found|Mod resolution encountered|Failed to start Minecraft|OutOfMemoryError",text,re.I)),
            "startup_marker":bool(READY.search(text)),"log_sampled":limited,"diagnostic_lines":evidence,"suggestions":hints}


def prefix_hash(f,size=4096):
    if not f.is_file() or f.is_symlink():
        return None
    with f.open("rb") as stream:
        return hashlib.sha256(stream.read(size)).hexdigest()


def status(p):
    ids = processes().get(game(p),[])
    rec = attempt(p)
    diag = diagnostics(p,True)
    fresh = bool(rec or ids)
    if ids:
        state = "running_with_errors" if diag["errors_seen"] else "running_with_startup_marker" if diag["startup_marker"] else "process_running"
    elif fresh and diag["crash_report"]:
        state = "crashed"
    elif fresh and (diag["launcher_errors"] or diag.get("fatal_seen") or (rec.get("observed") and diag["errors_seen"])):
        state = "exited_with_errors"
    elif rec.get("pending") and time.time()-rec["time"] < 180:
        state = "waiting_for_game"
    elif rec.get("pending"):
        state = "launch_unconfirmed"
    else:
        state = "not_running"
    if rec.get("pending") and (ids or state in ("crashed","exited_with_errors")):
        rec["observed"] = bool(ids)
        rec["pending"] = False
        atomic(child(p,".neutron-launch.json"),json.dumps(rec))
    return {"instance":p.name,"state":state,"game_pids":ids,"log_scope":"launch" if fresh else "last_recorded_session",
            **{k:diag[k] for k in ("startup_marker","errors_seen","error_examples","launcher_errors","crash_report","log_sampled")}}


def launcher():
    exe=shutil.which("prismlauncher")
    if os.name=="nt" and not exe:
        for base in (Path(os.environ.get("ProgramFiles","C:/Program Files")),Path(os.environ["LOCALAPPDATA"])/"Programs"):
            candidate=base/"PrismLauncher"/"prismlauncher.exe"
            if candidate.is_file(): return str(candidate)
        raise ValueError("A Prism Launcher nem található. Telepítsd, vagy add hozzá a PATH-hoz.")
    return exe


def launch(p):
    with lock(p):
        if processes().get(game(p)):
            return status(p)
        idle(p)
        log = current_log(p)
        record = {"time":time.time(),"pending":True,"log":signature(log),"prefix":prefix_hash(log),"launcher_log":signature(launcher_log())}
        exe = launcher()
        cmd = ["flatpak","run","org.prismlauncher.PrismLauncher"] if ".var/app/org.prismlauncher.PrismLauncher/" in str(data_root()) or not exe else [exe]
        with tempfile.TemporaryFile() as err:
            proc = subprocess.Popen([*cmd,"--launch",p.name],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=err,start_new_session=True)
            try:
                if proc.wait(timeout=.7):
                    err.seek(0)
                    raise ValueError("A Prism elutasította az indítást. "+excerpt(err.read(1500).decode(errors="replace")))
            except subprocess.TimeoutExpired:
                pass
        atomic(child(p,".neutron-launch.json"),json.dumps(record))
    return status(p)


def run(p, action):
    if action == "launch":
        return launch(p)
    if action == "diagnose":
        return diagnostics(p,latest=bool(attempt(p) or processes().get(game(p))))
    if action == "history":
        return diagnostics(p,latest=False)
    if action == "status":
        return status(p)
    if action == "wait":
        deadline = time.monotonic()+15
        while True:
            s = status(p)
            if s["startup_marker"] or s["state"] not in ("waiting_for_game","process_running","running_with_errors") or time.monotonic()>=deadline:
                return s
            time.sleep(1)
    raise ValueError("Ismeretlen Prism-művelet.")


if __name__ == "__main__":
    import sys
    try:
        print(json.dumps(list_instances(),ensure_ascii=False))
    except Exception as error:
        sys.exit(str(error))
