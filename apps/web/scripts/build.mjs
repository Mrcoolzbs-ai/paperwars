import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { Script } from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'src');
const output = resolve(root, 'dist');
const html = await readFile(resolve(source, 'index.html'), 'utf8');
const scriptStart = html.indexOf('<script>');
const scriptEnd = html.indexOf('</script>', scriptStart + 8);
const hasExtraScript = html.indexOf('<script>', scriptStart + 8) !== -1;

if (scriptStart === -1 || scriptEnd === -1 || hasExtraScript) {
  throw new Error('The graphical client must contain exactly one inline application script.');
}
new Script(html.slice(scriptStart + 8, scriptEnd), {
  filename: 'apps/web/src/index.html',
});

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });
process.stdout.write('Paper Wars web client built and JavaScript syntax validated.\\n');
