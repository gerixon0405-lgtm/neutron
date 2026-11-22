"""Source-linked web cards for the Neutron chat."""
import os
import re
import unicodedata
from html.parser import HTMLParser
from urllib.parse import quote, urlsplit, urljoin

import requests

HEADERS = {"User-Agent":"NeutronDesktop/1.0 (interactive desktop search)"}


def query_text(query):
    query = " ".join(query.split())
    if not 1 <= len(query) <= 180:
        raise ValueError("Adj meg egy legfeljebb 180 karakteres keresést.")
    return query


class Offers(HTMLParser):
    def __init__(self, url):
        super().__init__()
        self.url, self.row, self.field, self.rows = url, None, None, []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        classes = (a.get("class") or "").split()
        if tag == "li" and "prod-item" in classes:
            self.row = {"url":self.url+"#"+a.get("id",""),"source":"ShopMania"}
        if self.row is None:
            return
        if "prod-item-img" in classes:
            self.row["image"] = a.get("data-src") or a.get("src","")
        if "prod-item-name" in classes:
            self.field = ("title",tag)
            if tag == "a" and a.get("href"):
                self.row["url"] = urljoin(self.url,a["href"])
        if "prod-price" in classes:
            self.field = ("price",tag)
        if "prod-item-merchant-link" in classes and a.get("title"):
            self.row["merchant"] = a["title"]

    def handle_data(self, text):
        if self.field and self.row is not None:
            key = self.field[0]
            self.row[key] = self.row.get(key,"")+text

    def handle_endtag(self, tag):
        if self.field and tag == self.field[1]:
            self.field = None
        if tag == "li" and self.row is not None:
            if self.row.get("title","").strip() and re.search(r"\d",self.row.get("price","")):
                self.rows.append({k:" ".join(v.split()) for k,v in self.row.items()})
            self.row = self.field = None


def products(query):
    q = unicodedata.normalize("NFKD",query_text(query).lower())
    slug = "-".join(re.findall(r"[a-z0-9]+","".join(c for c in q if not unicodedata.combining(c))))
    if not slug:
        raise ValueError("Adj meg kereshető terméknevet.")
    r = requests.get("https://www.shopmania.hu/q-"+quote(slug),headers=HEADERS,timeout=12)
    if r.status_code == 404:
        return []
    r.raise_for_status()
    parser = Offers(r.url)
    parser.feed(r.text)
    return parser.rows[:8]


def images(query):
    r = requests.get("https://commons.wikimedia.org/w/api.php",params={"action":"query","format":"json",
        "generator":"search","gsrsearch":"filetype:bitmap "+query_text(query),"gsrnamespace":6,"gsrlimit":8,
        "prop":"imageinfo","iiprop":"url","iiurlwidth":480},headers=HEADERS,timeout=15)
    r.raise_for_status()
    return [{"title":p["title"].removeprefix("File:"),"image":i["thumburl"],"url":i["descriptionurl"],"source":"Wikimedia Commons"}
            for p in sorted(r.json().get("query",{}).get("pages",{}).values(),key=lambda p:p.get("index",0))
            for i in p.get("imageinfo",[]) if i.get("thumburl") and i.get("descriptionurl")]


def curseforge(query, game_version, loader, search):
    q = query_text(query)
    key = os.environ.get("CURSEFORGE_API_KEY")
    if key:
        params = {"gameId":432,"classId":6,"searchFilter":q,"pageSize":15}
        if game_version: params["gameVersion"] = game_version
        if loader: params["modLoaderType"] = {"forge":1,"fabric":4,"quilt":5,"neoforge":6}[loader.lower()]
        r = requests.get("https://api.curseforge.com/v1/mods/search",params=params,headers={**HEADERS,"x-api-key":key},timeout=12)
        r.raise_for_status()
        return [{"title":m["name"],"url":m["links"]["websiteUrl"],"summary":m["summary"],"id":m["id"]} for m in r.json()["data"]]
    found = []
    for row in search("site:curseforge.com/minecraft/mc-mods/ "+" ".join(x for x in (q,game_version,loader) if x)):
        u = urlsplit(row["url"])
        match = re.match(r"^/minecraft/mc-mods/([a-z0-9_-]+)(?:/|$)",u.path)
        if u.hostname not in ("www.curseforge.com","curseforge.com") or not match or match[1]=="search":
            continue
        url = "https://www.curseforge.com/minecraft/mc-mods/"+match[1]
        if all(f["url"] != url for f in found):
            found.append({"title":row["title"],"url":url,"summary":row["snippet"],"source":"CurseForge · webindex"})
    return found
