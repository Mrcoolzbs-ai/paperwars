import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { Script } from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'public');
const output = resolve(root, 'dist');
const html = await readFile(resolve(source, 'index.html'), 'utf8');

if (!/<script\b[^>]*src=["']\/app\.js["'][^>]*><\/script>/i.test(html)) {
  throw new Error('The public browser entry point must load /app.js.');
}

const browserScript = await readFile(resolve(source, 'app.js'), 'utf8');
new Script(browserScript, { filename: 'apps/web/public/app.js' });

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });
process.stdout.write('Paper Wars public browser client built and JavaScript syntax validated.\n');
