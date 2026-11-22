"""Report the selected thumb button on readable Linux mouse devices."""
import ctypes
import fcntl
import glob
import json
import os
import selectors
import struct
import sys
import time

BUTTONS = {"Mouse4": 0x113, "Mouse5": 0x114}  # BTN_SIDE, BTN_EXTRA
EVENT = struct.Struct("@llHHi")
EV_KEY = 1


def emit(kind, label=""):
    print(json.dumps({"type": kind, "label": label}), flush=True)


def open_mouse(path, button):
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    try:
        keys = bytearray(96)
        fcntl.ioctl(fd, 0x80004521 | len(keys) << 16, keys, True)  # EVIOCGBIT(EV_KEY)
        if not keys[button // 8] & (1 << (button % 8)):
            os.close(fd)
            return None
        # EVIOCSMASK affects only this descriptor. Ignore motion, wheel and scan codes.
        for event_type in (EV_KEY, 2, 3, 4):
            mask = ctypes.create_string_buffer(len(keys))
            if event_type == EV_KEY:
                mask[button // 8] = 1 << (button % 8)
            fcntl.ioctl(fd, 0x40104593, struct.pack("IIQ", event_type, len(mask), ctypes.addressof(mask)))
        return fd
    except OSError:
        os.close(fd)
        raise


def watch(binding):
    button = BUTTONS[binding]
    label = "Egér 4 (vissza)" if binding == "Mouse4" else "Egér 5 (előre)"
    pressed = set()
    available = None
    with selectors.DefaultSelector() as poll:
        rescan = 0
        while True:
            if time.monotonic() >= rescan:
                paths = {os.path.realpath(p) for p in glob.glob("/dev/input/by-*/*-event-mouse")}
                existing = {key.data for key in poll.get_map().values()}
                for path in paths - existing:
                    try:
                        fd = open_mouse(path, button)
                    except OSError:
                        continue
                    if fd is not None:
                        poll.register(fd, selectors.EVENT_READ, path)
                rescan = time.monotonic() + 2
            ready = bool(poll.get_map())
            if ready != available:
                emit("ready" if ready else "unavailable", label)
                available = ready
            for key, _ in poll.select(max(0, rescan - time.monotonic())):
                try:
                    data = os.read(key.fd, EVENT.size * 64)
                except BlockingIOError:
                    continue
                except OSError:
                    data = b""
                if not data:
                    poll.unregister(key.fd)
                    os.close(key.fd)
                    if key.fd in pressed:
                        pressed.remove(key.fd)
                        if not pressed:
                            emit("cancel")
                    rescan = 0
                    continue
                for _, _, event_type, code, value in EVENT.iter_unpack(data):
                    if event_type != EV_KEY or code != button:
                        continue
                    if value == 1:
                        if not pressed:
                            emit("down")
                        pressed.add(key.fd)
                    elif value == 0 and key.fd in pressed:
                        pressed.remove(key.fd)
                        if not pressed:
                            emit("up")


if __name__ == "__main__":
    watch(sys.argv[1])
