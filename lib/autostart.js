// Setting Prompt Maker up on the computer, so nobody needs a terminal: an app-menu entry, a promptmaker:// link
// (the offline page's Start button opens it), and a background service that starts it at login, keeps it
// running and turns on LM Studio's server. One module for every platform: Linux is done; Windows has a Start menu
// entry, the link and a start-with-the-computer entry (written, not yet tried on a real Windows PC); macOS reports
// supported: false until its part is written.
//
// Also a small command line for the launchers:  node lib/autostart.js install [--now] | uninstall | status | first-run
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const NAME = 'prompt-maker';
export const LINK = 'promptmaker://start';

const configHome = () => process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const dataHome = () => process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
const files = () => ({
  unit: path.join(configHome(), 'systemd', 'user', `${NAME}.service`),
  desktop: path.join(dataHome(), 'applications', `${NAME}.desktop`),
  declined: path.join(configHome(), NAME, 'no-auto-setup'), // you undid the setup: don't redo it on the next start
});
const SYSTEMCTL = () => process.env.SYSTEMCTL_BIN || 'systemctl';
const exists = p => fs.access(p).then(() => true, () => false);

// ---------- Windows ----------
// A Start menu shortcut to start.bat, the promptmaker:// link (in your own part of the registry), and a small script
// in your Startup folder that starts Prompt Maker without a window when you sign in. No service, nothing that needs
// administrator rights.
const winFiles = () => {
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const programs = path.join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  return {
    shortcut: path.join(programs, 'Prompt Maker.lnk'),
    startup: path.join(programs, 'Startup', 'Prompt Maker.vbs'),
    declined: path.join(roaming, 'Prompt Maker', 'no-auto-setup'),
  };
};
const bat = () => path.join(ROOT, 'start.bat');
// What the Startup folder runs at sign-in: start.bat, hidden (0), not waited for.
export const startupScript = () => [
  "' Starts Prompt Maker when you sign in, without a window. Made by Prompt Maker; delete it to stop that.",
  `CreateObject("WScript.Shell").Run """${bat()}"" --background", 0, False`,
  '',
].join('\r\n');
const psQuote = v => `'${String(v).replace(/'/g, "''")}'`;
const LINK_KEY = 'HKCU\\Software\\Classes\\promptmaker';
const win = {
  async status() {
    const f = winFiles();
    const [launcher, autostart, declined] = await Promise.all([exists(f.shortcut), exists(f.startup), exists(f.declined)]);
    return { supported: true, platform: 'win32', service: launcher, autostart, launcher, declined };
  },
  async install({ autostart = true } = {}) {
    const f = winFiles();
    await fs.mkdir(path.dirname(f.startup), { recursive: true });
    const shortcut = `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(f.shortcut)}); $s.TargetPath = ${psQuote(bat())}; $s.WorkingDirectory = ${psQuote(ROOT)}; $s.Description = 'Offline prompt writer for image and video models'; $s.WindowStyle = 7; $s.Save()`;
    await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', shortcut]);
    await run('reg', ['add', LINK_KEY, '/ve', '/d', 'URL:Prompt Maker', '/f']);
    await run('reg', ['add', LINK_KEY, '/v', 'URL Protocol', '/d', '', '/f']);
    await run('reg', ['add', `${LINK_KEY}\\shell\\open\\command`, '/ve', '/d', `"${bat()}" "%1"`, '/f']);
    if (autostart) await fs.writeFile(f.startup, startupScript());
    await fs.rm(f.declined, { force: true });
    return win.status();
  },
  async setAutostart(on) {
    const f = winFiles();
    if (!(await exists(f.shortcut))) return win.install({ autostart: on });
    if (on) {
      await fs.mkdir(path.dirname(f.startup), { recursive: true });
      await fs.writeFile(f.startup, startupScript());
    } else await fs.rm(f.startup, { force: true });
    return win.status();
  },
  async uninstall() {
    const f = winFiles();
    await fs.rm(f.shortcut, { force: true });
    await fs.rm(f.startup, { force: true });
    await run('reg', ['delete', LINK_KEY, '/f']);
    await fs.mkdir(path.dirname(f.declined), { recursive: true });
    await fs.writeFile(f.declined, 'Remove this file (or run start.bat --install) to set Prompt Maker up again.\r\n');
    return win.status();
  },
};

