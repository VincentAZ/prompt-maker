// The Privacy check (Settings): what this computer does with your data below the app, and the fixes it can make.
//   disk        is the system disk encrypted (LUKS)? Can't be changed here: it's chosen when the system is installed.
//   swap        memory written to disk when RAM runs short: off, or encrypted, or in the open (one click turns it off).
//   hibernation all of memory written to disk on hibernate: off when there's no swap, or masked (one click masks it).
//   lock        the screen locks on its own after a while (GNOME; one click turns it on, 5 minutes).
// Linux only for now; elsewhere the check says so. The root steps go through pkexec: the system's own password
// prompt, no terminal.
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { httpError } from './store.js';

const LSBLK = () => process.env.PM_LSBLK_BIN || 'lsblk';
const GSETTINGS = () => process.env.PM_GSETTINGS_BIN || 'gsettings';
const PKEXEC = () => process.env.PM_PKEXEC_BIN || 'pkexec';
const SYSTEMCTL = () => process.env.SYSTEMCTL_BIN || 'systemctl';
const PROC_SWAPS = () => process.env.PM_PROC_SWAPS || '/proc/swaps';
const SYS_POWER_DISK = () => process.env.PM_SYS_POWER_DISK || '/sys/power/disk';
export const LOCK_AFTER = 300; // seconds, when the screen never blanked before

const run = (bin, args, timeout = 20000) => new Promise(resolve => {
  execFile(bin, args, { timeout }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}`.trim(), missing: err?.code === 'ENOENT' }));
});

// The block devices as a tree, from lsblk.
async function blockTree() {
  const r = await run(LSBLK(), ['-J', '-o', 'NAME,TYPE,FSTYPE,MOUNTPOINT,MOUNTPOINTS']);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.out).blockdevices || [];
  } catch {
    return null;
  }
}

const mountsOf = d => [d.mountpoint, ...(d.mountpoints || [])].filter(Boolean);

// Walks the tree to the device holding a mount point (or a device by name); encrypted when any device on the way
// is a crypt mapping. Returns { found, encrypted }.
function findIn(tree, want, path = []) {
  for (const d of tree) {
    const here = [...path, d];
    const hit = want(d);
    if (hit) return { found: true, encrypted: here.some(x => x.type === 'crypt' || x.fstype === 'crypto_LUKS') };
    const deeper = findIn(d.children || [], want, here);
    if (deeper.found) return deeper;
  }
  return { found: false, encrypted: false };
}

async function swaps() {
  const text = await fs.readFile(PROC_SWAPS(), 'utf8').catch(() => '');
  return text.split('\n').slice(1).map(l => l.trim().split(/\s+/)[0]).filter(Boolean);
}

export async function check() {
  if (process.platform !== 'linux') return { supported: false, platform: process.platform };
  const tree = await blockTree();
  const root = tree ? findIn(tree, d => mountsOf(d).includes('/')) : { found: false };
  const active = await swaps();
  const swapEnc = tree ? active.every(dev => findIn(tree, d => `/dev/${d.name}` === dev || `/dev/mapper/${d.name}` === dev).encrypted) : false;
  const power = (await fs.readFile(SYS_POWER_DISK(), 'utf8').catch(() => '')).trim();
  const masked = /masked/.test((await run(SYSTEMCTL(), ['show', '-p', 'UnitFileState', 'hibernate.target'])).out);
  const lockOn = (await run(GSETTINGS(), ['get', 'org.gnome.desktop.screensaver', 'lock-enabled'])).out;
  const delay = (await run(GSETTINGS(), ['get', 'org.gnome.desktop.session', 'idle-delay'])).out.match(/\d+$/)?.[0];
  const gnome = /^(true|false)$/.test(lockOn) && delay !== undefined;
  return {
    supported: true,
    disk: { encrypted: root.found ? root.encrypted : null },
    swap: { active: active.length > 0, encrypted: active.length > 0 && swapEnc, devices: active },
    hibernation: { possible: active.length > 0 && !masked && power !== '' && !/\[disabled\]/.test(power), masked },
    lock: { known: gnome, on: gnome && lockOn === 'true' && Number(delay) > 0, delay: gnome ? Number(delay) : null },
  };
}

// The commands the root fixes run, so the page can show them when the password prompt isn't available.
export const ROOT_FIXES = {
  swap: "swapoff -a && sed -i -E 's|^([^#].*[[:space:]]swap[[:space:]].*)$|# \\1|' /etc/fstab",
  hibernation: 'systemctl mask hibernate.target hybrid-sleep.target suspend-then-hibernate.target',
};

export async function fix(what) {
  if (process.platform !== 'linux') throw httpError(400, 'The Privacy check is for Linux for now.');
  if (what === 'lock') {
    const a = await run(GSETTINGS(), ['set', 'org.gnome.desktop.screensaver', 'lock-enabled', 'true']);
    if (!a.ok) throw httpError(502, a.missing ? "Couldn't find the desktop's settings tool (this works on GNOME)." : `Couldn't turn the lock on: ${a.out}`);
    const delay = (await run(GSETTINGS(), ['get', 'org.gnome.desktop.session', 'idle-delay'])).out.match(/\d+$/)?.[0];
    if (Number(delay) === 0) await run(GSETTINGS(), ['set', 'org.gnome.desktop.session', 'idle-delay', `uint32 ${LOCK_AFTER}`]);
    return check();
  }
  const cmd = ROOT_FIXES[what];
  if (!cmd) throw httpError(400, 'Nothing to fix by that name.');
  const r = await run(PKEXEC(), ['sh', '-c', cmd], 180000); // waits for the password prompt
  if (!r.ok) {
    const why = r.missing ? 'the system has no password prompt for this (pkexec)' : /dismissed|not authorized|cancel/i.test(r.out) ? 'the password prompt was dismissed' : r.out || 'it failed';
    throw httpError(502, `Couldn't do it: ${why}. As an administrator, run: sudo sh -c ${JSON.stringify(cmd)}`);
  }
  return check();
}
