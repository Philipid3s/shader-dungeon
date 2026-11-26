/**
 * Headless smoke test for index.html.
 *
 * - serves the folder with `python3 -m http.server`
 * - loads the page in Chromium (SwiftShader WebGL2 when no GPU is present)
 * - fails on page errors / console errors / blank frames
 * - simulates play: start gate, walk, turn, wall collision
 * - writes screenshots to shots/ (gitignored) and prints FPS + file size
 *
 * Usage: node scripts/smoke.mjs        (SMOKE_PORT, SMOKE_SCALE optional)
 * Needs Playwright reachable from Node (global install or npx cache).
 */
import { spawn, execSync } from 'node:child_process';
import { access, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, 'shots');
const port = Number(process.env.SMOKE_PORT || 8765);
const scale = process.env.SMOKE_SCALE || '0.5';
const base = `http://127.0.0.1:${port}/index.html`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await mkdir(shots, { recursive: true });
const { size } = await stat(path.join(root, 'index.html'));
const playwright = await loadPlaywright();
const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
await waitForServer();

const problems = [];
const log = (...a) => console.log(...a);
let browser;
try {
  const opts = {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader',
      '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
  };
  if (await exists('/usr/bin/google-chrome')) opts.executablePath = '/usr/bin/google-chrome';
  browser = await playwright.chromium.launch(opts);
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) problems.push(`console.error: ${m.text()}`); });

  // 1) start position, gate dismissed
  await page.goto(`${base}?scale=${scale}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.dungeon && /FPS/.test(document.getElementById('hud').textContent), null, { timeout: 30000 });
  await page.click('#gate');
  await page.waitForFunction(() => document.getElementById('gate').classList.contains('hidden'));
  const s1 = await page.evaluate(() => window.dungeon.sample());
  log('frame stats @start:', JSON.stringify(s1));
  if (s1.mean < 3 || s1.std < 2) problems.push(`frame looks blank at start: ${JSON.stringify(s1)}`);
  await page.screenshot({ path: path.join(shots, '01-start.png') });

  // 2) walk forward into the first wall: must move, must not pass through
  const p0 = await page.evaluate(() => ({ ...window.dungeon.player }));
  await page.keyboard.down('KeyW'); await sleep(3500); await page.keyboard.up('KeyW');
  const p1 = await page.evaluate(() => ({ ...window.dungeon.player }));
  log(`walk: x ${p0.x.toFixed(2)} -> ${p1.x.toFixed(2)} (wall face at x=5, radius 0.22)`);
  if (!(p1.x > p0.x + 1)) problems.push('player did not move forward');
  if (p1.x > 5 - 0.2) problems.push(`player went through the wall: x=${p1.x}`);
  await page.screenshot({ path: path.join(shots, '02-after-walk.png') });

  // 3) turn right (arrow key): now facing the side corridor going south (+z)
  await page.keyboard.down('ArrowRight'); await sleep(700); await page.keyboard.up('ArrowRight');
  await page.keyboard.down('KeyW'); await sleep(1200); await page.keyboard.up('KeyW');
  const p2 = await page.evaluate(() => ({ ...window.dungeon.player }));
  log(`turn+walk: z ${p1.z.toFixed(2)} -> ${p2.z.toFixed(2)}`);
  if (!(p2.z > p1.z + 0.5)) problems.push('player did not move down the side corridor after turning right');
  await page.screenshot({ path: path.join(shots, '03-after-turn.png') });

  // 4) fixed poses for comparable shots: pillar hall + exit rune
  for (const [name, q] of [['04-pillar-hall', 'x=11.5&z=13.5&yaw=1.57'], ['05-exit-rune', 'x=22.5&z=17.5&yaw=0&pitch=-0.35']]) {
    await page.goto(`${base}?scale=${scale}&${q}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.dungeon && window.dungeon.fps > 0, null, { timeout: 30000 });
    await page.evaluate(() => document.getElementById('gate').classList.add('hidden'));
    const s = await page.evaluate(() => window.dungeon.sample());
    log(`frame stats @${name}:`, JSON.stringify(s));
    if (s.mean < 3 || s.std < 2) problems.push(`frame looks blank at ${name}`);
    await page.screenshot({ path: path.join(shots, `${name}.png`) });
  }

  // 5) reaching the exit cell shows the win screen
  await page.goto(`${base}?scale=${scale}&x=22.5&z=19.5&yaw=0`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.dungeon && window.dungeon.fps > 0, null, { timeout: 30000 });
  await page.click('#gate');
  await page.keyboard.down('KeyW'); await sleep(2000); await page.keyboard.up('KeyW');
  const won = await page.evaluate(() => !document.getElementById('win').classList.contains('hidden'));
  log('exit reached -> win screen:', won);
  if (!won) problems.push('win screen not shown after walking onto the exit');
  await page.screenshot({ path: path.join(shots, '06-win.png') });
  await page.goto(`${base}?scale=${scale}&x=11.5&z=13.5&yaw=1.57`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.dungeon && window.dungeon.fps > 0, null, { timeout: 30000 });

  // 6) FPS after a few seconds at the fixed scale
  await sleep(4000);
  const hud = await page.evaluate(() => document.getElementById('hud').textContent);
  const fps = await page.evaluate(() => window.dungeon.fps);
  log('HUD:\n' + hud);
  log(`FPS (scale ${scale}, headless SwiftShader): ${fps.toFixed(1)}`);
  log(`index.html on disk: ${size} bytes (limit 51200)`);
  if (size > 50 * 1024) problems.push(`index.html too big: ${size} B`);
  if (!new RegExp(`${size} B`).test(hud)) problems.push('HUD file size does not match disk size');
} catch (e) {
  problems.push(String(e));
} finally {
  if (browser) await Promise.race([browser.close(), sleep(5000)]).catch(() => {});
  server.kill();
}

if (problems.length) { console.error('SMOKE FAILED:\n- ' + problems.join('\n- ')); process.exitCode = 1; }
else log('SMOKE PASSED (screenshots in shots/)');

async function exists(p) { try { await access(p); return true; } catch { return false; } }
async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(base); if (r.ok) return; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('http.server did not start');
}
async function loadPlaywright() {
  for (const name of ['playwright', 'playwright-core']) { try { return await import(name); } catch { /* next */ } }
  const roots = [];
  try { roots.push(execSync('npm root -g', { encoding: 'utf8' }).trim()); } catch { /* ignore */ }
  roots.push(path.join(process.env.HOME || '', '.npm/_npx'));
  for (const dir of roots) {
    for (const cand of [path.join(dir, 'playwright'), ...(await subdirs(dir)).map((d) => path.join(dir, d, 'node_modules', 'playwright'))]) {
      if (await exists(path.join(cand, 'index.js'))) return import(pathToFileURL(path.join(cand, 'index.js')).href);
    }
  }
  console.error('Playwright not found. Install it (npm i -g playwright) or run once via npx.');
  process.exit(1);
}
async function subdirs(d) { try { return (await readdir(d, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } }
