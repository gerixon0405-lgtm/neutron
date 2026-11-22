"""Gmail authorization and delivery. Secrets stay in the desktop keyring."""
import base64
import hashlib
import json
import os
import re
import secrets
import smtplib
import ssl
import sys
import time
from email.errors import HeaderParseError
from email import policy
from email.headerregistry import Address
from email.message import EmailMessage
from email.utils import formatdate
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlencode, urlsplit

import requests

SCOPES = ("https://www.googleapis.com/auth/gmail.send","https://www.googleapis.com/auth/userinfo.email")
TOKEN = "https://oauth2.googleapis.com/token"
SEND = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"


def address(value):
    if not isinstance(value,str) or not value.strip() or any(ord(c)<32 or ord(c)==127 for c in value):
        raise ValueError("Hiányzó vagy hibás e-mail-cím.")
    try:
        a = Address(addr_spec=value.strip())
        domain = a.domain.encode("idna").decode("ascii").lower()
        if not a.username or "." not in domain or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?",x) for x in domain.split(".")):
            raise ValueError()
        return Address(username=a.username,domain=domain).addr_spec
    except (ValueError,HeaderParseError,IndexError) as err:
        raise ValueError("Érvénytelen e-mail-cím: "+value[:120]) from err


def vault(slot, value=None, remove=False):
    if os.name=="nt":
        import keyring
        service="Neutron Gmail"
        if remove:
            if keyring.get_password(service,slot) is not None: keyring.delete_password(service,slot)
        elif value is not None:
            keyring.set_password(service,slot,json.dumps(value))
        else:
            stored=keyring.get_password(service,slot)
            return json.loads(stored) if stored else None
        return
    import gi
    gi.require_version("Secret","1")
    from gi.repository import Secret
    schema = Secret.Schema.new("app.neutron.Gmail",Secret.SchemaFlags.NONE,{"slot":Secret.SchemaAttributeType.STRING})
    attrs = {"slot":slot}
    if remove:
        Secret.password_clear_sync(schema,attrs,None)
    elif value is not None:
        if not Secret.password_store_sync(schema,attrs,Secret.COLLECTION_DEFAULT,"Neutron · Gmail",json.dumps(value),None):
            raise ValueError("A rendszer kulcstartója nem tudta menteni a hitelesítést.")
    else:
        result = Secret.password_lookup_sync(schema,attrs,None)
        return json.loads(result) if result else None


def smtp_login(email,password):
    client = smtplib.SMTP_SSL("smtp.gmail.com",465,timeout=15,context=ssl.create_default_context())
    try:
        client.login(email,password)
    except BaseException:
        client.close()
        raise
    return client


def password_login(email,password):
    email = address(email)
    password = "".join(password.split())
    if not re.fullmatch(r"[A-Za-z0-9]{16}",password):
        raise ValueError("A Google által kiadott 16 karakteres alkalmazásjelszót add meg.")
    try:
        client = smtp_login(email,password)
        client.close()
    except smtplib.SMTPAuthenticationError:
        raise ValueError("A Gmail elutasította az e-mail-címet vagy az alkalmazásjelszót.") from None
    return {"email":email,"method":"smtp","password":password}


