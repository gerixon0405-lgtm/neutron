"""Request one user-authorized screenshot from the Wayland desktop portal."""
import sys
import uuid
from pathlib import Path
from urllib.parse import unquote, urlsplit
from gi.repository import Gio, GLib

service = "org.freedesktop.portal.Desktop"
bus = Gio.bus_get_sync(Gio.BusType.SESSION,None)
root = "/org/freedesktop/portal/desktop"
token = "neutron"+uuid.uuid4().hex
request = root+"/request/"+bus.get_unique_name()[1:].replace(".","_")+"/"+token
loop = GLib.MainLoop()
answer = []


def response(_bus,_sender,_path,_iface,_name,params):
    code,info = params.unpack()
    if code == 0 and info.get("uri"):
        parsed=urlsplit(info["uri"])
        if parsed.scheme=="file" and not parsed.netloc:
            answer.append(unquote(parsed.path))
    loop.quit()


def expired():
    try:
        bus.call_sync(service,request,"org.freedesktop.portal.Request","Close",None,None,Gio.DBusCallFlags.NONE,1500,None)
    except GLib.Error:
        pass
    loop.quit()
    return False


bus.signal_subscribe(service,"org.freedesktop.portal.Request","Response",request,None,Gio.DBusSignalFlags.NONE,response)
bus.call_sync(service,root,"org.freedesktop.portal.Screenshot","Screenshot",
              GLib.Variant("(sa{sv})",("",{"handle_token":GLib.Variant("s",token),"interactive":GLib.Variant("b",False)})),
              None,Gio.DBusCallFlags.NONE,10000,None)
GLib.timeout_add_seconds(35,expired)
loop.run()
if not answer or not Path(answer[0]).is_file():
    sys.exit("A rendszer nem adott át képernyőképet.")
print(answer[0])
