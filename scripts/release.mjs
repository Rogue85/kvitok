#!/usr/bin/env node
/**
 * Prepares a release: sets the version in every package.json and turns the "Unreleased" section
 * of CHANGELOG.md into the release's section. Commits, tags and pushes nothing. The process is in
 * CONTRIBUTING.md, "Releases".
 *
 *   pnpm release <version>                     prepare the release
 *   node scripts/release.mjs notes <version>   print the release's changelog section (used by CI)
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const UNRELEASED = '## [Unreleased]';

/** The root package.json and every workspace package: one version for the whole repository. */
function packageFiles() {
  const workspace = ['apps', 'packages'].flatMap((dir) =>
    readdirSync(join(ROOT, dir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(ROOT, dir, entry.name, 'package.json')),
  );
  return [join(ROOT, 'package.json'), ...workspace];
}

/** package.json text with the new version; the rest of the formatting is kept. */
export function setVersion(json, version) {
  const field = /^(\s*"version":\s*)"[^"]*"/m;
  if (!field.test(json)) throw new Error('package.json has no "version" field');
  return json.replace(field, `$1"${version}"`);
}

/** The body of the section `## [<name>]…` up to the next `## `, without the heading line; null if there is none. */
function section(changelog, name) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## [${name}]`));
  if (start === -1) return null;
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join('\n')
    .trim();
}

/** CHANGELOG.md with the Unreleased entries moved under the release's heading and an empty Unreleased on top. */
export function releaseChangelog(changelog, version, date) {
  if (changelog.includes(`## [${version}]`)) throw new Error(`CHANGELOG.md already has ${version}`);
  const unreleased = section(changelog, 'Unreleased');
  if (unreleased === null) throw new Error(`CHANGELOG.md has no "${UNRELEASED}" section`);
  if (unreleased === '') throw new Error('the Unreleased section is empty: describe the changes first');
  return changelog.replace(`${UNRELEASED}\n`, `${UNRELEASED}\n\n## [${version}] - ${date}\n`);
}

/** The release's section of CHANGELOG.md, for the GitHub release description. */
export function releaseNotes(changelog, version) {
  const notes = section(changelog, version);
  if (notes === null || notes === '') throw new Error(`CHANGELOG.md has no entries for ${version}`);
  return notes;
}

function main([command, arg]) {
  const changelogPath = join(ROOT, 'CHANGELOG.md');
  const changelog = readFileSync(changelogPath, 'utf8');
  if (command === 'notes') {
    process.stdout.write(`${releaseNotes(changelog, arg)}\n`);
    return;
  }

  const version = command?.replace(/^v/, '');
  if (!version || !SEMVER.test(version)) throw new Error('usage: pnpm release <version>, for example pnpm release 0.2.0');
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(changelogPath, releaseChangelog(changelog, version, date));
  for (const file of packageFiles()) writeFileSync(file, setVersion(readFileSync(file, 'utf8'), version));

  console.log(`Prepared ${version}. Review the diff, then:

  git commit -am "chore: release ${version}"
  git tag v${version}
  git push origin main v${version}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`release: ${error.message}`);
    process.exit(1);
  }
}
