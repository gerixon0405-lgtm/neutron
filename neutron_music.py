"""Drive the desktop player via MPRIS and its installed Bonnie Spicetify extension."""
from desktop_lock import file_lock
import spotify_api
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlsplit

LOCAL = ("status","launch","play","pause","toggle","next","previous","stop","seek","volume","repeat","shuffle","open",
         "play_song","play_playlist","list_playlists","create_playlist","add_to_playlist","queue","like",
         "remove_from_playlist","rename_playlist","delete_playlist")


def running():
    if os.name=="nt":
        import psutil
        return any((p.info["name"] or "").lower()=="spotify.exe" for p in psutil.process_iter(["name"]))
    from gi.repository import Gio, GLib
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    return bus.call_sync("org.freedesktop.DBus","/org/freedesktop/DBus","org.freedesktop.DBus","NameHasOwner",
                         GLib.Variant("(s)",("org.mpris.MediaPlayer2.spotify",)),None,Gio.DBusCallFlags.NONE,2500,None).unpack()[0]


def launch():
    if running():
        return
    executable = shutil.which("spotify")
    args = [executable] if executable else ["flatpak","run","com.spotify.Client"]
    if os.name=="nt":
        os.startfile("spotify:");p=None
    else: p = subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
    for _ in range(60):
        if running():
            return
        if p and p.poll() not in (None,0):
            break
        time.sleep(.25)
    raise ValueError("A Spotify nem jelentkezett be asztali lejátszóként. Ellenőrizd, hogy elindult-e.")


def uri(value):
    if value.startswith("https://open.spotify.com/"):
        parts = urlsplit(value).path.strip("/").split("/")
        value = "spotify:" + ":".join(parts[-2:])
    if not re.fullmatch(r"spotify:(track|episode|album|artist|playlist|show):[A-Za-z0-9]{22}", value):
        raise ValueError("Adj meg érvényes Spotify-linket vagy URI-t.")
    return value


def transport(action, value):
    if os.name=="nt":
        import asyncio
        from win_spotify import control
        return asyncio.run(control(action,value))
    from gi.repository import Gio, GLib
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    player = "org.mpris.MediaPlayer2.Player"
    def call(interface, method, args=None):
        result = bus.call_sync("org.mpris.MediaPlayer2.spotify", "/org/mpris/MediaPlayer2", interface, method,
                               args, None, Gio.DBusCallFlags.NONE, 3500, None)
        return result.unpack()
    def prop(key):
        return call("org.freedesktop.DBus.Properties", "Get", GLib.Variant("(ss)", (player, key)))[0]
    methods = dict(play="Play", pause="Pause", toggle="PlayPause", next="Next", previous="Previous", stop="Stop")
    if action in methods:
        call(player, methods[action])
    elif action == "open":
        call(player, "OpenUri", GLib.Variant("(s)", (uri(value),)))
    elif action == "seek":
        call(player, "SetPosition", GLib.Variant("(ox)", (prop("Metadata")["mpris:trackid"], max(0, int(float(value)*1e6)))))
    elif action in ("volume","repeat","shuffle"):
        if action == "volume":
            val = float(value)
            if not 0 <= val <= 100:
                raise ValueError("A hangerő 0 és 100 közötti szám.")
            key, variant = "Volume", GLib.Variant("d",val/100)
        elif action == "repeat" and value in ("None","Track","Playlist"):
            key, variant = "LoopStatus", GLib.Variant("s",value)
        elif action == "shuffle" and value in ("on","off"):
            key, variant = "Shuffle", GLib.Variant("b",value == "on")
        else:
            raise ValueError("Érvénytelen lejátszási beállítás.")
        call("org.freedesktop.DBus.Properties", "Set", GLib.Variant("(ssv)", (player,key,variant)))
    elif action == "status":
        meta = prop("Metadata")
        return {"status":prop("PlaybackStatus"), "track":meta.get("xesam:title"), "artist":meta.get("xesam:artist"),
                "album":meta.get("xesam:album"), "url":meta.get("xesam:url")}
    else:
        raise ValueError("Ismeretlen művelet.")
    return "Végrehajtva."



