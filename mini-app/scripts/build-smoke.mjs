import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appDir = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';
const child = spawn(
  isWindows ? 'cmd.exe' : 'npm',
  isWindows ? ['/d', '/s', '/c', 'npm run build'] : ['run', 'build'],
  {
    cwd: appDir,
    env: {
      ...process.env,
      REACT_APP_API_URL: process.env.REACT_APP_API_URL || 'http://127.0.0.1:8000',
    },
    stdio: 'inherit',
  }
);

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
