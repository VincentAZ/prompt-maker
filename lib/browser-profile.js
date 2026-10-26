// Small, local-only preferences for the Chromium profile Prompt Maker owns. Nothing here touches the person's normal
// browser profile. Linux Chrome otherwise defaults app windows to a very thin custom frame with undersized controls.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function browserIsRunning(profile) {
  try {
    const lock = await fs.readlink(path.join(profile, 'SingletonLock'));
    const pid = Number(lock.match(/-(\d+)$/)?.[1]);
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

export async function useSystemTitlebar(profile) {
  if (!profile || process.platform !== 'linux') return { changed: false };
  // Chrome owns Preferences while it is running and could overwrite an external edit. The next launch applies it.
  if (await browserIsRunning(profile)) return { changed: false, running: true };
  const dir = path.join(profile, 'Default');
  const file = path.join(dir, 'Preferences');
  let prefs = {};
  try { prefs = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Could not read Prompt Maker's browser preferences: ${err.message}`);
  }
  if (prefs.browser?.custom_chrome_frame === false) return { changed: false };
  prefs.browser = { ...(prefs.browser || {}), custom_chrome_frame: false };
  await fs.mkdir(dir, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(prefs), { mode: 0o600 });
  await fs.rename(temp, file);
  return { changed: true };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  console.log(JSON.stringify(await useSystemTitlebar(process.argv[2])));
}
