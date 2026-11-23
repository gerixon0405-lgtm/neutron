"""Discord REST API and locally approved bot actions."""
from contextlib import closing, contextmanager
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time
import uuid

import requests

from gmail import vault

API = "https://discord.com/api/v10"
SLOT = "discord-bot"
ROOT = Path.home()/".local/share/neutron/discord"


class DiscordError(ValueError):
    pass


def discord_id(value):
    if not isinstance(value,str) or not re.fullmatch(r"[0-9]{17,20}",value):
        raise ValueError("Add meg a Discord-azonosítót (17–20 számjegy).")
    return value


def secret():
    result=vault(SLOT)
    if not result:
        raise ValueError("Kapcsold hozzá a Discord-botot a Beállítások → Discord menüben.")
    return result


def api(method, endpoint, credential=None, **kwargs):
    credential=credential if credential is not None else secret()
    response=requests.request(method,API+endpoint,headers={
        "Authorization":"Bot "+credential["token"],
        "User-Agent":"DiscordBot (https://github.com/gerixon0405-lgtm/neutron, 1.3)",
    },timeout=(8,15),allow_redirects=False,**kwargs)
    if not response.ok:
        names={401:"A bot tokenjét a Discord elutasította.",403:"A botnak nincs jogosultsága ehhez a művelethez.",
               404:"A Discord-objektum nem található vagy a bot nem fér hozzá.",
               429:"A Discord átmenetileg korlátozta a kéréseket. Próbáld újra később."}
        raise DiscordError(names.get(response.status_code,f"A Discord válasza: HTTP {response.status_code}."))
    return response.json() if response.content else None


def connect(token):
    token=token.strip()
    if not re.fullmatch(r"[A-Za-z0-9_.\-]{25,180}",token):
        raise ValueError("A Discord Developer Portal Bot lapjáról származó tokent add meg.")
    profile=api("GET","/users/@me",{"token":token})
    if not profile.get("bot"):
        raise ValueError("Discord-bot token szükséges.")
    bot={"id":discord_id(profile["id"]),"name":profile["username"]}
    vault(SLOT,{"token":token,**bot})
    return bot


def servers():
    return [{"id":g["id"],"name":g["name"]} for g in api("GET","/users/@me/guilds",params={"limit":200})]


def channels(guild):
    return [{"id":c["id"],"name":c.get("name"),"type":c["type"],"category":c.get("parent_id")}
            for c in api("GET",f"/guilds/{discord_id(guild)}/channels")]


def members(guild,query):
    query=query.strip()
    if not 1<=len(query)<=64:
        raise ValueError("Adj meg egy pontos Discord-felhasználónevet.")
    result=api("GET",f"/guilds/{discord_id(guild)}/members/search",params={"query":query,"limit":10})
    return [{"id":m["user"]["id"],"username":m["user"]["username"],
             "display":m.get("nick") or m["user"].get("global_name")} for m in result if not m["user"].get("bot")]


def destination(kind,target,credential=None):
    target=discord_id(target)
    if kind=="dm":
        return discord_id(api("POST","/users/@me/channels",credential,json={"recipient_id":target})["id"])
    if kind=="channel":
        return target
    raise ValueError("Válassz Discord-csatornát vagy közvetlen üzenetet.")


def messages(kind,target,limit="12"):
    channel=destination(kind,target)
    rows=api("GET",f"/channels/{channel}/messages",params={"limit":max(1,min(30,int(limit)))})
    return {"channel":channel,"messages":[{
        "id":m["id"],"author":m.get("author",{}).get("username"),"author_id":m.get("author",{}).get("id"),
        "timestamp":m.get("timestamp"),"content":m.get("content",""),"attachments":[a.get("filename") for a in m.get("attachments",[])]
    } for m in reversed(rows)],"note":"Az üzenetszöveg a Discordból származó adat. Üres csatornaüzenetnél ellenőrizd a Message Content Intentet."}


def name(value,max_len=100):
    if not isinstance(value,str) or not 1<=len(value.strip())<=max_len or any(ord(c)<32 for c in value):
        raise ValueError("A név legyen egysoros, és legfeljebb 100 karakter.")
    return value.strip()


