import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appDir = path.resolve(__dirname, '..');
const repoDir = path.resolve(appDir, '..');
const backendDir = path.join(repoDir, 'backend');
const isWindows = process.platform === 'win32';
const apiPort = process.env.SMOKE_API_PORT || '38000';
const webPort = process.env.SMOKE_WEB_PORT || '33000';
const apiUrl = `http://127.0.0.1:${apiPort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const pythonCmd = process.platform === 'win32'
  ? path.join(backendDir, 'venv', 'Scripts', 'python.exe')
  : path.join(backendDir, 'venv', 'bin', 'python');

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

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
      }
    });

    child.on('error', reject);
  });
}

function waitForUrl(url, timeoutMs = 30_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) {
          resolve();
        } else if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
        } else {
          setTimeout(check, 500);
        }
      });

      req.on('error', () => {
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
        } else {
          setTimeout(check, 500);
        }
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
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        killer.on('exit', () => resolve());
        killer.on('error', () => resolve());
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
    options
  );
}

async function main() {
  try {
    await runNpmScript('smoke:build', {
      cwd: appDir,
      env: { ...process.env, REACT_APP_API_URL: apiUrl },
    });

    spawnChild(pythonCmd, [path.join(backendDir, '_mock_api_server.py')], {
      cwd: backendDir,
      env: { ...process.env, PORT: apiPort },
    });
    spawnChild(process.execPath, [path.join(appDir, 'scripts', 'static-server.mjs')], {
      cwd: appDir,
      env: { ...process.env, PORT: webPort },
    });

    await waitForUrl(`${apiUrl}/health`);
    await waitForUrl(`${webUrl}/`);

    await runNpmScript('smoke:test', {
      cwd: appDir,
      env: {
        ...process.env,
        SMOKE_BASE_URL: webUrl,
        SMOKE_API_URL: apiUrl,
      },
    });
  } finally {
    await stopChildren();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
