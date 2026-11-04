#!/usr/bin/env node
/**
 * Builds the project website (GitHub Pages) into _site/: the pages from site/, the brand, the
 * diagrams and the screenshots from docs/, the current version in place of {{version}}, and the
 * files for search engines and AI agents: robots.txt, sitemap.xml and llms-full.txt (the README and
 * the docs in one file, next to the hand-written site/llms.txt).
 *
 *   pnpm site:build
 */
import { cpSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '_site');
const SITE = 'https://kvitok.nojake.com/';
const REPO = 'https://github.com/Rogue85/kvitok/blob/main/';
// The pages listed in the sitemap, by their path on the site.
const PAGES = ['', 'ru/', 'compare/'];
// The documents gathered into llms-full.txt, in reading order.
const DOCS = ['README.md', 'docs/protocol.md', 'docs/mcp.md', 'docs/deployment.md', 'docs/development.md'];

rmSync(OUT, { recursive: true, force: true });
cpSync(join(ROOT, 'site'), OUT, { recursive: true });
for (const dir of ['brand', 'diagrams', 'screenshots']) {
  cpSync(join(ROOT, 'docs', dir), join(OUT, 'assets', dir), { recursive: true });
}

const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
for (const file of htmlFiles(OUT)) {
  writeFileSync(file, readFileSync(file, 'utf8').replaceAll('{{version}}', version));
}

const today = new Date().toISOString().slice(0, 10);
writeFileSync(join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}sitemap.xml\n`);
writeFileSync(
  join(OUT, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${PAGES.map(
    (page) => `  <url><loc>${SITE}${page}</loc><lastmod>${today}</lastmod></url>`,
  ).join('\n')}\n</urlset>\n`,
);
writeFileSync(join(OUT, 'llms-full.txt'), llmsFull());

// Serve the files as they are, without Jekyll.
writeFileSync(join(OUT, '.nojekyll'), '');

console.log(`Built the site for ${version} in _site/`);

function* htmlFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* htmlFiles(path);
    else if (entry.name.endsWith('.html')) yield path;
  }
}

/** The README and the docs as plain markdown: no images or HTML, links pointing to GitHub. */
function llmsFull() {
  const parts = DOCS.map((doc) => {
    let text = readFileSync(join(ROOT, doc), 'utf8');
    text = text
      .replace(/<picture>[\s\S]*?<\/picture>\s*/g, '')
      .replace(/<h1>[\s\S]*?<\/h1>\s*/g, '')
      .replace(/^<img [^>]*>\s*$/gm, '')
      .replace(/^\[!\[[^\n]*\n/gm, '')
      .replace(/<\/?sub>/g, '')
      .replace(/\n{3,}/g, '\n\n');
    // Relative links become links to the file on GitHub.
    const base = posix.dirname(doc);
    text = text.replace(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g, (_, target) => {
      const [path, hash] = target.split('#');
      const resolved = posix.normalize(posix.join(base, path));
      return `](${REPO}${resolved}${hash ? `#${hash}` : ''})`;
    });
    return `<!-- ${REPO}${doc} -->\n\n${text.trim()}\n`;
  });
  return `# Kvitok: the full documentation\n\n> The README and the docs of Kvitok ${version}, an open-source, self-hosted helpdesk with an AI agent. Source: ${REPO.replace('/blob/main/', '')}\n\n${parts.join('\n---\n\n')}`;
}