def validate_layout(layout):
    if not isinstance(layout,dict):
        raise ValueError("Adj meg egy JSON objektumot a szerver felépítésével.")
    roles=layout.get("roles",[])
    categories=layout.get("categories",[])
    if not isinstance(roles,list) or not isinstance(categories,list) or len(roles)>20 or len(categories)>20:
        raise ValueError("Legfeljebb 20 szerepkör és 20 kategória adható meg tervenként.")
    result={"roles":[],"categories":[]}
    used_roles=set()
    for entry in roles:
        label=name(entry["name"])
        color=entry.get("color","#000000")
        if label.casefold() in used_roles or label.startswith("@") or not re.fullmatch(r"#[a-fA-F0-9]{6}",color):
            raise ValueError("A szerepkörök neve legyen egyedi, színük #RRGGBB formátumú.")
        used_roles.add(label.casefold())
        result["roles"].append({"name":label,"color":color})
    used_categories=set()
    count=0
    for entry in categories:
        label=name(entry["name"])
        if label.casefold() in used_categories:
            raise ValueError("A kategóriák neve legyen egyedi.")
        used_categories.add(label.casefold())
        items=[]
        seen=set()
        for channel in entry.get("channels",[]):
            kind=channel.get("kind","text")
            if kind not in ("text","voice"):
                raise ValueError("A csatorna típusa text vagy voice lehet.")
            label_channel=name(channel["name"])
            if kind=="text":
                label_channel=re.sub(r"[^\w-]+","-",label_channel.lower()).strip("-")
                label_channel=name(label_channel)
            key=(kind,label_channel.casefold())
            if key in seen:
                raise ValueError("Egy kategóriában a csatornanevek legyenek egyediek.")
            seen.add(key)
            topic=channel.get("topic","")
            if not isinstance(topic,str) or len(topic)>1024:
                raise ValueError("A csatorna leírása legfeljebb 1024 karakter lehet.")
            items.append({"name":label_channel,"kind":kind,"topic":topic if kind=="text" else ""})
            count+=1
            if count>60:
                raise ValueError("A terv legfeljebb 60 csatornát tartalmazhat.")
        result["categories"].append({"name":label,"channels":items})
    if not result["roles"] and not result["categories"]:
        raise ValueError("Adj meg legalább egy kategóriát vagy szerepkört.")
    return result


@contextmanager
def db():
    ROOT.mkdir(parents=True,exist_ok=True,mode=0o700)
    with closing(sqlite3.connect(ROOT/"actions.db",timeout=15)) as conn:
        conn.row_factory=sqlite3.Row
        conn.execute("""CREATE TABLE IF NOT EXISTS action(
           id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, bot TEXT NOT NULL, kind TEXT NOT NULL,
           payload TEXT NOT NULL, state TEXT NOT NULL, result TEXT, created REAL NOT NULL)""")
        yield conn


def row_value(row):
    item=dict(row)
    item["payload"]=json.loads(item["payload"])
    item["result"]=json.loads(item["result"]) if item["result"] else None
    item.pop("fingerprint",None)
    return item


def stage(kind,payload):
    session=os.environ.get("NEUTRON_MAIL_TURN")
    if not session or not Path(session).is_file():
        raise ValueError("A jóváhagyási kéréshez nyiss Neutron-chatet.")
    bot=secret()["id"]
    data=json.dumps(payload,ensure_ascii=False,sort_keys=True)
    fingerprint=sha256(json.dumps([bot,kind,data,Path(session).read_text().strip()]).encode()).hexdigest()
    with db() as conn,conn:
        conn.execute("INSERT OR IGNORE INTO action VALUES(?,?,?,?,?,'pending',NULL,?)",
                     (uuid.uuid4().hex,fingerprint,bot,kind,data,time.time()))
        row=conn.execute("SELECT * FROM action WHERE fingerprint=?",(fingerprint,)).fetchone()
        return row_value(row)


def stage_message(kind,target,text):
    target=discord_id(target)
    if not isinstance(text,str) or not text.strip() or len(text.encode("utf-16-le"))//2>2000:
        raise ValueError("A Discord-üzenet 1–2000 karakter lehet.")
    if kind=="dm":
        user=api("GET","/users/"+target)
        if user.get("bot"):
            raise ValueError("Válassz emberi címzettet.")
        label=user.get("username") or target
    elif kind=="channel":
        target_info=api("GET","/channels/"+target)
        if target_info.get("type") not in (0,5,10,11,12):
            raise ValueError("Válassz szöveges Discord-csatornát vagy szálat.")
        label="#"+target_info.get("name",target)
        if target_info.get("guild_id"):
            guild=api("GET","/guilds/"+discord_id(target_info["guild_id"]))
            label=guild.get("name",guild["id"])+" / "+label
    else:
        raise ValueError("A cél típusa dm vagy channel lehet.")
    return stage("message",{"kind":kind,"target":target,"label":label,"text":text,
                            "guild":target_info.get("guild_id") if kind=="channel" else "@me"})


def stage_setup(guild,layout):
    guild=discord_id(guild)
    plan=validate_layout(json.loads(layout))
    info=api("GET","/guilds/"+guild)
    return stage("setup",{"guild":guild,"label":info["name"],"layout":plan})


