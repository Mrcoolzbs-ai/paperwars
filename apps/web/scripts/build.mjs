import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

for (const marker of [
  'id="tab-turn"',
  'id="turn-status-content"',
  'id="order-results-list"',
  'id="refresh-turn-room"',
]) {
  if (!html.includes(marker)) {
    throw new Error(`The campaign turn room is missing required markup: ${marker}`);
  }
}
for (const endpoint of ["'/turn'", "'/orders/results'"]) {
  if (!browserScript.includes(endpoint)) {
    throw new Error(`The campaign turn room is missing its API request: ${endpoint}`);
  }
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });

const buildingAssets = [
  'barracks', 'capital', 'factory', 'field', 'gold-mark', 'science', 'tower',
];
for (const name of buildingAssets) {
  const encoded = await readFile(resolve(source, 'assets/buildings/' + name + '.jpg.b64'), 'utf8');
  const binary = Buffer.from(encoded.trim(), 'base64');
  if (binary.length < 100) throw new Error('Building asset ' + name + ' is missing or invalid.');
  await writeFile(resolve(source, 'assets/buildings/' + name + '.jpg'), binary);
  await writeFile(resolve(output, 'assets/buildings/' + name + '.jpg'), binary);
}
process.stdout.write('Paper Wars public browser client built and JavaScript syntax validated.\n');
