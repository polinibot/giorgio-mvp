/**
 * Production smoke runner.
 * Builda la mini-app puntando alla prod API, la serve localmente,
 * poi gira i test Playwright prod-smoke.spec.js.
 *
 * Richiede:
 *   SMOKE_TEST_SECRET=<stesso valore in Railway SMOKE_TEST_SECRET>
 *
 * Uso:
 *   $env:SMOKE_TEST_SECRET="il-tuo-secret"; node scripts/run-prod-smoke.mjs
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appDir = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';

const PROD_API = process.env.SMOKE_PROD_API_URL
  || 'https://giorgio-mvp-production.up.railway.app';
const WEB_PORT = process.env.SMOKE_PROD_WEB_PORT || '34000';
const SMOKE_SECRET = process.env.SMOKE_TEST_SECRET || '';

if (!SMOKE_SECRET) {
  console.error('❌  SMOKE_TEST_SECRET non impostato.');
  console.error('    Imposta la stessa variabile configurata in Railway e riprova.');
  process.exit(1);
}

const children = [];

function spawnChild(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: 'inherit',
  });
  children.push(child);
  return child;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit',
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    child.on('error', reject);
  });
}

function waitForUrl(url, timeoutMs = 30_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve();
        else if (Date.now() - startedAt >= timeoutMs) reject(new Error(`Timeout ${url}`));
        else setTimeout(check, 500);
      });
      req.on('error', () => {
        if (Date.now() - startedAt >= timeoutMs) reject(new Error(`Timeout ${url}`));
        else setTimeout(check, 500);
      });
    };
    check();
  });
}

async function stopChildren() {
  for (const child of children.reverse()) {
    if (!child || child.killed) continue;
    if (process.platform === 'win32') {
      await new Promise((resolve) => {
        const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        k.on('exit', () => resolve());
        k.on('error', () => resolve());
      });
    } else {
      child.kill('SIGTERM');
    }
  }
}

function runNpmScript(scriptName, options = {}) {
  return runCommand(
    isWindows ? 'cmd.exe' : 'npm',
    isWindows ? ['/d', '/s', '/c', `npm run ${scriptName}`] : ['run', scriptName],
    options,
  );
}

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   GIORGIO PRODUCTION SMOKE RUNNER       ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`🔗  API: ${PROD_API}`);
  console.log(`🌐  Web: http://127.0.0.1:${WEB_PORT}`);
  console.log('');

  try {
    // 1. Build mini-app puntando alla prod API in una directory separata
    // per non sovrascrivere build/ del mock smoke se i due runner girano in parallelo.
    console.log('📦  Build mini-app → prod API (build-prod/)...');
    await runNpmScript('smoke:build', {
      cwd: appDir,
      env: { ...process.env, REACT_APP_API_URL: PROD_API, BUILD_PATH: 'build-prod' },
    });

    // 2. Avvia server statico puntando a build-prod/
    spawnChild(process.execPath, [path.join(appDir, 'scripts', 'static-server.mjs')], {
      cwd: appDir,
      env: { ...process.env, PORT: WEB_PORT, BUILD_PATH: 'build-prod' },
    });
    await waitForUrl(`http://127.0.0.1:${WEB_PORT}/`);

    // 3. Esegui i test prod-smoke con Playwright
    await runCommand(
      isWindows ? 'cmd.exe' : 'npx',
      isWindows
        ? ['/d', '/s', '/c', 'npx playwright test --config=playwright.prod.config.js']
        : ['playwright', 'test', '--config=playwright.prod.config.js'],
      {
        cwd: appDir,
        env: {
          ...process.env,
          SMOKE_PROD_API_URL: PROD_API,
          SMOKE_PROD_WEB_PORT: WEB_PORT,
          SMOKE_TEST_SECRET: SMOKE_SECRET,
        },
      },
    );
  } finally {
    await stopChildren();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
