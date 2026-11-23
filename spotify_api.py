"""Playlist changes through the Spotify account API, shared with the desktop client."""
import json
import re
import sys
import time

import requests
from gmail import vault

SLOT = "spotify-playlists"
TOKEN = "https://accounts.spotify.com/api/token"
BASE = "https://api.spotify.com/v1"
ACTIONS = ("remove_from_playlist","rename_playlist","delete_playlist","list_playlists")


def save_token(client_id, auth, previous=None):
    credentials = {"client_id":client_id,"access_token":auth["access_token"],
                   "expires":time.time()+auth["expires_in"],"refresh_token":auth.get("refresh_token",previous)}
    if not credentials["refresh_token"]:
        raise ValueError("A Spotify nem küldött frissítési tokent.")
    vault(SLOT,credentials)
    return credentials


def request(method, endpoint, **options):
    cred = vault(SLOT)
    if not cred:
        raise ValueError("Előbb engedélyezd a Spotifyt a Neutron Beállítások → Kapcsolatok lapján.")
    if cred["expires"] <= time.time()+45:
        r = requests.post(TOKEN,data={"grant_type":"refresh_token","refresh_token":cred["refresh_token"],
                                      "client_id":cred["client_id"]},timeout=15)
        if not r.ok:
            raise ValueError(f"A Spotify hitelesítésének megújítása sikertelen (HTTP {r.status_code}).")
        cred = save_token(cred["client_id"],r.json(),cred["refresh_token"])
    r = requests.request(method,BASE+endpoint,headers={"Authorization":"Bearer "+cred["access_token"]},
                         timeout=15,allow_redirects=False,**options)
    if r.status_code == 429:
        raise ValueError("Spotify HTTP 429: túl sok kérés.")
    if not r.ok:
        raise ValueError(f"A Spotify elutasította a műveletet (HTTP {r.status_code}). Ellenőrizd a playlistet és a fiók jogosultságát.")
    return r.json() if r.content else {}


def pages(endpoint):
    offset = 0
    while True:
        result = request("GET",endpoint,params={"limit":50,"offset":offset})
        items = result["items"]
        yield from (item for item in items if item)
        if not items or not result.get("next"):
            return
        offset += len(items)


def playlist(value):
    match = re.fullmatch(r"(?:spotify:playlist:|https://open.spotify.com/playlist/)?([a-zA-Z0-9]{22})(?:\?[^#]*)?",value)
    if match:
        return match[1]
    matches = [p for p in pages("/me/playlists") if p["name"].casefold() == value.casefold()]
    if len(matches) != 1:
        raise ValueError("A playlist neve hiányzik vagy nem egyértelmű. Add meg a Spotify-linkjét.")
    return matches[0]["id"]


def edit(action,value="",track=""):
    if action == "list_playlists":
        return [{"name":p["name"],"url":"https://open.spotify.com/playlist/"+p["id"]} for p in pages("/me/playlists")]
    if action not in ACTIONS or not value.strip():
        raise ValueError("Add meg a lejátszási lista nevét vagy Spotify-linkjét.")
    pid = playlist(value.strip())
    endpoint = "/playlists/"+pid
    if action == "rename_playlist":
        if not track.strip():
            raise ValueError("Add meg a lejátszási lista új nevét.")
        request("PUT",endpoint,json={"name":track.strip()})
        return {"playlist_id":pid,"name":track.strip()}
    if action == "delete_playlist":
        request("DELETE","/me/library",params={"uris":"spotify:playlist:"+pid})
        return {"playlist_id":pid,"removed_from_library":True}
    from neutron_music import uri
    try:
        song = uri(track)
        if not song.startswith(("spotify:track:","spotify:episode:")):
            raise ValueError("Adj meg egy dal- vagy epizódlinket.")
    except ValueError:
        if not track.strip() or track.startswith(("http","spotify:")):
            raise ValueError("Add meg a dal nevét vagy Spotify-linkjét.") from None
        matches = set()
        for row in pages(endpoint+"/items"):
            item = row.get("item") or row.get("track") or {}
            if item.get("name","").casefold() == track.strip().casefold() and item.get("uri"):
                matches.add(item["uri"])
        if len(matches) != 1:
            raise ValueError("A dal nem egyértelmű ebben a playlistben. Add meg a Spotify-linkjét.")
        song = matches.pop()
    answer = request("DELETE",endpoint+"/items",json={"items":[{"uri":song}]})
    return {"playlist_id":pid,"removed_uri":song,"snapshot_id":answer.get("snapshot_id")}


if __name__ == "__main__":
    try:
        action=sys.argv[1]
        if action == "store":
            data=json.load(sys.stdin)
            save_token(data["clientId"],data["token"])
        elif action == "disconnect":
            vault(SLOT,remove=True)
        print(json.dumps({"connected": bool(vault(SLOT))}))
    except Exception as error:
        sys.exit(str(error))
