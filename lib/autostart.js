// Setting Prompt Maker up on the computer, so nobody needs a terminal: an app-menu entry, a promptmaker:// link
// (the offline page's Start button opens it), and a background service that starts it at login, keeps it
// running and turns on LM Studio's server. One module for every platform: Linux is done; Windows and macOS
// report supported: false until their part is written (roadmap P1/P2).
//
// Also a small command line for the launchers:  node lib/autostart.js install [--now] | uninstall | status
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
# Turn on LM Studio's server too, if it's installed and off. Never blocks Prompt Maker from starting.
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
  const st = await status();
  if (!st.supported) return st;
  if (!st.service || !st.launcher) return install({ autostart: on });
  await run(SYSTEMCTL(), ['--user', on ? 'enable' : 'disable', `${NAME}.service`]);
  return status();
}

// Removes everything install() added, and remembers not to set it up again on its own.
export async function uninstall() {
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, flag] = process.argv.slice(2);
  const st = cmd === 'install' ? await install({ now: flag === '--now' })
    : cmd === 'uninstall' ? await uninstall()
    : await status();
  console.log(JSON.stringify(st));
}
