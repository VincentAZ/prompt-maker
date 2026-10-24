# Builds the Windows installer: dist\prompt-maker-<version>-setup.exe
#   packaging\windows\build.ps1                         fetches Node (the newest 22.x, kept in packaging\windows\cache) and builds
#   packaging\windows\build.ps1 -NodeVersion v22.23.3   a pinned Node
# Needs Inno Setup 6 (winget install JRSoftware.InnoSetup). What the installer puts in, for the user who runs it and
# without administrator rights, under %LOCALAPPDATA%\Programs\Prompt Maker:
#   app\    the app, as in this repo (nothing from any data folder)
#   node\   Node.js, its own copy: nothing to install first, no version to get wrong
#   the uninstaller (Settings > Apps lists Prompt Maker)
# and, through the app's own set-up (lib\autostart.js install, the same the first start does): a Start menu entry,
# starting with the computer, and the promptmaker:// link for the page's Start button. LM Studio and ComfyUI are
# separate installs (see the README). Check the result with packaging\windows\check.ps1.
param([string]$NodeVersion = $env:NODE_VERSION)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $root
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$cache = Join-Path $root 'packaging\windows\cache'
$out = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $cache, $out | Out-Null

# Inno Setup's compiler: where winget puts it, where its own installer puts it, or on the PATH.
$iscc = @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { $cmd = Get-Command iscc -ErrorAction SilentlyContinue; if ($cmd) { $iscc = $cmd.Source } }
if (-not $iscc) { throw "Inno Setup 6 isn't installed. Get it with: winget install JRSoftware.InnoSetup" }

# Node: the newest 22.x unless pinned, checked against nodejs.org's checksums.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (-not $NodeVersion) {
  $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
  $NodeVersion = ($index | Where-Object { $_.version -like 'v22.*' -and $_.files -contains 'win-x64-zip' } | Select-Object -First 1).version
}
if (-not $NodeVersion) { throw "Couldn't find a Node 22 release to bundle." }
$zipName = "node-$NodeVersion-win-x64.zip"
$zip = Join-Path $cache $zipName
if (-not (Test-Path $zip)) {
  Write-Host "Fetching Node $NodeVersion..."
  Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$NodeVersion/$zipName" -OutFile "$zip.part"
  $sums = (Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$NodeVersion/SHASUMS256.txt").Content
  $want = ($sums -split "`n" | Where-Object { $_ -match ("\s" + [regex]::Escape($zipName) + "\s*$") } | Select-Object -First 1) -replace '\s.*$', ''
  $have = (Get-FileHash "$zip.part" -Algorithm SHA256).Hash
  if (-not $want -or $have.ToLower() -ne $want.ToLower()) { Remove-Item "$zip.part" -Force; throw "Node download didn't match its checksum." }
  Move-Item "$zip.part" $zip
}

# A fresh stage with app\ and node\, gone again after the build.
$stage = Join-Path $env:TEMP ('prompt-maker-stage-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$app = Join-Path $stage 'app'
New-Item -ItemType Directory -Force $app | Out-Null
try {
  # The app: what the repo ships, nothing else (no data folder, no tests, no screenshots).
  foreach ($f in 'server.js', 'package.json', 'start.bat', 'LICENSE', 'README.md', 'lib', 'public', 'playbooks', 'chains', 'workflows') { Copy-Item (Join-Path $root $f) $app -Recurse }
  New-Item -ItemType Directory -Force (Join-Path $app 'docs') | Out-Null
  Copy-Item (Join-Path $root 'docs\guide.md') (Join-Path $app 'docs') # the in-app assistant reads it (no screenshots or renders in the installer)
  Get-ChildItem $app -Recurse -Filter '*.tmp' | Remove-Item -Force
  # Node, without npm and its docs (the app has no dependencies).
  Expand-Archive $zip $stage
  Rename-Item (Join-Path $stage "node-$NodeVersion-win-x64") 'node'
  $node = Join-Path $stage 'node'
  foreach ($f in 'node_modules', 'npm', 'npm.cmd', 'npx', 'npx.cmd', 'corepack', 'corepack.cmd', 'CHANGELOG.md', 'README.md', 'install_tools.bat', 'nodevars.bat') {
    if (Test-Path (Join-Path $node $f)) { Remove-Item (Join-Path $node $f) -Recurse -Force }
  }
  & $iscc /Q "/DVersion=$version" "/DStage=$stage" "/DOut=$out" (Join-Path $PSScriptRoot 'prompt-maker.iss')
  if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed ($LASTEXITCODE)." }
} finally {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}
$exe = Join-Path $out "prompt-maker-$version-setup.exe"
Write-Host ("Built $exe ({0:N1} MB, Node $NodeVersion)" -f ((Get-Item $exe).Length / 1MB))
