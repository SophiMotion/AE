$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
$projectRoot = $PSScriptRoot
$pythonExe = Join-Path $projectRoot '.tools\venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonExe)) { throw '请先运行 install.ps1 安装依赖。' }
Set-Location -LiteralPath $projectRoot
& $pythonExe -m server.app
