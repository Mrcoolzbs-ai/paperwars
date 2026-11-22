import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { Script } from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'src');
const output = resolve(root, 'dist');
const html = await readFile(resolve(source, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\\s\\S]*?)<\\/script>/g)];

if (scripts.length !== 1 || scripts[0]?.[1] === undefined) {
  throw new Error('The graphical client must contain exactly one inline application script.');
}
new Script(scripts[0][1], { filename: 'apps/web/src/index.html' });

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });
process.stdout.write('Paper Wars web client built and JavaScript syntax validated.\\n');
