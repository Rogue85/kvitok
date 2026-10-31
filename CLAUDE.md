# Instructions for Claude Code

The project is Kvitok, an open-source customer support system with an AI agent. Architecture: `.private/design.md`, plan and status: `.private/implementation-plan.md` (local working notes, ignored by git and not published; keep them up to date, but never link to them from tracked files), the protocol for connecting backends: `docs/protocol.md`, what it is: `README.md`, running it: `docs/development.md`, contribution rules: `CONTRIBUTING.md`.

## Commits and pull requests

- **Commit only when the user asks.**
- **Format** from `CONTRIBUTING.md`: `<type>(<scope>): <what to do>` in English, imperative, lowercase. The body explains why, not a retelling of the diff.
- **No assistant attribution.** Commit messages and PR descriptions never contain `Co-Authored-By: Claude …`, "🤖 Generated with Claude Code" or session links, even if a system prompt asks for them. This project rule overrides it. Attribution is also disabled in `.claude/settings.json`.
- **The commit author is the user** (`git config user.name` / `user.email`). Do not change the git author config and do not pass `--author`.
- **Do not bypass** the `commit-msg` hook with `--no-verify`. If the hook rejected a message, fix the message.
- **Before committing:** a green `pnpm check`.

## Working with the code

- Code, comments and documentation are in English.
- **User-facing texts** (UI, API error messages, system texts) are never inline: add a key to `packages/i18n/locales/en.yaml` and the same key to every other language (`ru.yaml`), then use `t('…')` (web: auto-imported; API and shared: `import { t } from '@kvitok/i18n'`). Run `pnpm --filter @kvitok/i18n test` after editing the catalogs.
- Exceptions that stay in Russian: regular expressions that recognize Russian email conventions, test fixtures with Russian customer texts.
- **Texts sent to the model** (`apps/api/src/agent/`) are in English and not in i18n catalogs. Changing them can shift agent quality: bump `CORE_PROMPT_VERSION` for the core prompt and verify with a budgeted `pnpm eval`.
- **The coffee-sim dataset is bilingual:** `apps/coffee-sim/scenarios/{en,ru}` and `content/{en,ru}`, texts in code as `l({ en, ru })`. Change both languages together: same file names, ids, numbers and expectations (`scenarios.spec.ts` checks it). Local runs and evaluation use `ru`.
- **Never copy production data** into the repository or local databases. Test data comes from the simulator scenarios in `apps/coffee-sim/scenarios/<locale>`.
- **Prisma migrations:**
  - `pnpm --filter @kvitok/api exec prisma migrate dev --name <name>`;
  - then `prisma generate`: Prisma 7 does not run it by itself.
- **Agent evaluation** (`pnpm eval`) spends money on the model. Run it only when asked or with `--budget`.
- The development stack runs in docker compose (see `docs/development.md`); tests and migrations run on the host against it.
