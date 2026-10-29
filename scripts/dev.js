// npm run dev (or dev:demo): the server and the Vite dev server together, for working on the code. The server restarts
// when its files change; the page reloads on its own. Ctrl+C stops both; if either one exits, the other stops too.
import { spawn } from 'node:child_process';

const demo = process.argv[2] === 'demo';
if (demo) process.env.PLAID_ENV = 'demo';
else try { process.loadEnvFile('.env'); } catch { /* no .env: manual accounts only until Plaid keys are added */ }
// --watch follows server.js and the modules it imports, nothing else (not the database files next to them).
const server = spawn(process.execPath, ['--watch', 'server.js'], { stdio: 'inherit', env: process.env });
const web = spawn('npm', ['--prefix', 'web', 'run', 'dev'], { stdio: 'inherit', shell: process.platform === 'win32' });

let stopping = false;
const stop = (code) => {
  if (stopping) return;
  stopping = true;
  for (const p of [server, web]) if (p.exitCode === null) p.kill();
  process.exitCode = code ?? 0;
};
server.on('exit', (code) => stop(code));
web.on('exit', (code) => stop(code));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
console.log(`Moneta dev${demo ? ' (demo data)' : ''}: open http://localhost:5173 once Vite is ready`);
