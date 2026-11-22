$ErrorActionPreference = 'Stop'
$exe = (Get-ChildItem dist/*.exe).FullName
$dest = "$env:RUNNER_TEMP\NeutronSmoke"
$p = Start-Process $exe -ArgumentList "/S","/D=$dest" -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "NSIS returned $($p.ExitCode)" }
$p = Start-Process "$dest\Neutron.exe" -ArgumentList '--remote-debugging-port=19283' -PassThru
try {
  node scripts/probe-ui.js
  if ($LASTEXITCODE -ne 0) { throw 'UI smoke test failed' }
} finally { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
