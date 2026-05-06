import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream, existsSync, statSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const buildDir = path.resolve(__dirname, '..', 'build');
const port = Number(process.env.PORT || 3000);

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function resolvePath(urlPath) {
  const cleanPath = decodeURIComponent(urlPath.split('?')[0]);
  const relativePath = cleanPath === '/' ? '/index.html' : cleanPath;
  const absolutePath = path.join(buildDir, relativePath);
  if (existsSync(absolutePath) && statSync(absolutePath).isFile()) {
    return absolutePath;
  }
  return path.join(buildDir, 'index.html');
}

const server = http.createServer((req, res) => {
  const filePath = resolvePath(req.url || '/');
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  res.writeHead(200, { 'Content-Type': contentType });
  createReadStream(filePath).pipe(res);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`STATIC SERVER READY http://127.0.0.1:${port}`);
});
