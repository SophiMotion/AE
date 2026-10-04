$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
Set-Location -LiteralPath $projectRoot
if (-not (Test-Path -LiteralPath '.tools\venv\Scripts\python.exe')) { python -m venv '.tools\venv' }
& '.tools\venv\Scripts\python.exe' -m pip install --cache-dir '.tools\pip-cache' -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'Python 依赖安装失败。' }
$env:npm_config_cache = Join-Path $projectRoot '.tools\npm-cache'
Set-Location -LiteralPath (Join-Path $projectRoot 'web')
npm install --prefer-offline --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw '网页依赖安装失败。' }
npm run build
if ($LASTEXITCODE -ne 0) { throw '网页构建失败。' }
