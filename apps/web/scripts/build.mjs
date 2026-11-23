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

for (const marker of [
  'id="tab-turn"',
  'id="turn-status-content"',
  'id="order-results-list"',
  'id="refresh-turn-room"',
  'id="admin-tab-label"',
  'id="admin-overview-stats"',
  'id="admin-campaign-list"',
  'id="admin-campaign-detail"',
  'id="tab-chat"',
  'id="chat-messages"',
  'id="chat-form"',
  'data-chat-room="world"',
  'data-chat-room="campaign"',
]) {
  if (!html.includes(marker)) {
    throw new Error(`The campaign turn room is missing required markup: ${marker}`);
  }
}
for (const endpoint of [
  "'/turn'",
  "'/orders/results'",
  "'/admin/access'",
  "'/admin/overview'",
  "'/admin/campaigns/'",
  "'/turn/force-close'",
  "'/chat/world'",
  "'/chat'",
]) {
  if (!browserScript.includes(endpoint)) {
    throw new Error(`The campaign turn room is missing its API request: ${endpoint}`);
  }
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });
process.stdout.write('Paper Wars public browser client built and JavaScript syntax validated.\n');
