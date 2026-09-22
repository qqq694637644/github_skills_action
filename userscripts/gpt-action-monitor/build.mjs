import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
let metadata = (await readFile(path.join(here, 'metadata.txt'), 'utf8')).trimEnd();
const version = process.env.USERSCRIPT_VERSION?.trim();
if (version) {
  if (!/^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid USERSCRIPT_VERSION: ${version}`);
  }
  metadata = metadata.replace(
    /^\/\/ @version\s+.*$/m,
    `// @version      ${version}`,
  );
}

const outfile = process.env.USERSCRIPT_OUTFILE
  ? path.resolve(process.cwd(), process.env.USERSCRIPT_OUTFILE)
  : path.join(here, '..', 'gpt-action-monitor.user.js');
await mkdir(path.dirname(outfile), { recursive: true });

await build({
  entryPoints: [path.join(here, 'src/main.js')],
  bundle: true,
  format: 'iife',
  outfile,
  banner: { js: metadata },
  legalComments: 'none',
});
