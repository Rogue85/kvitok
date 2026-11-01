# Development

How to run Kvitok locally, configure the agent and the simulator, evaluate the agent and run the checks. For what the system is and how it works, see the [README](../README.md).

## Structure

```
apps/api          NestJS (Fastify) + Prisma + BullMQ: HTTP API (main.ts), queue worker (worker.ts), CLI (cli.ts)
apps/web          Nuxt 4 + Nuxt UI: the operator interface
apps/coffee-sim   a coffee shop backend simulator speaking the protocol: synthetic data and scenarios with expected answers
packages/shared   zod schemas and types shared by the API and the UI
packages/protocol Support Action Protocol: schemas, signing, client, conformance checks
packages/i18n     translation catalogs shared by the API and the UI
```

## Running locally

The whole development environment runs in Docker: Postgres, Redis, Mailpit, the API, the queue worker, the web interface, the coffee-sim simulator and a fake LLM. The code is mounted from the host and changes are picked up on the fly (Nest in watch mode, HMR in Nuxt, `tsx watch` in the simulator).

First start:

```bash
cp apps/api/.env.example apps/api/.env
```

```bash
docker compose up -d
```

On the first start the `deps` service installs dependencies into the container volumes and builds `packages/*`, and `migrate` applies the migrations. This takes a couple of minutes. Then create demo data:

```bash
docker compose exec api pnpm --filter @kvitok/api db:seed
```

`db:seed` creates the "Demo" workspace and the superadmin `admin@example.com` / `admin12345` (for development only).

| Service | From the host | From containers |
| --- | --- | --- |
| Web interface (proxies `/api` to the API) | http://localhost:3000 | |
| API | http://localhost:3001 | `http://api:3001` |
| coffee-sim simulator | http://localhost:3100 | `http://coffee-sim:3100` |
| Fake LLM | http://localhost:3999/v1 | `http://fake-llm:3999/v1` |
| Mailpit | http://localhost:8025, SMTP :1025 | SMTP `mailpit:1025` |
| Postgres (`kvitok` / `kvitok`, database `kvitok`) | localhost:5432 | `postgres:5432` |
| Redis | localhost:6379 | `redis:6379` |

