"""Durable per-recipient outbox shared by Neutron's UI, worker, and MCP tools."""
from contextlib import contextmanager, closing
from desktop_lock import file_lock
import hashlib
import json
import os
from pathlib import Path
import secrets
import threading
import sqlite3
import sys
import time
import uuid

import gmail

ROOT=Path.home()/".local/share/neutron/mail"
DDL="""
CREATE TABLE IF NOT EXISTS account(singleton INTEGER PRIMARY KEY CHECK(singleton=1),email TEXT, slot TEXT, method TEXT,
    resume_at REAL DEFAULT 0,note TEXT DEFAULT '',needs_login INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS batch(id TEXT PRIMARY KEY,email TEXT NOT NULL,scope TEXT NOT NULL,
    fingerprint TEXT NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL,created REAL NOT NULL,
    UNIQUE(email,scope,fingerprint));
CREATE TABLE IF NOT EXISTS delivery(id INTEGER PRIMARY KEY,batch TEXT NOT NULL REFERENCES batch(id),recipient TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',note TEXT NOT NULL DEFAULT '',message_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS delivery_queue ON delivery(state,id);
CREATE INDEX IF NOT EXISTS batch_rows ON delivery(batch,state);
"""


@contextmanager
def database():
    ROOT.mkdir(mode=0o700,parents=True,exist_ok=True)
    with closing(sqlite3.connect(ROOT/"outbox.db",timeout=20)) as db:
        db.row_factory=sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.executescript(DDL)
        yield db


@contextmanager
def lock(name,nonblocking=False):
    ROOT.mkdir(mode=0o700,parents=True,exist_ok=True)
    with file_lock(ROOT/(name+".lock"),nonblocking):
        yield


def active(db):
    return db.execute("SELECT * FROM account WHERE singleton=1").fetchone()


def connect(cred):
    with lock("connection"),database() as db:
        old=active(db)
        slot=uuid.uuid4().hex
        gmail.vault(slot,cred)
        try:
            with db:
                if old and old["email"] != cred["email"]:
                    db.execute("UPDATE delivery SET state='cancelled' WHERE state='pending' AND batch IN (SELECT id FROM batch WHERE email=?)",(old["email"],))
                db.execute("INSERT OR REPLACE INTO account(singleton,email,slot,method) VALUES(1,?,?,?)",
                           (cred["email"],slot,cred["method"]))
        except Exception:
            gmail.vault(slot,remove=True)
            raise
        if old:
            gmail.vault(old["slot"],remove=True)
    return {"email":cred["email"]}


def disconnect():
    with lock("connection"),database() as db:
        old=active(db)
        if old:
            gmail.vault(old["slot"],remove=True)
            with db:
                db.execute("DELETE FROM account")
                db.execute("""UPDATE delivery SET state='cancelled',note='A fiókot leválasztották.'
                    WHERE state='pending' AND batch IN (SELECT id FROM batch WHERE email=?)""",(old["email"],))
    return {}


def summary(db,bid):
    batch=db.execute("SELECT id,email,subject,created FROM batch WHERE id=?",(bid,)).fetchone()
    counts={row[0]:row[1] for row in db.execute("SELECT state,count(*) FROM delivery WHERE batch=? GROUP BY state",(bid,))}
    return dict(batch) | {"counts":counts,"total":sum(counts.values())}


def status(bid="",details=False):
    with database() as db:
        a=active(db)
        if not a:
            if bid: raise ValueError("Nincs csatlakoztatott Gmail-fiók.")
            return {"email":None,"batches":[]}
        if bid:
            if not db.execute("SELECT 1 FROM batch WHERE id=? AND email=?",(bid,a["email"])).fetchone():
                raise ValueError("Ehhez a fiókhoz nem található ilyen küldés.")
            result=summary(db,bid)
            if details:
                result["problems"]=[dict(r) for r in db.execute("""SELECT recipient,state,note FROM delivery
                    WHERE batch=? AND state IN ('failed','unknown') ORDER BY id LIMIT 100""",(bid,))]
            result["account_note"]=a["note"]
            return result
        ids=db.execute("SELECT id FROM batch WHERE email=? ORDER BY created DESC LIMIT 15",(a["email"],))
        return {"email":a["email"],"method":a["method"],"note":a["note"],"resume_at":a["resume_at"],
                "batches":[summary(db,r[0]) for r in ids]}


