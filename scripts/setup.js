// Runs before npm start, npm run demo and npm run dev, so one command is enough on a fresh clone: it installs the web
// UI's packages when they're missing or out of date, and (unless `deps` is passed, as dev does) builds the UI when the
// build is missing or older than its sources, e.g. after a git pull. Later runs with nothing to do take no time.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const web = new URL('../web/', import.meta.url).pathname;
const mtime = (p) => (existsSync(p) ? statSync(p).mtimeMs : 0);
const newest = (dir) => readdirSync(dir, { withFileTypes: true })
  .reduce((m, e) => Math.max(m, e.isDirectory() ? newest(join(dir, e.name)) : mtime(join(dir, e.name))), 0);
const npm = (...args) => {
  const r = spawnSync('npm', ['--prefix', web, ...args], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

if (mtime(join(web, 'package-lock.json')) > mtime(join(web, 'node_modules/.package-lock.json'))) {
  console.log('Installing the web UI packages (first run or after an update)…');
  npm('install', '--no-audit', '--no-fund');
}
if (process.argv[2] !== 'deps') {
  const sources = Math.max(newest(join(web, 'src')), ...['index.html', 'vite.config.ts', 'package-lock.json'].map((f) => mtime(join(web, f))));
  if (sources > mtime(join(web, 'dist/index.html'))) {
    console.log('Building the web UI…');
    npm('run', 'build');
  }
}
