"""Read machine metrics and invoke the Windows-maintained drive optimization task."""
import os
from pathlib import Path
import json
import subprocess
import sys

from desktop_lock import file_lock

TASK = r"$task = @{TaskPath='\Microsoft\Windows\Defrag\';TaskName='ScheduledDefrag'};"
STATUS = """
$t=Get-ScheduledTask @task
$i=Get-ScheduledTaskInfo @task
@{state=[string]$t.State;last_run=$i.LastRunTime.ToString('s');last_result=$i.LastTaskResult} | ConvertTo-Json -Compress
"""
START = r"""
$t=Get-ScheduledTask @task
if ($t.State -eq 'Disabled') { throw 'A Windows meghajtóoptimalizálási feladata le van tiltva.' }
if ($t.State -notin 'Running','Queued') {
    try { Start-ScheduledTask @task -ErrorAction Stop }
    catch {
        if ($_.Exception.HResult -ne -2147024891 -and $_.CategoryInfo.Category -ne 'PermissionDenied') { throw }
        $p=Start-Process -FilePath "$env:SystemRoot\System32\schtasks.exe" -ArgumentList '/Run','/TN','\Microsoft\Windows\Defrag\ScheduledDefrag' -Verb RunAs -Wait -PassThru
        if ($p.ExitCode -ne 0) { throw "A Windows elutasította az indítást ($($p.ExitCode))." }
    }
}
"""


def powershell(script, timeout=50):
    command = Path(os.environ["SystemRoot"])/"System32/WindowsPowerShell/v1.0/powershell.exe"
    script = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$ErrorActionPreference='Stop';" + script
    p = subprocess.run([str(command),"-NoProfile","-NonInteractive","-Command",script],
                       capture_output=True,timeout=timeout,encoding="utf-8",errors="replace")
    if p.returncode:
        raise ValueError((p.stderr.strip() or "A Windows-feladat nem elérhető.").splitlines()[0])
    return json.loads(p.stdout)


def task(start=False):
    return powershell(TASK + (START if start else "") + STATUS)


def maintain(action):
    if os.name != "nt":
        raise ValueError("A Windows-karbantartás ezen az operációs rendszeren nem érhető el.")
    if action == "inspect":
        import psutil
        disk=psutil.disk_usage(Path(os.environ["SystemRoot"]).anchor)
        ram=psutil.virtual_memory()
        return {"cpu_percent_sample":psutil.cpu_percent(interval=1),"memory_percent":ram.percent,
                "available_memory_bytes":ram.available,"system_drive_free_bytes":disk.free,
                "system_drive_total_bytes":disk.total}
    if action not in ("optimize","status"):
        raise ValueError("Ismeretlen művelet.")
    status=task(action=="optimize")
    return {"operation":"Windows meghajtóoptimalizálás","start_requested":action=="optimize",**status}


def drivers(action, query="", offset="0"):
    if os.name != "nt":
        raise ValueError("Az illesztőprogramok kezelése Windowson érhető el.")
    if action == "updates":
        os.startfile("ms-settings:windowsupdate-optionalupdates")
        return {"opened":"Windows Update – választható frissítések"}
    if action == "install":
        return powershell(r"""
Add-Type -AssemblyName System.Windows.Forms
$d=New-Object System.Windows.Forms.OpenFileDialog
$d.Title='Neutron – telepítendő Windows-illesztőprogram kiválasztása'
$d.Filter='Illesztőprogram (*.inf)|*.inf'
if ($d.ShowDialog() -ne 'OK') { '{"state":"cancelled"}'; return }
$file=Get-Item -LiteralPath $d.FileName
if ($file.Extension -ine '.inf' -or $file.PSIsContainer) { throw 'Válassz egy INF-fájlt.' }
$p=Start-Process -FilePath "$env:SystemRoot\System32\pnputil.exe" -Verb RunAs -ArgumentList ('/add-driver "'+$file.FullName+'" /install') -PassThru -Wait
if ($p.ExitCode -notin 0,3010) { throw "A PnPUtil hibakódja: $($p.ExitCode)" }
@{state='package_processed';inf=$file.Name;restart_required=($p.ExitCode -eq 3010)} | ConvertTo-Json -Compress
""", timeout=300)
    if action not in ("list","problems"):
        raise ValueError("Ismeretlen illesztőprogram-művelet.")
    start=int(offset)
    if start < 0: raise ValueError("A kezdősorszám legyen legalább nulla.")
    if action == "list":
        script = "Get-CimInstance Win32_PnPSignedDriver | Select-Object DeviceName,DeviceClass,DriverProviderName,DriverVersion,InfName,IsSigned"
    else:
        script = "Get-CimInstance Win32_PnPEntity | Where-Object {$null -ne $_.ConfigManagerErrorCode -and $_.ConfigManagerErrorCode -ne 0} | Select-Object Name,PNPClass,ConfigManagerErrorCode,Status"
    rows=powershell("ConvertTo-Json -InputObject @("+script+") -Compress")
    matches=[r for r in rows if any(query.casefold() in str(v).casefold() for v in r.values())]
    matches.sort(key=lambda r:tuple(str(v or "") for v in r.values()))
    return {"total":len(matches),"items":matches[start:start+40],"next_offset":str(start+40) if start+40<len(matches) else None}


def optimize_system_drive():
    if os.name != "nt":
        raise ValueError("A meghajtóoptimalizálás Windowson érhető el.")
    lock = Path.home()/".neutron-optimize.lock"
    try:
        with file_lock(lock,nonblocking=True):
            before = maintain("inspect")
            result = powershell(r"""
$drive = $env:SystemDrive
if ($drive -notmatch '^[A-Z]:$') { throw 'Nem azonosítható a Windows rendszermeghajtója.' }
$p = Start-Process -FilePath "$env:SystemRoot\System32\defrag.exe" -ArgumentList $drive,'/O','/U' -Verb RunAs -PassThru -Wait
@{drive=$drive;exit_code=$p.ExitCode} | ConvertTo-Json -Compress
""",timeout=7200)
    except BlockingIOError:
        raise ValueError("A Neutron már futtat meghajtóoptimalizálást.") from None
    return {**result, "before":before}


if __name__ == "__main__":
    try:
        print(json.dumps(optimize_system_drive()))
    except subprocess.TimeoutExpired:
        print("Lejárt a várakozási idő. A Windows művelete még futhat.",file=sys.stderr)
        sys.exit(1)
    except (OSError,ValueError) as exc:
        print(str(exc),file=sys.stderr)
        sys.exit(1)
