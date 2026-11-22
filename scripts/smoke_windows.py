from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import gmail, win_spotify
import ssl, sqlite3, requests, keyring, winpty
assert ssl.create_default_context() and sqlite3.sqlite_version