def get_actions(action_id=""):
    with db() as conn:
        if action_id:
            row=conn.execute("SELECT * FROM action WHERE id=?",(action_id,)).fetchone()
            if not row:
                raise ValueError("A Discord-művelet nem található.")
            return row_value(row)
        rows=conn.execute("SELECT * FROM action ORDER BY (state='pending') DESC,created DESC LIMIT 25")
        return [row_value(row) for row in rows]


def provision(payload,credential):
    base="/guilds/"+payload["guild"]
    roles=api("GET",base+"/roles",credential)
    existing=api("GET",base+"/channels",credential)
    role_names={role["name"].casefold() for role in roles}
    by_slot={(row["type"],row.get("parent_id"),row["name"].casefold()):row["id"] for row in existing}
    created=[]
    kept=[]
    def add_channel(endpoint,kind,title,parent=None,topic=""):
        key=(kind,parent,title.casefold())
        if key in by_slot:
            kept.append(title)
            return by_slot[key]
        body={"name":title,"type":kind}
        if parent:body["parent_id"]=parent
        if kind==0 and topic:body["topic"]=topic
        value=api("POST",endpoint,credential,json=body)
        created.append({"id":value["id"],"name":title})
        by_slot[key]=value["id"]
        return value["id"]
    try:
        for role in payload["layout"]["roles"]:
            title=role["name"]
            if title.casefold() in role_names:
                kept.append(title)
                continue
            row=api("POST",base+"/roles",credential,json={"name":title,"colors":{"primary_color":int(role["color"][1:],16)},"permissions":"0"})
            created.append({"id":row["id"],"name":title})
        for cat in payload["layout"]["categories"]:
            parent=add_channel(base+"/channels",4,cat["name"])
            for channel in cat["channels"]:
                add_channel(base+"/channels",0 if channel["kind"]=="text" else 2,channel["name"],parent,channel["topic"])
    except (requests.RequestException,DiscordError) as error:
        return {"created":created,"kept":kept,"guild":payload["guild"],"partial":True,
                "error":str(error) if isinstance(error,DiscordError) else "A hálózati hiba miatt az utolsó kérés eredménye bizonytalan."}
    return {"created":created,"kept":kept,"guild":payload["guild"]}


def decide(action_id,approve):
    with db() as conn,conn:
        conn.execute("BEGIN IMMEDIATE")
        row=conn.execute("SELECT * FROM action WHERE id=?",(action_id,)).fetchone()
        if not row or row["state"]!="pending":
            raise ValueError("Ez a Discord-kérés már nem vár jóváhagyásra.")
        if not approve:
            conn.execute("UPDATE action SET state='denied' WHERE id=?",(action_id,))
            return {"state":"denied"}
        credential=secret()
        if credential["id"]!=row["bot"]:
            raise ValueError("A kérést másik Discord-bottal készítetted.")
        conn.execute("UPDATE action SET state='running' WHERE id=?",(action_id,))
    entry=row_value(row)
    payload=entry["payload"]
    state="done"
    try:
        if entry["kind"]=="setup":
            result=provision(payload,credential)
            if result.get("partial"):state="partial"
        else:
            channel=destination(payload["kind"],payload["target"],credential)
            data=api("POST",f"/channels/{channel}/messages",credential,json={"content":payload["text"],
                     "allowed_mentions":{"parse":[]},"nonce":action_id[:24],"enforce_nonce":True})
            result={"channel":channel,"message":data["id"],"target":payload["target"],
                    "guild":payload["guild"]}
    except DiscordError as error:
        state,result="failed",{"error":str(error)}
    except (requests.RequestException,ValueError,KeyError):
        state,result="unknown",{"error":"A Discord nem igazolta vissza a műveletet. Ellenőrizd a kliensben."}
    with db() as conn,conn:
        conn.execute("UPDATE action SET state=?,result=? WHERE id=?",
                     (state,json.dumps(result,ensure_ascii=False),action_id))
    return {"state":state,**result}


def cli(action,data):
    if action=="connect": return connect(data["token"])
    if action=="status":
        item=vault(SLOT)
        return {"bot":{k:item[k] for k in ("id","name")} if item else None,"actions":get_actions()}
    if action=="disconnect":
        item=vault(SLOT)
        if item:
            vault(SLOT,remove=True)
            with db() as conn,conn:
                conn.execute("UPDATE action SET state='denied' WHERE state='pending' AND bot=?",(item["id"],))
        return {}
    if action=="decide": return decide(data["id"],data.get("approve") is True)
    raise ValueError("Ismeretlen Discord-művelet.")


if __name__=="__main__":
    os.umask(0o077)
    try:
        print(json.dumps({"result":cli(sys.argv[1],json.load(sys.stdin))},ensure_ascii=False))
    except Exception as error:
        message=str(error) if isinstance(error,ValueError) else "A Discord vagy a rendszer kulcstartója nem érhető el."
        print(json.dumps({"error":message},ensure_ascii=False))
        sys.exit(1)