ORIGIN = "https://xpui.app.spotify.com"


def bridge(command):
    # The installed Bonnie extension polls /next, then acknowledges the command ID on /result.
    job = {**command, "id":secrets.token_urlsafe(24)}
    answer = {}
    sent = False

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, status, data=b""):
            self.send_response(status)
            self.send_header("Access-Control-Allow-Origin", ORIGIN)
            self.send_header("Access-Control-Allow-Methods","GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers","Content-Type")
            self.send_header("Access-Control-Allow-Private-Network","true")
            self.send_header("Content-Type","application/json")
            self.send_header("Content-Length",str(len(data)))
            self.end_headers()
            if data:
                self.wfile.write(data)

        def trusted(self):
            return self.headers.get("Origin") == ORIGIN and self.headers.get("Host") == "127.0.0.1:47811"

        def do_OPTIONS(self):
            self.reply(204 if self.trusted() else 403)

        def do_GET(self):
            nonlocal sent
            if not self.trusted() or self.path != "/next":
                return self.reply(403)
            if sent:
                return self.reply(204)
            sent = True
            self.reply(200,json.dumps(job).encode())

        def do_POST(self):
            if not self.trusted() or not sent or self.path != "/result":
                return self.reply(403)
            try:
                length = int(self.headers.get("Content-Length","0"))
                if not 0 < length <= 131072:
                    return self.reply(400)
                result = json.loads(self.rfile.read(length))
                if result.get("id") != job["id"]:
                    return self.reply(403)
                answer.update(result)
            except (OSError, ValueError, AttributeError):
                return self.reply(400)
            self.reply(204)

    # Each Neutron chat has a separate MCP process. Serialize their transactions.
    cache = Path.home()/".cache"/"neutron"
    cache.mkdir(mode=0o700,parents=True,exist_ok=True)
    with file_lock(cache/"spotify.lock"):
        try:
            server = HTTPServer(("127.0.0.1",47811),Handler)
        except OSError as exc:
            raise ValueError("A Spotify helyi vezérlőjét éppen másik alkalmazás használja.") from exc
        with server:
            server.timeout = .5
            deadline = time.monotonic() + 20
            while not answer and time.monotonic() < deadline:
                server.handle_request()
    if not answer:
        raise ValueError("A Spotify átvette a kérést, de nem igazolta a végrehajtást. Ellenőrizd az appban." if sent
                         else "A Spotify Bonnie bővítménye nem válaszol. Nyisd meg a telepített Spicetify-os Spotifyt.")
    if answer.get("ok") is not True:
        raise ValueError(str(answer.get("msg") or "A Spotify elutasította a műveletet."))
    return str(answer.get("msg") or "Végrehajtva.")


def local(action, value="", track=""):
    if action not in LOCAL:
        raise ValueError("Ismeretlen Spotify-művelet.")
    if action in ("remove_from_playlist","rename_playlist","delete_playlist"):
        return spotify_api.edit(action,value,track)
    if action == "list_playlists" and spotify_api.vault(spotify_api.SLOT):
        return spotify_api.edit(action)
    if action == "status" and not running():
        return {"status":"A Spotify nem fut."}
    if action in ("launch","play","open","play_song","play_playlist","list_playlists","create_playlist","add_to_playlist","queue","like"):
        launch()
    if action == "launch":
        return "A Spotify fut."
    if action in ("play_song","play_playlist","create_playlist","add_to_playlist") and not value.strip():
        raise ValueError("Add meg a dal vagy a lejátszási lista nevét.")
    if action in ("play_song","queue","like"):
        return bridge({"action":"play" if action == "play_song" else action,"query":value})
    if action in ("play_playlist","list_playlists","create_playlist","add_to_playlist"):
        return bridge({"action":action,"name":value,"query":track if action == "add_to_playlist" else ""})
    return transport(action,value)


if __name__ == "__main__":
    try:
        if sys.argv[1] not in ("status","launch"):
            raise ValueError("Ismeretlen művelet.")
        print(json.dumps(local(sys.argv[1]),ensure_ascii=False))
    except Exception as error:
        sys.exit(str(error))
