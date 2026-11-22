"""Build Modrinth packs from compatible, checksummed releases."""
from functools import lru_cache
import io
import json
import re
import zipfile
from urllib.parse import quote

import requests

API = "https://api.modrinth.com/v2"
HEADERS = {"User-Agent": "NeutronDesktop/1.0 (Prism modpack builder)"}


def get(route, **params):
    res = requests.get(API + route, params=params, headers=HEADERS, timeout=16)
    res.raise_for_status()
    return res.json()


def ident(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.+-]{1,100}", value):
        raise ValueError("Érvénytelen projekt- vagy verzióazonosító.")
    return quote(value, safe="")


def search(query, game_version="", loader=""):
    facets = [["project_type:mod"]]
    if game_version:
        facets.append(["versions:" + game_version])
    if loader:
        facets.append(["categories:" + loader])
    hits = get("/search", query=query, facets=json.dumps(facets), limit=10)["hits"]
    return [{k: h[k] for k in ("slug", "title", "description", "project_id")} for h in hits]


def resolve_loader(loader, game_version, requested):
    uid = {"fabric":"net.fabricmc.fabric-loader", "quilt":"org.quiltmc.quilt-loader",
           "forge":"net.minecraftforge", "neoforge":"net.neoforged"}[loader]
    response = requests.get(f"https://meta.prismlauncher.org/v1/{uid}/index.json", headers=HEADERS, timeout=15)
    response.raise_for_status()
    versions = [v for v in response.json()["versions"] if all(
        r.get("uid") != "net.minecraft" or r.get("equals",game_version) == game_version for r in v.get("requires", []))]
    if requested:
        if any(v["version"] == requested for v in versions):
            return requested
        raise ValueError("Ez a loaderverzió hiányzik a Prism kompatibilis kiadásai közül.")
    if not versions:
        raise ValueError("A Prism nem ismer kompatibilis modloadert.")
    return next((v["version"] for v in versions if v.get("recommended")), versions[0]["version"])


def resolve_mods(mods, game_version, loader, installed=None):
    if loader not in ("fabric", "quilt", "forge", "neoforge") or not mods or len(mods) > 100:
        raise ValueError("Adj meg 1–100 modot és támogatott modloadert.")
    ident(game_version)
    installed = installed or {}
    fetch = lru_cache(maxsize=2048)(get)
    pins = {}
    seen = set()
    while True:
        files, versions, required, excluded = resolve_pass(mods, game_version, loader, installed, pins, fetch)
        if required == pins or (not pins and all(versions[pid] == version for pid,version in required.items())):
            break
        signature = frozenset(required.items())
        if signature in seen or len(seen) >= 200:
            raise ValueError("A rögzített modverziók függőségei nem oldhatók fel.")
        seen.add(signature)
        pins = required
    selected = {pid:v["id"] for pid,v in installed.items()} | versions
    if any(pid in selected and (not vid or selected[pid] == vid) for pid, vid in excluded):
        raise ValueError("A kiválasztott modok összeférhetetlenek.")
    return files, versions



def resolve_pass(mods, game_version, loader, installed, pins, fetch):
    versions, files, excluded, paths = {}, [], set(), set()
    required = {}
    queue = []
    for ref in mods:
        project, sep, version = ref.partition("@")
        queue.append((project, version if sep else None, False))
    while queue:
        ref, pin, dependency = queue.pop(0)
        project = fetch("/project/" + ident(ref))
        pid = project["id"]
        if project["project_type"] != "mod":
            raise ValueError(project["title"] + " típusa nem mod.")
        if pin:
            if pid in required and required[pid] != pin:
                raise ValueError(project["title"] + " verziókövetelményei ütköznek.")
            required[pid] = pin
        if pid in versions:
            continue
        pin = pin or pins.get(pid)
        if len(versions) >= 200:
            raise ValueError("A csomag több mint 200 modot igényel.")
        if not pin and dependency and pid in installed:
            existing = installed[pid]
            if game_version in existing["game_versions"] and loader in existing["loaders"]:
                pin = existing["id"]
        if pin:
            v = fetch("/version/" + ident(pin))
        else:
            choices = fetch("/project/" + ident(pid) + "/version", loaders=json.dumps([loader]), game_versions=json.dumps([game_version]))
            if not choices:
                raise ValueError(project["title"] + ": nincs kompatibilis kiadás.")
            v = next((x for x in choices if x["version_type"] == "release"), choices[0])
        if pid != v["project_id"] or game_version not in v["game_versions"] or loader not in v["loaders"]:
            raise ValueError(project["title"] + " nem kompatibilis a csomaggal.")
        jars = [f for f in v["files"] if f["filename"].lower().endswith(".jar")]
        if not jars:
            raise ValueError(project["title"] + ": hiányzik a jar fájl.")
        f = next((x for x in jars if x.get("primary")), jars[0])
        filename = f["filename"]
        if "/" in filename or "\\" in filename or filename in paths or not f["url"].startswith("https://cdn.modrinth.com/"):
            raise ValueError("Ütköző vagy érvénytelen modfájl: " + filename)
        hashes = {k: f["hashes"][k] for k in ("sha1", "sha512")}
        paths.add(filename)
        versions[pid] = v["id"]
        files.append(dict(path="mods/" + filename, hashes=hashes, downloads=[f["url"]], fileSize=f["size"],
                          env={side: project[side + "_side"] for side in ("client", "server") if project.get(side + "_side") in ("required","optional","unsupported")}))
        for d in v["dependencies"]:
            project_id, version_id = d.get("project_id"), d.get("version_id")
            if d["dependency_type"] not in ("incompatible", "required"):
                continue
            if not project_id and version_id:
                project_id = fetch("/version/" + ident(version_id))["project_id"]
            if not project_id:
                raise ValueError("A függőséget nem lehet azonosítani: " + str(d.get("file_name")))
            if d["dependency_type"] == "required":
                queue.insert(0, (project_id, version_id, True))
            else:
                excluded.add((project_id, version_id))
    return files, versions, required, excluded


def build(name, mods, game_version, loader, loader_version=""):
    if loader not in ("fabric", "quilt", "forge", "neoforge"):
        raise ValueError("Ismeretlen modloader.")
    files, _ = resolve_mods(mods, game_version, loader)
    loader_version = resolve_loader(loader, game_version, loader_version)
    key = {"fabric":"fabric-loader", "quilt":"quilt-loader"}.get(loader, loader)
    manifest = dict(formatVersion=1, game="minecraft", versionId="1.0.0", name=name, files=files,
                    dependencies={"minecraft":game_version, key:loader_version})
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("modrinth.index.json", json.dumps(manifest, ensure_ascii=False))
    return out.getvalue(), len(files)
