#!/usr/bin/env node
/**
 * Builds the project website (GitHub Pages) into _site/: the pages from site/, the brand, the
 * diagrams and the screenshots from docs/, and the current version in place of {{version}}.
 *
 *   pnpm site:build
 */
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '_site');

rmSync(OUT, { recursive: true, force: true });
cpSync(join(ROOT, 'site'), OUT, { recursive: true });
for (const dir of ['brand', 'diagrams', 'screenshots']) {
  cpSync(join(ROOT, 'docs', dir), join(OUT, 'assets', dir), { recursive: true });
}

const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const index = join(OUT, 'index.html');
writeFileSync(index, readFileSync(index, 'utf8').replaceAll('{{version}}', version));
// Serve the files as they are, without Jekyll.
writeFileSync(join(OUT, '.nojekyll'), '');

console.log(`Built the site for ${version} in _site/`);
