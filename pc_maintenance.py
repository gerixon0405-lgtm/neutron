"""Read machine metrics and invoke the Windows-maintained drive optimization task."""
import os
from pathlib import Path
import json
import subprocess

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


def task(start=False):
    command = Path(os.environ["SystemRoot"])/"System32/WindowsPowerShell/v1.0/powershell.exe"
    script = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$ErrorActionPreference='Stop';" + TASK + (START if start else "") + STATUS
    p = subprocess.run([str(command),"-NoProfile","-NonInteractive","-Command",script],
                       capture_output=True,timeout=50,encoding="utf-8",errors="replace")
    if p.returncode:
        raise ValueError((p.stderr.strip() or "A Windows-feladat nem elérhető.").splitlines()[0])
    return json.loads(p.stdout)


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
