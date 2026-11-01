# Contributing

Thanks for your interest in the project. Bug reports, ideas and pull requests are welcome.

- Report bugs and propose features in GitHub issues. For a larger change, open an issue first to agree on the approach.
- Security vulnerabilities go through the private channel described in [SECURITY.md](SECURITY.md), not public issues.
- Be kind and constructive: the [Code of Conduct](CODE_OF_CONDUCT.md) applies to all project spaces.
- By contributing you agree that your contribution is licensed under the license of the code you change: the [MIT License](packages/protocol/LICENSE) in `packages/protocol` and `apps/coffee-sim`, the [AGPL-3.0](LICENSE) everywhere else.

## Language

Code, comments, documentation, commit messages and pull requests are in English. User-facing texts go into the translation catalogs in `packages/i18n/locales` (see "Languages" in [docs/development.md](docs/development.md)), never inline in the code: add the key to `en.yaml` and to every other language.

## Commits

The format is [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>(<scope>): <what the commit does>

<why and what changed — optional>

<footers — optional>
```

Example:

```
feat(actions): execute approved actions through a queue

The idempotency key is the proposal id, so a retry is safe.
If the execute response is lost, the executor asks for the status by key.
```

### Type

| Type | When |
|---|---|
| `feat` | a new capability for users or the API |
| `fix` | a bug fix |
| `refactor` | a rework without behavior changes |
| `perf` | a speedup |
| `test` | tests only |
| `docs` | documentation only (`docs/`, README, comments) |
| `build` | build, dependencies, migrations without code |
| `ci` | GitHub Actions and checks |
| `chore` | other maintenance: configs, scripts, renames |
| `revert` | reverting a commit |

A breaking change gets `!` after the scope (`feat(protocol)!: …`) and a `BREAKING CHANGE: what broke and how to migrate` footer.

### Scope

Optional, lowercase. Usually a package or a module:

- **packages:** `api`, `web`, `shared`, `protocol`, `i18n`, `coffee-sim`;
- **API modules:** `agent`, `integrations`, `actions`, `eval`, `ingest`, `mail`, `tickets`, `routing`, `auth`, `db` (migrations).

A change in several places takes the main scope or none. A comma-separated list works too: `fix(api,web): …`.

### Description

- Says what the commit does, in the imperative mood and lowercase: "add", "fix", "remove", "move".
- No period at the end.
- The whole header (type, scope and description) is at most 72 characters.
- The body is separated by a blank line. It explains why and the consequences, not a retelling of the diff. Lines up to 72 characters, lists are fine.

### What commits do not contain

- **AI-assistant attribution.** No `Co-Authored-By: Claude …`, "Generated with Claude Code", emoji signatures or session links. The commit author is the developer (`git config user.name` / `user.email`). The same goes for pull request descriptions.
- **Secrets and production data.** Keys, passwords, `.env`, dumps of production databases. Test data is synthetic only, in the `apps/coffee-sim` scenarios.
- **Generated code and artifacts.** `dist`, `apps/api/src/generated`, `packages/i18n/src/generated` and `eval-reports` are already in `.gitignore`.

### Size

One commit is one logical change. Code, its tests and its migration go into the same commit. A refactoring that cannot be avoided goes into a separate commit before the behavior change.

## Format check

The `commit-msg` hook (`.githooks/commit-msg`) checks the header and rejects assistant attribution. `pnpm install` enables it (the `prepare` script sets `core.hooksPath`). Manually:

```bash
git config core.hooksPath .githooks
```

The hook skips merge commits, `fixup!` and `squash!`. Do not bypass it with `--no-verify`: fix the message instead.

## Before committing

```bash
pnpm check
```

This runs type checking, tests and a build of all packages. Postgres and Redis must be running (see [docs/development.md](docs/development.md)).

Agent evaluation (`pnpm eval`) is not part of the check: it spends money on the model. Run it when you change the agent prompt or its behavior, with `--budget`.

## Changelog

[CHANGELOG.md](CHANGELOG.md) is for people who run Kvitok or connect a backend to it. A commit that changes something they notice adds a line to the `## [Unreleased]` section in the same commit, under one of the groups `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`. Examples: a new feature, a fix of a visible bug, a new or renamed setting, a change in the protocol, the API or the image. Refactoring, tests, CI and internal documentation need no entry.

The line says what changed for the reader, not what the commit did in the code. A breaking change starts with **Breaking** and says how to migrate.

## Versions

Kvitok has one version for the whole repository, by [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The root `package.json` and every package under `apps/` and `packages/` carry it. A `vX.Y.Z` tag on `main` is a release, and the image is published from it. The version reaches the running app as `APP_VERSION`, which CI bakes into the image: `0.2.0` for a release, `edge-<sha>` for `main`, `dev` locally. Do not edit versions by hand: `pnpm release` sets them.

Until 1.0.0:

- **patch** (`0.2.1`): fixes only, safe to update to without reading anything;
- **minor** (`0.3.0`): new features, and breaking changes, marked in the changelog.

After 1.0.0, a breaking change takes a major version.

A change is breaking when an existing installation or integration stops working without action from its owner: a setting is renamed or removed, an endpoint of the ingest API or the protocol changes incompatibly, an MCP tool changes its input, a deployment option disappears, or an update needs a manual step.

Some things have versions of their own, independent of the release:

- **the protocol**, `protocol_version` in [docs/protocol.md](docs/protocol.md): goes up only on an incompatible change of the protocol;
- **the agent's core prompt**, `CORE_PROMPT_VERSION`: goes up on every change of the prompt;
- **database migrations**: a released migration is never edited, a fix is a new migration. An update across several versions applies them in order.

## Releases

A release is cut from `main` when it is green:

1. Check that `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) is complete. Compare it with `git log v<previous>..HEAD`.
2. Pick the version by the rules above and run `pnpm release <version>`. It sets the version in every `package.json` and moves the Unreleased entries under the new version's heading.
3. Review the diff, then commit, tag and push:

   ```bash
   git commit -am "chore: release 0.2.0"
   ```

   ```bash
   git tag v0.2.0
   ```

   ```bash
   git push origin main v0.2.0
   ```

CI ([release.yml](.github/workflows/release.yml)) checks that the tag matches `package.json`. It then publishes the image as `0.2.0`, `0.2` and `latest`, and creates a GitHub release with the changelog section. A wrong tag is fixed by deleting it before the image is used, never by moving it to another commit.

## Branches and pull requests

- Branches are named `<type>/<short-name>`, for example `feat/actions-approve`, `fix/ingest-timezone`.
- The pull request title has the same format as a commit. The description says what was done, how it was tested and what is left.
- CI must be green before merging.
