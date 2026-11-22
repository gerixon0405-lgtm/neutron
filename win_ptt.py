"""Observe only the configured push-to-talk key or mouse button."""
import ctypes
import json
import sys
import time

parts=sys.argv[1].split("+")
keys={"CTRL":0x11,"ALT":0x12,"SHIFT":0x10,"LOGO":0x5B,"space":0x20,"Mouse4":5,"Mouse5":6}
keys.update({f"F{i}":0x6f+i for i in range(1,25)})
codes=[keys[p] if p in keys else ord(p.upper()) for p in parts]
read=ctypes.windll.user32.GetAsyncKeyState
held=False
print(json.dumps({"type":"ready","label":sys.argv[1]}),flush=True)
while True:
    now=all(read(c)&0x8000 for c in codes)
    if now!=held:
        print(json.dumps({"type":"down" if now else "up"}),flush=True)
        held=now
    time.sleep(.02)
