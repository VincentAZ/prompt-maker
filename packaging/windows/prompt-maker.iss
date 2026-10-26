; Prompt Maker's Windows installer (Inno Setup 6). Built by packaging\windows\build.ps1, which passes
;   /DVersion=1.2.3   /DStage=<a folder holding app\ and node\>   /DOut=<the dist folder>
; Per user, no administrator rights: the app and its own Node.js go under %LOCALAPPDATA%\Programs\Prompt Maker, the
; app's own set-up (lib\autostart.js) puts it in the Start menu and on the desktop, starts it with the computer and registers the
; promptmaker:// link, and the uninstaller takes all of that out again. The data folder (%APPDATA%\Prompt Maker) is
; never touched: it's the user's work.
#ifndef Version
  #error Build it with packaging\windows\build.ps1
#endif

[Setup]
AppId={{8F4E2C1A-6B7D-4A0E-9C3F-2D5B1E7A9C44}
AppName=Prompt Maker
AppVersion={#Version}
AppVerName=Prompt Maker {#Version}
AppPublisher=Serpico Enterprises LLC
AppPublisherURL=https://github.com/VincentAZ/prompt-maker
AppSupportURL=https://github.com/VincentAZ/prompt-maker/blob/main/docs/guide.md
AppUpdatesURL=https://github.com/VincentAZ/prompt-maker/releases
VersionInfoVersion={#Version}
DefaultDirName={userpf}\Prompt Maker
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#Out}
OutputBaseFilename=prompt-maker-{#Version}-setup
SetupIconFile={#Stage}\app\public\icons\prompt-maker.ico
UninstallDisplayIcon={app}\app\public\icons\prompt-maker.ico
UninstallDisplayName=Prompt Maker
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
; A running Prompt Maker is stopped by this script (below), not by Windows' restart manager.
CloseApplications=no

[Files]
Source: "{#Stage}\app\*"; DestDir: "{app}\app"; Flags: recursesubdirs ignoreversion
Source: "{#Stage}\node\*"; DestDir: "{app}\node"; Flags: recursesubdirs ignoreversion

[Run]
; The app's own set-up, as the first start would do it: Start menu and desktop entries, start with the computer, the promptmaker:// link.
Filename: "{app}\node\node.exe"; Parameters: """{app}\app\lib\autostart.js"" install"; WorkingDir: "{app}\app"; StatusMsg: "Putting Prompt Maker in your Start menu..."; Flags: runhidden waituntilterminated
; A silent install (an update from Settings) brings Prompt Maker back up on its own; an interactive one offers to open it.
; skipifsilent matters: a postinstall entry runs in a silent install too, and without it an update started Prompt Maker
; twice (two launchers racing for the port) and opened a window nobody asked for.
Filename: "{app}\app\start.bat"; Parameters: "--background"; WorkingDir: "{app}\app"; Flags: runhidden nowait; Check: WizardSilent
Filename: "{app}\app\start.bat"; WorkingDir: "{app}\app"; Description: "Open Prompt Maker"; Flags: postinstall nowait runhidden skipifsilent

[UninstallRun]
; Takes the Start menu entry, the Startup entry and the link out, the way start.bat --uninstall does.
Filename: "{app}\node\node.exe"; Parameters: """{app}\app\lib\autostart.js"" uninstall"; WorkingDir: "{app}\app"; Flags: runhidden waituntilterminated; RunOnceId: "setup"

[Code]
// Stops the Prompt Maker running from this folder (an update over a running copy, or the uninstall), so its files
// can be replaced or removed. Only node.exe from this folder: a Node of your own is left alone.
procedure StopPromptMaker();
var
  R: Integer;
begin
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like ''' + ExpandConstant('{app}') + '\*'' } | Stop-Process -Force"',
    '', SW_HIDE, ewWaitUntilTerminated, R);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopPromptMaker();
  Result := '';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    StopPromptMaker();
  if CurUninstallStep = usPostUninstall then
    SuppressibleMsgBox('Prompt Maker is removed. Your pictures, videos, playbooks and settings stay in your data folder (' + ExpandConstant('{userappdata}') + '\Prompt Maker); ComfyUI and LM Studio stay too.', mbInformation, MB_OK, IDOK);
end;