Addresses the API and the worker call themselves (an integration, an LLM provider, a mailbox's SMTP) are set in the settings by service name: `localhost` inside a container is the container itself. A service running on your machine, such as the backend you are connecting, is `http://host.docker.internal:<port>`.

Logs:

```bash
docker compose logs -f api worker
```

After changes to `pnpm-lock.yaml`, `packages/shared`, `packages/protocol` or `packages/i18n`, reinstall dependencies and rebuild the packages, then restart the API, the worker and the web interface (Vite keeps the previous build of the packages otherwise):

```bash
docker compose run --rm deps
```

```bash
docker compose restart api worker web
```

Tests, checks and migrations run on the host (Node ≥ 22, pnpm 10 via `packageManager`) against Postgres and Redis from compose. The addresses come from `apps/api/.env`:

```bash
pnpm install
```

```bash
pnpm check
```

If ports 5432 or 6379 are taken (for example by a local Postgres and Redis), set other ones in the root `.env` (`POSTGRES_PORT=5433`, `REDIS_PORT=6380`) and use the same ports in `DATABASE_URL` and `REDIS_URL` in `apps/api/.env`. Containers talk to each other inside the compose network and do not care about these ports.

Attachments are stored on the host disk in `apps/api/storage`. MinIO is not used yet and starts separately: `docker compose --profile minio up -d minio`.

### Without Docker

You need Node ≥ 22, pnpm 10, PostgreSQL 17 and Redis; put their addresses into `apps/api/.env`. If the Postgres cluster was created with the `C` locale, create the database with an ICU locale, otherwise case-insensitive search in non-Latin scripts will not work:

```bash
psql -d postgres -c "CREATE DATABASE kvitok TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER icu ICU_LOCALE 'und' LOCALE 'C'"
```

```bash
pnpm install && pnpm --filter @kvitok/api db:deploy && pnpm --filter @kvitok/api db:seed
```

The API on :3001 and the UI on :3000:

```bash
pnpm dev
```

The queue worker. Without it replies are not sent (email, webhooks) and mail is not received:

```bash
pnpm --filter @kvitok/api dev:worker
```

There are two options for sending email during development:

- **Test mailbox** (Settings → Channels → Test mailbox). It needs no SMTP: emails stay in the system and are visible on the channel's Outbox page (to, cc, HTML, headers, `.eml`). Make it the default mailbox to reply by email on simulator tickets.
- **Mailpit** (web interface on :8025). In the channel settings use SMTP `mailpit:1025` without SSL (`localhost:1025` if the API runs without Docker).

## Languages

The interface language is set once per installation with `APP_LOCALE` in `apps/api/.env` (`en` by default, `ru` is available). The UI, API messages, validation errors and system texts follow it; users do not pick a language individually.

Translations live in one file per language: [packages/i18n/locales/en.yaml](../packages/i18n/locales/en.yaml) and [ru.yaml](../packages/i18n/locales/ru.yaml). English is the source of truth: message keys are generated from it and typed, so a missing key fails type checking. Placeholders look like `{name}`; plural messages list CLDR categories (`one`, `other`, and `few`, `many` where the language needs them). After editing, run:

```bash
pnpm --filter @kvitok/i18n test
```

To add a language, add `locales/<code>.yaml` and the code to `LOCALES` in `packages/i18n/src/index.ts`.

The agent prompt and the texts the agent sends to the model are in English (`apps/api/src/agent/`): the agent drafts replies in the customer's language and writes everything for the operator in the installation language. Changing these texts needs an evaluation run (see below). The coffee-sim dataset exists in English and Russian (see below).

## Agent

1. Settings → Agent → "LLM providers": add an OpenAI-compatible endpoint (OpenAI, OpenRouter, LiteLLM, vLLM, Ollama), a key and models with prices. The "Check" button sends a short request to the model.
2. Choose a provider and a model, optionally write a support policy, and enable the agent.
3. Settings → Playbooks: scenarios for typical requests. Settings → Rules: deterministic routing before and after the agent.

The worker executes the runs. Without a model key you can use the fake server as the provider with any model name. In docker compose it is already running: `http://fake-llm:3999/v1`. Without Docker:

```bash
pnpm --filter @kvitok/api fake-llm   # http://localhost:3999/v1
```

## Backend simulator (coffee-sim)

A test backend of a coffee shop chain: guests, receipts, promos, coupons, a "6th cup free" program, orders — on synthetic data from `apps/coffee-sim/scenarios`. It implements the [protocol](protocol.md), so integrations and actions are developed and tested against it, and the scenarios with expected answers serve as the agent evaluation set.

The simulator speaks one language per run: `en` (default) or `ru`. The language picks the dataset (`scenarios/<locale>`, `content/<locale>`) and every text the agent and the operator see: tool and action descriptions, previews, errors. Both datasets describe the same world — ids, amounts, dates and expectations match, a test keeps them in sync — so evaluation results in the two languages are comparable. Set it with `--locale` or `SIM_LOCALE`; for docker compose put `SIM_LOCALE=ru` into the `.env` next to `docker-compose.yml`.

In docker compose the simulator is already running; in a workspace integration its address is `http://coffee-sim:3100`. Without Docker:

```bash
pnpm --filter @kvitok/coffee-sim dev           # http://127.0.0.1:3100, secret in SIM_SECRET, language in SIM_LOCALE
```

```bash
pnpm --filter @kvitok/coffee-sim exec tsx src/cli.ts scenarios   # scenarios and expectations
```

```bash
pnpm --filter @kvitok/coffee-sim conformance   # protocol checks against the simulator
```

Connect the simulator as an integration: Settings → Integrations → "Connect a backend", address `http://coffee-sim:3100` (`http://127.0.0.1:3100` without Docker), secret `SIM_SECRET` (`coffee-sim-dev-secret` by default). The manifest brings knowledge for the agent and playbooks; departments can be created with a button. The worker checks the manifest every `INTEGRATION_SYNC_MINUTES` minutes (15 by default).

Create the scenario tickets in the system (an API channel is required):

```bash
pnpm --filter @kvitok/coffee-sim seed --channel <channelId> --key <channel key>
```

A scenario is a YAML file: world data (guests, receipts, coupons, orders), a ticket and an expectation (department, actions with parameters, forbidden actions). All scenarios share the same "now" (`scenarios/<locale>/_base.yaml`), so they can be loaded together or one by one. A new scenario is added to every language with the same file name; only the texts differ (names, items, the ticket, notes), and the numbers in them stay the same. The service endpoints `/__sim/*` reset the world, show the journal of executed actions and switch on failures (`timeout`, `error_500`, `drop_response`).

## Agent evaluation

Runs all simulator scenarios on a real model and compares them with the expectations: department, proposed actions and their parameters, forbidden actions, tokens and cost.

```bash
pnpm eval --from coffee-sim --concurrency 3
```

- `--from` is the workspace that provides the policy, settings, departments, playbooks, provider and model of the agent: this is the configuration being evaluated. Domain knowledge and the backend's playbooks come from the simulator manifest.
- Without `--from` the provider comes from `EVAL_LLM_BASE_URL`, `EVAL_LLM_API_KEY`, `EVAL_LLM_MODEL` (prices in `EVAL_LLM_PRICE_IN` / `EVAL_LLM_PRICE_OUT`, their currency in `EVAL_LLM_CURRENCY`; it becomes the evaluation workspace currency). This is how the `.github/workflows/eval.yml` workflow runs (manually and nightly).
- `--locale ru` — the language of the scenarios; by default the installation language (`APP_LOCALE`). The report records it: compare runs in the same language.
- `--scenarios a,b` or `--tag hard` (a harder set), `--repeat 3` (each scenario several times — shows flaky ones; the model is nondeterministic), `--model`, `--budget 20` (do not start new scenarios over budget), `--min-pass 0.8` (exit code 1 if fewer scenarios pass).

The report (markdown and JSON) is written to `eval-reports/`. Every run recreates the "Agent evaluation" workspace (`eval`): it holds the scenario tickets with analyses and proposed actions, which can be opened in the interface.

An evaluation spends money on the model: run it deliberately and with `--budget`.

## Connecting a source

- **API channel** (Settings → Channels → API channel). The key is shown once. Requests are sent with `POST /api/v1/ingest/<channelId>` and the `Authorization: Bearer <key>` header; the key dialog has an example. If a webhook is set, the source receives operator replies (`message.created`) and status changes (`ticket.status_changed`), signed with the `X-Support-Signature: sha256=HMAC(secret, "<timestamp>.<body>")` header.
- **Mailbox**: SMTP for replies and IMAP for receiving. The first mailbox becomes the default one; through it you can reply by email to a ticket from the API if the customer has an email.
- **Test mailbox**: a mailbox without SMTP or IMAP; emails go to its Outbox and never leave the system.

A reply "to the source" goes through the webhook of the API channel the ticket came through. A webhook of another channel is not used for it.

## Users and access

A fresh installation without `db:seed` opens the first-run page `/setup`: it creates the first superadministrator and the first workspace (name and currency) and signs in. The page closes as soon as the installation has a superadministrator.

Users belong to the installation, access is granted per workspace with a role: administrator, operator or viewer.

- **Administration → Users** (superadministrators): invite a user and choose their workspaces, change access, give or take the superadministrator flag, disable and enable, issue a password reset link, see the history. A disabled user cannot sign in or be assigned tickets; their sessions and tokens stop working.
- **Settings → Members** (workspace administrators): give access to an existing user of the installation or invite a new person.
- **Profile**: the name, the password and the sessions.

There is no system mail, so an invitation or a reset is a one-time link (valid for 7 days) that the administrator copies and passes on. The person sets their own password with it.

A user can also be created from the command line:

```bash
pnpm --filter @kvitok/api build && pnpm --filter @kvitok/api cli user:create --email ops@example.com --password 'secret-pass' --name 'Ops' --superadmin
```

## External agents (MCP)

The API serves an MCP endpoint at `http://localhost:3001/api/mcp`. Create a token in Settings → Access tokens and connect a client, for example Claude Code:

```bash
claude mcp add --transport http kvitok http://localhost:3001/api/mcp --header "Authorization: Bearer kvt_…"
```

Tools, scopes and safety notes are in [mcp.md](mcp.md).

## Checks

```bash
pnpm check
```

This runs type checking, tests and a build of all packages. The API tests create a separate database `<name from DATABASE_URL>_test` and recreate it on every run. Postgres and Redis must be running.

A migration after changing `apps/api/prisma/schema.prisma`:

```bash
pnpm --filter @kvitok/api exec prisma migrate dev --name <name>
```

```bash
pnpm --filter @kvitok/api exec prisma generate
```