def enqueue(recipients,subject,body,scope):
    if not isinstance(recipients,list) or not recipients:
        raise ValueError("Adj meg legalább egy címzettet.")
    if not isinstance(subject,str) or not subject.strip() or any(ord(c)<32 or ord(c)==127 for c in subject):
        raise ValueError("Adj meg egysoros tárgyat.")
    if not isinstance(body,str) or not body.strip():
        raise ValueError("A levél szövege üres.")
    targets=list(dict.fromkeys(gmail.address(a) for a in recipients))
    fingerprint=hashlib.sha256(json.dumps([sorted(targets),subject,body],ensure_ascii=False).encode()).hexdigest()
    with database() as db,db:
        db.execute("BEGIN IMMEDIATE")
        a=active(db)
        if not a or a["needs_login"]:
            raise ValueError("Csatlakoztasd a Gmail-fiókot a Beállításokban.")
        old=db.execute("SELECT id FROM batch WHERE scope=? AND email=? AND fingerprint=?",(scope,a["email"],fingerprint)).fetchone()
        if old:
            return summary(db,old[0])
        bid=uuid.uuid4().hex
        db.execute("INSERT INTO batch VALUES(?,?,?,?,?,?,?)",(bid,a["email"],scope,fingerprint,subject,body,time.time()))
        db.executemany("INSERT INTO delivery(batch,recipient,message_id) VALUES(?,?,?)",
                       ((bid,email,"<"+uuid.uuid4().hex+"@"+a["email"].split("@")[-1]+">") for email in targets))
        return summary(db,bid)


def cancel(bid):
    with database() as db,db:
        a=active(db)
        if not a: raise ValueError("Nincs csatlakoztatott fiók.")
        db.execute("""UPDATE delivery SET state='cancelled' WHERE state='pending' AND batch=?
            AND batch IN (SELECT id FROM batch WHERE email=?)""",(bid,a["email"]))
    return status(bid)


def recover(db):
    with db:
        db.execute("""UPDATE delivery SET state='unknown',note='A Neutron a Gmail visszaigazolása előtt leállt.
Ellenőrizd az Elküldött leveleket.' WHERE state='sending'""")


def step(db):
    with lock("connection"):
        a=active(db)
        if not a or a["needs_login"] or a["resume_at"]>time.time():
            return False
        with db:
            db.execute("BEGIN IMMEDIATE")
            row=db.execute("""SELECT d.*,b.subject,b.body FROM delivery d JOIN batch b ON b.id=d.batch
                WHERE b.email=? AND d.state='pending' ORDER BY d.id LIMIT 1""",(a["email"],)).fetchone()
            if not row: return False
            db.execute("UPDATE delivery SET state='sending' WHERE id=?",(row["id"],))
        state,note="sent",""
        try:
            try:
                cred=gmail.vault(a["slot"])
            except Exception:
                raise gmail.DeliveryError("auth","A rendszer kulcstartója nem elérhető.")
            if not cred or cred.get("email")!=a["email"]:
                raise gmail.DeliveryError("auth","A mentett hitelesítés nem elérhető.")
            gmail.deliver(cred,a["slot"],row["recipient"],row["subject"],row["body"],row["message_id"])
        except gmail.DeliveryError as err:
            state,note=err.state,str(err)
            if state in ("auth","pending"):
                with db:
                    db.execute("UPDATE account SET needs_login=?,note=?,resume_at=? WHERE singleton=1",
                               (int(state=="auth"),note,time.time()+err.delay))
                state="pending"
        except Exception:
            state,note="unknown","A küldés eredménye bizonytalan. Ellenőrizd az Elküldött leveleket."
        with db:
            db.execute("UPDATE delivery SET state=?,note=? WHERE id=?",(state,note,row["id"]))
            if state=="sent":
                db.execute("UPDATE account SET resume_at=0,note='' WHERE singleton=1")
        return True


def worker():
    # EOF means the parent app closed. Finish the in-flight request before exiting.
    stop=threading.Event()
    def wait_parent():
        sys.stdin.buffer.read();stop.set()
    threading.Thread(target=wait_parent,daemon=True).start()
    closed=stop.wait
    while not closed(0):
        try:
            with lock("worker",nonblocking=True),database() as db:
                recover(db)
                while not closed(0):
                    if closed(.18 if step(db) else 2): return
        except (BlockingIOError,sqlite3.OperationalError,OSError):
            if closed(3): return


def cli(action,data):
    if action=="status": return status(data.get("batch",""),True)
    if action=="cancel": return cancel(data["batch"])
    if action=="disconnect": return disconnect()
    if action=="smtp": return connect(gmail.password_login(data["email"],data["password"]))
    if action=="oauth": return connect(gmail.oauth_login(data["client"]))
    raise ValueError("Ismeretlen Gmail-művelet.")


if __name__=="__main__":
    os.umask(0o077)
    try:
        if sys.argv[1]=="worker":
            worker()
        else:
            print(json.dumps({"result":cli(sys.argv[1],json.load(sys.stdin))},ensure_ascii=False),flush=True)
    except Exception as e:
        print(json.dumps({"error":str(e) if isinstance(e,ValueError) else "A Gmail-kapcsolat nem elérhető. Ellenőrizd a hálózatot és a rendszer kulcstartóját."}),flush=True)
        sys.exit(1)