def oauth_login(client):
    client_id,secret = client.get("client_id",""),client.get("client_secret","")
    if not client_id.endswith(".apps.googleusercontent.com") or not secret:
        raise ValueError("Google Desktop app típusú OAuth-kliens JSON-fájlját válaszd ki.")
    verifier,state = secrets.token_urlsafe(64),secrets.token_urlsafe(32)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    response = {}
    class Callback(BaseHTTPRequestHandler):
        def log_message(self,*args):
            pass

        def do_GET(self):
            u = urlsplit(self.path)
            q = parse_qs(u.query)
            ok = u.path=="/callback" and q.get("state")==[state] and self.headers.get("Host")==f"127.0.0.1:{self.server.server_port}"
            if ok:
                response.update(q)
            self.send_response(200 if ok else 400)
            self.send_header("Content-Type","text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(("Visszatérhetsz a Neutronba." if ok else "Érvénytelen kérés.").encode())
    with HTTPServer(("127.0.0.1",0),Callback) as server:
        server.timeout=1
        redirect=f"http://127.0.0.1:{server.server_port}/callback"
        url="https://accounts.google.com/o/oauth2/v2/auth?"+urlencode(dict(client_id=client_id,redirect_uri=redirect,
            scope=" ".join(SCOPES),response_type="code",state=state,code_challenge=challenge,
            code_challenge_method="S256",access_type="offline",prompt="consent select_account"))
        print(json.dumps({"open":url}),flush=True)
        until=time.monotonic()+180
        while not response and time.monotonic()<until:
            server.handle_request()
    if not response.get("code"):
        raise ValueError("A Google-bejelentkezés megszakadt vagy lejárt.")
    r=requests.post(TOKEN,data=dict(code=response["code"][0],client_id=client_id,client_secret=secret,
        grant_type="authorization_code",redirect_uri=redirect,code_verifier=verifier),timeout=15)
    if not r.ok:
        raise ValueError("A Google nem fogadta el a bejelentkezést. Ellenőrizd az OAuth-klienst.")
    auth=r.json()
    if not auth.get("refresh_token") or SCOPES[0] not in auth.get("scope","").split():
        raise ValueError("A Gmail küldési engedélye hiányzik.")
    profile=requests.get("https://www.googleapis.com/oauth2/v2/userinfo",headers={"Authorization":"Bearer "+auth["access_token"]},timeout=12)
    profile.raise_for_status()
    if not profile.json().get("verified_email"):
        raise ValueError("A Google-fiók e-mail-címe nincs ellenőrizve.")
    return {"email":address(profile.json()["email"]),"method":"oauth","client_id":client_id,"client_secret":secret,
            "refresh_token":auth["refresh_token"],"access_token":auth["access_token"],"expires":time.time()+auth["expires_in"]}


class DeliveryError(Exception):
    def __init__(self,state,note,delay=0):
        super().__init__(note)
        self.state,self.delay=state,delay


def deliver(credentials,slot,to,subject,body,message_id):
    msg=EmailMessage(policy=policy.SMTP)
    msg["From"],msg["To"],msg["Subject"]=credentials["email"],to,subject
    msg["Message-ID"],msg["Date"]=message_id,formatdate(localtime=False,usegmt=True)
    msg.set_content(body)
    if credentials["method"]=="smtp":
        return send_smtp(credentials,to,msg)
    return send_api(credentials,slot,msg)


def smtp_rejection(code,reason=b""):
    if b"5.4.5" in reason or b"daily user sending" in reason.lower():
        return DeliveryError("pending","Elérted a Gmail napi küldési korlátját.",86400)
    if code==535:
        return DeliveryError("auth","A Gmail-hitelesítés lejárt. Csatlakoztasd újra a fiókot.")
    if 400<=code<500:
        return DeliveryError("pending",f"A Gmail átmenetileg elutasította a küldést (SMTP {code}).",900)
    return DeliveryError("failed",f"A Gmail elutasította a levelet (SMTP {code}).")


def send_smtp(cred,to,msg):
    try:
        client=smtp_login(cred["email"],cred["password"])
    except smtplib.SMTPResponseException as e:
        raise smtp_rejection(e.smtp_code,e.smtp_error) from None
    except OSError:
        raise DeliveryError("pending","A Gmail SMTP-kapcsolat nem elérhető.",120) from None
    try:
        refused=client.send_message(msg,from_addr=cred["email"],to_addrs=[to])
        if refused:
            raise smtp_rejection(*next(iter(refused.values())))
    except smtplib.SMTPRecipientsRefused as e:
        raise smtp_rejection(*next(iter(e.recipients.values()))) from None
    except smtplib.SMTPResponseException as e:
        raise smtp_rejection(e.smtp_code,e.smtp_error) from None
    except (OSError,smtplib.SMTPServerDisconnected):
        raise DeliveryError("unknown","A kapcsolat megszakadt küldés közben. Ellenőrizd az Elküldött leveleket.") from None
    finally:
        client.close()


def send_api(cred,slot,msg):
    if time.time()+60>=cred["expires"]:
        try:
            r=requests.post(TOKEN,data={k:cred[k] for k in ("client_id","client_secret","refresh_token")} | {"grant_type":"refresh_token"},timeout=15)
        except requests.RequestException:
            raise DeliveryError("pending","A Google-hitelesítés átmenetileg nem elérhető.",120) from None
        if not r.ok:
            if r.status_code>=500 or r.status_code==429:
                raise DeliveryError("pending","A Google-hitelesítés átmenetileg nem elérhető.",180)
            raise DeliveryError("auth","A Google-engedély lejárt. Csatlakoztasd újra a fiókot.")
        data=r.json()
        cred.update(access_token=data["access_token"],expires=time.time()+data["expires_in"])
        vault(slot,cred)
    try:
        r=requests.post(SEND,headers={"Authorization":"Bearer "+cred["access_token"]},
            json={"raw":base64.urlsafe_b64encode(msg.as_bytes()).decode()},timeout=(10,30),allow_redirects=False)
    except requests.ConnectTimeout:
        raise DeliveryError("pending","A Gmail nem érhető el.",120) from None
    except requests.RequestException:
        raise DeliveryError("unknown","A Gmail visszajelzése elmaradt. Ellenőrizd az Elküldött leveleket.") from None
    if r.ok and r.json().get("id"):
        return
    text=r.text.lower()
    if r.status_code==429 or (r.status_code==403 and any(x in text for x in ("ratelimit","quota","dailylimit"))):
        wait=r.headers.get("Retry-After","")
        raise DeliveryError("pending","A Gmail küldési korlátja miatt a küldés szünetel.",max(60,int(wait)) if wait.isdigit() else 900)
    if r.status_code in (401,403):
        raise DeliveryError("auth","Ellenőrizd a Gmail API engedélyezését és a fiók küldési jogosultságát.")
    if r.status_code>=500 or r.status_code==408:
        raise DeliveryError("unknown","A Gmail nem igazolta a küldést. Ellenőrizd az Elküldött leveleket.")
    raise DeliveryError("failed",f"A Gmail elutasította a levelet (HTTP {r.status_code}).")
