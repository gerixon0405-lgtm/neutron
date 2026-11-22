"""Forward only the assigned push-to-talk shortcut from the desktop portal."""
import json
import sys
import uuid
from gi.repository import Gio, GLib

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
loop = GLib.MainLoop()
service = "org.freedesktop.portal.Desktop"
root = "/org/freedesktop/portal/desktop"
interface = "org.freedesktop.portal.GlobalShortcuts"
session = None
shortcut = "neutron_talk_" + sys.argv[1].replace("+", "_")
pending = {}


def emit(kind, label=""):
    print(json.dumps({"type": kind, "label": label}), flush=True)


def request(method, params, token, callback):
    sender = bus.get_unique_name()[1:].replace(".", "_")
    expected = f"{root}/request/{sender}/{token}"
    pending[expected] = callback
    reply = bus.call_sync(service, root, interface, method, params, None,
                          Gio.DBusCallFlags.NONE, 10000, None)
    actual = reply.unpack()[0]
    if actual != expected:
        pending[actual] = pending.pop(expected)


def bound(data):
    for key, info in data.get("shortcuts", []):
        if key == shortcut:
            emit("ready", info.get("trigger_description", sys.argv[1]))
            return
    loop.quit()


def created(data):
    global session
    session = data["session_handle"]
    token = "bind" + uuid.uuid4().hex
    info = {"description": GLib.Variant("s", "Neutron – nyomva tartás a beszédhez"),
            "preferred_trigger": GLib.Variant("s", sys.argv[1])}
    args = GLib.Variant("(oa(sa{sv})sa{sv})", (session, [(shortcut, info)], "",
                        {"handle_token": GLib.Variant("s", token)}))
    request("BindShortcuts", args, token, bound)


def signal(_bus, _sender, path, iface, name, params):
    values = params.unpack()
    if iface == "org.freedesktop.portal.Request" and path in pending:
        callback = pending.pop(path)
        if values[0] != 0:
            loop.quit()
        else:
            try:
                callback(values[1])
            except (KeyError, GLib.Error):
                loop.quit()
    elif iface == interface and values[0] == session:
        if name == "ShortcutsChanged":
            bound({"shortcuts": values[1]})
        elif values[1] == shortcut and name in ("Activated", "Deactivated"):
            emit("down" if name == "Activated" else "up")
    elif iface == "org.freedesktop.portal.Session" and path == session and name == "Closed":
        loop.quit()


try:
    bus.call_sync(service, root, "org.freedesktop.host.portal.Registry", "Register",
                  GLib.Variant("(sa{sv})", ("neutron", {})), None, Gio.DBusCallFlags.NONE, 4000, None)
except GLib.Error:
    pass  # Older portals identify the caller without the registry.

for iface in (interface, "org.freedesktop.portal.Request", "org.freedesktop.portal.Session"):
    bus.signal_subscribe(service, iface, None, None, None, Gio.DBusSignalFlags.NONE, signal)
token = "start" + uuid.uuid4().hex
options = {k: GLib.Variant("s", token) for k in ("session_handle_token", "handle_token")}
request("CreateSession", GLib.Variant("(a{sv})", (options,)), token, created)
loop.run()
