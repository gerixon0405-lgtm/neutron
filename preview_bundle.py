"""Unpack a web build into a fresh preview directory."""
import shutil
import sys
import zipfile
from pathlib import Path, PurePosixPath

dest = Path(sys.argv[2])
with zipfile.ZipFile(sys.argv[1]) as z:
    files = z.infolist()
    if len(files)>5000 or sum(f.file_size for f in files)>48_000_000 or "index.html" not in z.namelist():
        sys.exit("Az archívumban nincs előnézetre alkalmas webes build.")
    for f in files:
        p = PurePosixPath(f.filename)
        if p.is_absolute() or any(s.startswith(".") for s in p.parts) or "\\" in f.filename or (f.external_attr >> 16) & 0o170000 == 0o120000:
            sys.exit("Az archívum nem biztonságos útvonalat tartalmaz.")
        if f.is_dir(): continue
        out = dest / p
        out.parent.mkdir(parents=True,exist_ok=True)
        with z.open(f) as src, out.open("xb") as dst:
            shutil.copyfileobj(src,dst)
