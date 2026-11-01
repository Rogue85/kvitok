import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { releaseChangelog, releaseNotes, setVersion } from './release.mjs';

const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- Run in production from one Docker image.

## [0.1.0] - 2026-10-01

### Added

- The first release.
`;

describe('release', () => {
  it('sets the version and keeps the rest of package.json', () => {
    const json = '{\n  "name": "kvitok",\n  "version": "0.1.0",\n  "private": true\n}\n';
    assert.equal(setVersion(json, '0.2.0'), '{\n  "name": "kvitok",\n  "version": "0.2.0",\n  "private": true\n}\n');
    assert.throws(() => setVersion('{ "name": "x" }', '0.2.0'), /no "version"/);
  });

  it('moves the Unreleased entries under the release heading', () => {
    const released = releaseChangelog(CHANGELOG, '0.2.0', '2026-11-01');
    assert.match(released, /## \[Unreleased\]\n\n## \[0\.2\.0\] - 2026-11-01\n\n### Added\n\n- Run in production/);
    assert.equal(releaseNotes(released, '0.2.0'), '### Added\n\n- Run in production from one Docker image.');
    assert.equal(releaseNotes(released, '0.1.0'), '### Added\n\n- The first release.');
  });

  it('refuses an empty release, a repeated version and a version without notes', () => {
    const released = releaseChangelog(CHANGELOG, '0.2.0', '2026-11-01');
    assert.throws(() => releaseChangelog(released, '0.3.0', '2026-11-02'), /Unreleased section is empty/);
    assert.throws(() => releaseChangelog(CHANGELOG, '0.1.0', '2026-11-02'), /already has 0\.1\.0/);
    assert.throws(() => releaseNotes(CHANGELOG, '0.3.0'), /no entries for 0\.3\.0/);
  });
});
