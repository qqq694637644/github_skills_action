import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const metadata = (await readFile(path.join(here, 'metadata.txt'), 'utf8')).trimEnd();

await build({
  entryPoints: [path.join(here, 'src/main.js')],
  bundle: true,
  format: 'iife',
  outfile: path.join(here, '..', 'gpt-action-monitor.user.js'),
  banner: { js: metadata },
  legalComments: 'none',
});