function run(bin, args) {
  return new Promise(resolve => {
    execFile(bin, args, { timeout: 30000 }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}`.trim(), missing: err?.code === 'ENOENT' }));
  });
}

async function hasSystemd() {
  if (process.platform !== 'linux') return false;
  return !(await run(SYSTEMCTL(), ['--user', '--version'])).missing;
}

// { supported, platform, service (installed), autostart (starts at login), launcher (app menu + link), declined }
export async function status() {
  if (process.platform === 'win32') return win.status();
  const f = files();
  const supported = await hasSystemd();
  if (!supported) return { supported, platform: process.platform, service: false, autostart: false, launcher: false, declined: false };
  const [service, launcher, declined, enabled] = await Promise.all([
    exists(f.unit), exists(f.desktop), exists(f.declined), run(SYSTEMCTL(), ['--user', 'is-enabled', `${NAME}.service`]),
  ]);
  return { supported, platform: process.platform, service, autostart: service && enabled.out.split('\n')[0] === 'enabled', launcher, declined };
}

function unitText() {
  const lms = process.env.LMS_BIN || path.join(os.homedir(), '.lmstudio', 'bin', 'lms');
  return `[Unit]
Description=Prompt Maker (offline prompt writer)
After=network.target

[Service]
WorkingDirectory=${ROOT}
Environment=PORT=${Number(process.env.PORT) || 5317}
${['PROMPT_MAKER_DATA', 'HOST'].filter(k => process.env[k]).map(k => `Environment="${k}=${process.env[k]}"\n`).join('')}# Turn on LM Studio's server too, if it's installed and off. Never blocks Prompt Maker from starting.
ExecStartPre=-/bin/sh -c '[ -x "${lms}" ] && "${lms}" server status 2>&1 | grep -qi "not running" && "${lms}" server start; true'
ExecStart="${process.execPath}" "${path.join(ROOT, 'server.js')}"
Restart=on-failure
RestartSec=3
TimeoutStartSec=120

[Install]
WantedBy=default.target
`;
}

function desktopText() {
  return `[Desktop Entry]
Type=Application
Name=Prompt Maker
Comment=Offline prompt writer for image and video models
Exec="${path.join(ROOT, 'start.sh')}" %u
Icon=${path.join(ROOT, 'public', 'icon.svg')}
Terminal=false
Categories=Graphics;
MimeType=x-scheme-handler/promptmaker;
StartupNotify=false
`;
}

// Installs the app-menu entry, the promptmaker:// link and the service. autostart: start at login.
// now: also start the service right away (only when Prompt Maker isn't already running).
export async function install({ autostart = true, now = false } = {}) {
  if (process.platform === 'win32') return win.install({ autostart });
  if (!(await hasSystemd())) return status();
  const f = files();
  await fs.mkdir(path.dirname(f.unit), { recursive: true });
  await fs.mkdir(path.dirname(f.desktop), { recursive: true });
  await fs.writeFile(f.unit, unitText());
  await fs.writeFile(f.desktop, desktopText());
  await fs.rm(f.declined, { force: true });
  await run(process.env.XDG_MIME_BIN || 'xdg-mime', ['default', `${NAME}.desktop`, 'x-scheme-handler/promptmaker']);
  await run('update-desktop-database', [path.dirname(f.desktop)]); // optional; refreshes the app menu sooner
  await run(SYSTEMCTL(), ['--user', 'daemon-reload']);
  if (autostart) await run(SYSTEMCTL(), ['--user', 'enable', ...(now ? ['--now'] : []), `${NAME}.service`]);
  else if (now) await run(SYSTEMCTL(), ['--user', 'start', `${NAME}.service`]);
  return status();
}

// Starting at login, on or off. Installs the rest first if it isn't there yet.
export async function setAutostart(on) {
  if (process.platform === 'win32') return win.setAutostart(on);
  const st = await status();
  if (!st.supported) return st;
  if (!st.service || !st.launcher) return install({ autostart: on });
  await run(SYSTEMCTL(), ['--user', on ? 'enable' : 'disable', `${NAME}.service`]);
  return status();
}

// Removes everything install() added, and remembers not to set it up again on its own.
export async function uninstall() {
  if (process.platform === 'win32') return win.uninstall();
  if (!(await hasSystemd())) return status();
  const f = files();
  await run(SYSTEMCTL(), ['--user', 'disable', '--now', `${NAME}.service`]);
  await fs.rm(f.unit, { force: true });
  await fs.rm(f.desktop, { force: true });
  await run('update-desktop-database', [path.dirname(f.desktop)]);
  await run(SYSTEMCTL(), ['--user', 'daemon-reload']);
  await fs.mkdir(path.dirname(f.declined), { recursive: true });
  await fs.writeFile(f.declined, 'Remove this file (or run ./start.sh --install) to set Prompt Maker up again.\n');
  return status();
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) { // (a folder name with a space or an accent is written differently in a URL)
  const [cmd, flag] = process.argv.slice(2);
  // first-run: what a launcher calls on every start; sets up once, unless it's there or you removed it.
  const firstRun = async () => { const now = await status(); return now.supported && !now.declined && !now.launcher ? install() : now; };
  const st = cmd === 'install' ? await install({ now: flag === '--now' })
    : cmd === 'uninstall' ? await uninstall()
    : cmd === 'first-run' ? await firstRun()
    : await status();
  console.log(JSON.stringify(st));
}
