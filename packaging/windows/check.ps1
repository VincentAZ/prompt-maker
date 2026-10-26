# Checks a built installer without touching your own set-up: installs it silently into a throwaway folder (with a
# throwaway data folder and Start menu, on its own port), waits for the Prompt Maker it starts, asks it for its
# version, checks it runs on the bundled Node and that the Start menu entry, the start-with-the-computer entry and
# the promptmaker:// link went where they should, then uninstalls it and checks that everything is gone again.
#   packaging\windows\check.ps1 [dist\prompt-maker-<version>-setup.exe]
#   packaging\windows\check.ps1 -UpdateFrom dist\prompt-maker-<older>-setup.exe [dist\prompt-maker-<version>-setup.exe]
#       installs the older one first, then has it update itself to the newer one the way Settings → ⬆ Updates does
#       (against a local stand-in for GitHub's release feed), and checks the result the same way.
# It refuses to run while Prompt Maker is installed on this computer: a second install would take over that one's
# uninstall entry. The promptmaker:// link in the registry is written and removed for real (there's only one).
param([string]$Setup, [string]$UpdateFrom)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $Setup) { $Setup = (Get-ChildItem (Join-Path $root 'dist\prompt-maker-*-setup.exe') | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName }
if (-not $Setup -or -not (Test-Path $Setup)) { throw "No installer found: build one with packaging\windows\build.ps1" }
$Setup = (Resolve-Path $Setup).Path
if ($UpdateFrom) { $UpdateFrom = (Resolve-Path $UpdateFrom).Path }
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{8F4E2C1A-6B7D-4A0E-9C3F-2D5B1E7A9C44}_is1'
if (Test-Path $uninstallKey) { throw "Prompt Maker is installed on this computer (Settings > Apps). Uninstall it first: the check would take over its uninstall entry." }
$port = 5398
$feedPort = 5397
foreach ($p in $port, $feedPort) {
  $busy = $true
  try { Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$p/" -TimeoutSec 2 | Out-Null } catch { $busy = $false }
  if ($busy) { throw "Something already answers on port $p; stop it first." }
}

$work = Join-Path $env:TEMP ('prompt-maker-check-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$dir = Join-Path $work 'pm'
$data = Join-Path $work 'data'
$appdata = Join-Path $work 'appdata'
New-Item -ItemType Directory -Force $dir, $data, $appdata | Out-Null
# The installer and everything it starts see a throwaway data folder and Start menu, the check's port, no LM Studio,
# and the local stand-in for the release feed (so nothing here ever asks GitHub).
$saved = @{ PORT = $env:PORT; PROMPT_MAKER_DATA = $env:PROMPT_MAKER_DATA; APPDATA = $env:APPDATA; LMS_BIN = $env:LMS_BIN; PM_DESKTOP_DIR = $env:PM_DESKTOP_DIR; PM_UPDATE_FEED = $env:PM_UPDATE_FEED; PM_NO_FIRST_SETUP = $env:PM_NO_FIRST_SETUP }
$env:PORT = "$port"; $env:PROMPT_MAKER_DATA = $data; $env:APPDATA = $appdata; $env:LMS_BIN = Join-Path $work 'no-lms.exe'; $env:PM_UPDATE_FEED = "http://127.0.0.1:$feedPort/feed"
$env:PM_DESKTOP_DIR = Join-Path $work 'Desktop'
$env:PM_NO_FIRST_SETUP = '1' # the first-start set-up (ComfyUI, LM Studio, a Brain: gigabytes) is not for a throwaway copy
$lnk = Join-Path $appdata 'Microsoft\Windows\Start Menu\Programs\Prompt Maker.lnk'
$desktopLnk = Join-Path $env:PM_DESKTOP_DIR 'Prompt Maker.lnk'
$vbs = Join-Path $appdata 'Microsoft\Windows\Start Menu\Programs\Startup\Prompt Maker.vbs'
$ok = $false
$feed = $null
function Fail($msg) { throw "FAILED: $msg" }
function Install-Silently($exe, $log) {
  # Not Start-Process -Wait: that waits for every descendant too, and the installer starts Prompt Maker.
  $p = Start-Process $exe -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=`"$dir`"", "/LOG=`"$log`"" -PassThru
  $p.WaitForExit()
  if ($p.ExitCode -ne 0) { Fail "the installer exited with $($p.ExitCode); see $log" }
}
function Wait-Version($seconds) { # the version the app on the check's port answers with, once it does
  for ($i = 0; $i -lt $seconds; $i++) {
    Start-Sleep 1
    try { return (Invoke-RestMethod "http://127.0.0.1:$port/api/settings" -TimeoutSec 2).version } catch {}
  }
  return $null
}
function Wait-Down($seconds) {
  for ($i = 0; $i -lt $seconds; $i++) {
    try { Invoke-RestMethod "http://127.0.0.1:$port/api/settings" -TimeoutSec 2 | Out-Null } catch { return $true }
    Start-Sleep 1
  }
  return $false
}
# The node.exe processes running from the install's own Node (CIM: Get-Process's Path comes back empty at times).
function Server-Processes { @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.ExecutablePath -like "$dir\node\*" }) }
try {
  $first = if ($UpdateFrom) { $UpdateFrom } else { $Setup }
  Write-Host "Installing $first into $dir (silently)..."
  Install-Silently $first (Join-Path $work 'install.log')
  $nodeVersion = & (Join-Path $dir 'node\node.exe') --version
  # A silent install starts Prompt Maker in the background: wait for it to answer.
  $version = Wait-Version 60
  if (-not $version) { Fail "the installed Prompt Maker didn't answer on port $port" }
  if ((Server-Processes).Count -eq 0) { Fail "no node.exe from $dir\node is running: it ran with another Node" }

  if ($UpdateFrom) {
    # The newer installer, served the way GitHub's release feed would, by a Node copied out of the install (the
    # update stops every node.exe under the install folder, so the feed can't run from there).
    $newVersion = [regex]::Match([IO.Path]::GetFileName($Setup), 'prompt-maker-(.+)-setup\.exe').Groups[1].Value
    if (-not $newVersion) { Fail "can't read a version from the name $Setup" }
    $feedDir = Join-Path $work 'feed'
    New-Item -ItemType Directory -Force $feedDir | Out-Null
    Copy-Item (Join-Path $dir 'node\node.exe') $feedDir
    @'
import http from "node:http";
import fs from "node:fs";
const [file, version, port] = process.argv.slice(2);
const name = file.split(/[\\/]/).pop();
http.createServer((req, res) => {
  if (req.url === "/feed") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ tag_name: `v${version}`, html_url: "http://127.0.0.1/releases", assets: [{ name, browser_download_url: `http://127.0.0.1:${port}/file`, size: fs.statSync(file).size }] }));
  } else if (req.url === "/file") {
    res.setHeader("content-type", "application/octet-stream");
    fs.createReadStream(file).pipe(res);
  } else { res.statusCode = 404; res.end(); }
}).listen(Number(port), "127.0.0.1");
'@ | Set-Content (Join-Path $feedDir 'feed.mjs') -Encoding ASCII
    $feed = Start-Process (Join-Path $feedDir 'node.exe') -ArgumentList (Join-Path $feedDir 'feed.mjs'), $Setup, $newVersion, $feedPort -WindowStyle Hidden -PassThru
    Start-Sleep 1
    Write-Host "Updating $version to $newVersion the way Settings > Updates does..."
    $check = Invoke-RestMethod -Method Post "http://127.0.0.1:$port/api/update/check"
    if ($check.how -ne 'windows' -or -not $check.newer -or $check.latest -ne $newVersion -or -not $check.asset) { Fail "the check didn't find the newer installer: $($check | ConvertTo-Json -Compress)" }
    $apply = (Invoke-WebRequest -UseBasicParsing -Method Post "http://127.0.0.1:$port/api/update/apply" -TimeoutSec 600).Content
    if ($apply -is [byte[]]) { $apply = [Text.Encoding]::UTF8.GetString($apply) } # a stream of JSON lines comes back as bytes
    $done = ($apply -split "`n" | Where-Object { $_ -like '*"done"*' } | Select-Object -Last 1)
    if (-not $done -or ($done | ConvertFrom-Json).restart -ne 'installer') { Fail "the update didn't hand over to the installer: $apply" }
    if (-not (Wait-Down 60)) { Fail "the old copy kept running after the update" }
    $version = Wait-Version 180
    if ($version -ne $newVersion) { Fail "after the update the app answers with '$version', not $newVersion" }
    if ((Server-Processes).Count -eq 0) { Fail "after the update no node.exe from $dir\node is running" }
    $nodeVersion = & (Join-Path $dir 'node\node.exe') --version
  }

  if (-not (Test-Path $lnk)) { Fail "no Start menu entry at $lnk" }
  if (-not (Test-Path $desktopLnk)) { Fail "no desktop entry at $desktopLnk" }
  $target = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk).TargetPath
  if ($target -ne (Join-Path $dir 'app\start.bat')) { Fail "the Start menu entry opens $target" }
  if (-not (Test-Path $vbs)) { Fail "no start-with-the-computer entry at $vbs" }
  $link = (Get-ItemProperty 'HKCU:\Software\Classes\promptmaker\shell\open\command' -ErrorAction SilentlyContinue).'(default)'
  if ($link -ne ('"' + (Join-Path $dir 'app\start.bat') + '" "%1"')) { Fail "the promptmaker:// link runs: $link" }
  $how = (Invoke-RestMethod "http://127.0.0.1:$port/api/update").how
  if ($how -ne 'windows') { Fail "Settings > Updates takes this for '$how', not an installed copy" }
  if (-not (Test-Path (Join-Path $data 'renders'))) { Fail "the app didn't use the data folder it was given" }
  if (Test-Path (Join-Path $root 'data')) { Fail "the app wrote into the repo's own folder" }
  # Stop it the way Settings > Services does, then uninstall.
  function Pids { (Server-Processes | ForEach-Object { "$($_.ProcessId) since $($_.CreationDate.ToString('HH:mm:ss'))" }) -join ', ' }
  $before = Pids
  try { Invoke-RestMethod -Method Post "http://127.0.0.1:$port/api/services/app/stop" | Out-Null } catch { Fail "the stop request failed: $($_.Exception.Message)" }
  if (-not (Wait-Down 15)) { Fail "Prompt Maker didn't stop when asked (node.exe before the stop: $before; now: $(Pids))" }
  Start-Sleep 1
  if ((Server-Processes).Count -gt 0) { Fail "a node.exe from $dir\node is still running after the stop" }
  Write-Host "Uninstalling..."
  $u = Start-Process (Join-Path $dir 'unins000.exe') -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -PassThru
  $u.WaitForExit()
  if ($u.ExitCode -ne 0) { Fail "the uninstaller exited with $($u.ExitCode)" }
  Start-Sleep 2 # the uninstaller's copy of itself removes the last files once it's done
  if (Test-Path $uninstallKey) { Fail "the uninstall entry stayed" }
  if (Test-Path 'HKCU:\Software\Classes\promptmaker') { Fail "the promptmaker:// link stayed" }
  if (Test-Path $lnk) { Fail "the Start menu entry stayed" }
  if (Test-Path $desktopLnk) { Fail "the desktop entry stayed" }
  if (Test-Path $vbs) { Fail "the start-with-the-computer entry stayed" }
  if (Test-Path (Join-Path $dir 'app\server.js')) { Fail "the app's files stayed in $dir" }
  if (-not (Test-Path (Join-Path $data 'renders'))) { Fail "the uninstall took the data folder" }
  $ok = $true
  $did = if ($UpdateFrom) { "installs $([IO.Path]::GetFileName($UpdateFrom)) and updates it from Settings to" } else { "installs" }
  Write-Host "OK: $did Prompt Maker $version with its own Node ($nodeVersion), Start menu and desktop entries, the Startup entry and the promptmaker:// link, and uninstalls clean."
} finally {
  if ($feed -and -not $feed.HasExited) { Stop-Process -Id $feed.Id -Force -ErrorAction SilentlyContinue }
  if ($UpdateFrom) { Remove-Item (Join-Path $env:TEMP ([IO.Path]::GetFileName($Setup))) -Force -ErrorAction SilentlyContinue } # the update's download
  foreach ($k in $saved.Keys) { if ($null -eq $saved[$k]) { Remove-Item "Env:$k" -ErrorAction SilentlyContinue } else { Set-Item "Env:$k" $saved[$k] } }
  if ($ok) { Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue } else { Write-Host "Left for a look: $work (install.log is there)" }
}
