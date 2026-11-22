$ErrorActionPreference = 'Stop'
$base = (python -c "import sys;print(sys.base_prefix)").Trim()
$dest = Join-Path (Get-Location) 'build/python'
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item "$base/python.exe","$base/python*.dll","$base/vcruntime*.dll","$base/LICENSE.txt" -Destination $dest
Copy-Item "$base/DLLs" "$dest/DLLs" -Recurse
robocopy "$base/Lib" "$dest/Lib" /E /XD site-packages __pycache__ test idlelib tkinter ensurepip /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw 'Python standard library copy failed.' }
python -m pip install --disable-pip-version-check --only-binary=:all: --target "$dest/Lib/site-packages" -r scripts/windows-requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'Python dependencies failed.' }
& "$dest/python.exe" -c "import requests, psutil, keyring, winpty, winrt.windows.media.control, pycaw; import ssl, sqlite3; print('Bundled Python OK')"
if ($LASTEXITCODE -ne 0) { throw 'Bundled Python failed verification.' }
exit 0
