"""Bridge a Windows ConPTY to xterm.js."""
import codecs
import json
import os
import shutil
import sys
import threading
from winpty import PtyProcess

args=sys.argv[3:]
args[0]=shutil.which(args[0]) or args[0]
proc=PtyProcess.spawn(args,dimensions=(int(sys.argv[2]),int(sys.argv[1])),cwd=os.getcwd(),env=os.environ.copy())

def input_loop():
    try:
        for line in sys.stdin:
            msg=json.loads(line)
            if "text" in msg: proc.write(msg["text"])
            else: proc.setwinsize(int(msg["rows"]),int(msg["cols"]))
    finally:
        if proc.isalive(): proc.terminate(force=True)

threading.Thread(target=input_loop,daemon=True).start()
try:
    while True:
        data=proc.read()
        if not data: break
        sys.stdout.buffer.write(data.encode("utf-8"));sys.stdout.buffer.flush()
except EOFError:
    pass
