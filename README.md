<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/kvitok-wordmark-light.svg">
    <img src="docs/brand/kvitok-wordmark.svg" alt="Kvitok" height="40">
  </picture>
</h1>

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Protocol: MIT](https://img.shields.io/badge/protocol-MIT-green.svg)](packages/protocol/LICENSE)

Kvitok is an open-source customer support system with an AI agent. Requests come in by email or over an API. The agent reads the customer's data in your backend, picks a department, drafts a reply and proposes actions such as crediting points or issuing a coupon. An operator reviews the result, talks it over with the agent in the ticket, sends the reply and approves the actions. Your backend then executes them.

Kvitok knows nothing about your business. A backend describes its data and actions through a small HTTP protocol, and the same installation can serve an online shop, a loyalty program and an internal tool, each in its own workspace.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/ticket-dark.webp">
  <img src="docs/screenshots/ticket.webp" alt="A ticket in Kvitok: the customer's message, the agent's analysis and two proposed actions waiting for the operator">
</picture>

<sub>A guest got neither points nor a promo cup for a purchase. The agent found the receipt in the backend, worked out what was missing and proposed two actions. Each one waits for the operator.</sub>

## At a glance

- [Why](#why). AI in support usually means a one-shot script: the model suggests, an operator repeats it by hand, and the customer hears nothing. Kvitok covers the whole path from the request to an executed action and a reply.
- [How it works](#how-it-works). Rules route the request, the agent reads your backend and proposes a reply and actions, and the operator corrects it in a chat and approves.
- [An example](#an-example). A guest is missing 44 points, followed from the first email to the points on the card.
- [What you can configure](#what-you-can-configure). Your backend publishes tools, actions and playbooks, the support team writes the policy, departments and routing rules in the UI, and the model is any OpenAI-compatible endpoint.
- [Safety](#safety). The agent only proposes. Every action is approved by a person and validated by the backend twice.
- [Connecting your backend](#connecting-your-backend). Six signed HTTP endpoints, with an MIT-licensed client, conformance suite and reference backend.
- [Getting started](#getting-started). Run it in Docker with a fake LLM and a coffee shop simulator, or let Claude Code connect your project.
- [Evaluating the agent](#evaluating-the-agent). `pnpm eval` runs test scenarios against a real model and reports which passed and what it cost.
- [Working with an external agent](#working-with-an-external-agent). Claude Code and other agents can configure and tune a workspace over MCP.
- [Status](#status). Early development, no releases yet, not ready for production.

## Why

Support with an AI agent usually starts as a script attached to one project: a job sends the request to an LLM once, gets back JSON with a department and suggested actions, and posts it to a messenger. An operator then repeats the actions by hand in an admin panel. The customer gets no reply from the system, the operator cannot ask the agent anything, and nobody records which suggestions were carried out.

Kvitok replaces that script with a full loop. The agent works on the ticket as long as the ticket is open, the operator corrects it in plain words, approved actions run in the backend through an API, and the reply goes back to the customer through the channel the request came from or by email.

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/how-it-works-dark.svg">
  <img src="docs/diagrams/how-it-works.svg" alt="A request in six steps across four lanes. The customer writes in; Kvitok finds the customer in your backend and applies routing rules; the agent calls read tools and proposes a draft and actions that the backend validates; the operator reviews the ticket in a chat with the agent, which revises the draft; the operator approves, the backend executes the actions and the customer gets the reply">
</picture>

1. A request arrives through a mailbox (IMAP) or the ingest API. Kvitok finds the customer in your backend by phone, email, card number or any other identity the backend supports.
2. Deterministic rules run first. They can set a department, priority, tags or fields, or skip the agent entirely, for example for partner emails.
3. The agent loads the customer card and calls read tools in your backend: receipts, orders, coupons, whatever the backend exposes. It follows playbooks for typical requests, picks a department with a confidence score and writes a reply draft.
4. Each action the agent proposes is validated by the backend right away. If the receipt belongs to another customer or the points were already credited, the agent sees the error and corrects itself.
5. The operator sees all of this in the ticket, which works like a chat. Anything the operator types goes to the agent: "the guest says the receipt was 540", "offer a coupon instead", "make the reply shorter". The agent updates only what the message affects.
6. Approved actions are executed by the backend with an idempotency key, so a retry never applies an action twice. The reply goes out by email or to the source's webhook.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/queue-dark.webp">
  <img src="docs/screenshots/queue.webp" alt="The ticket queue with departments set by the agent">
</picture>

<sub>The queue after the agent's first pass. Each ticket has a department, except the two where the agent was not confident enough to pick one.</sub>

## An example

A guest writes through the app form: "On the evening of October 13 I got a raf and a sandwich at Kristall for 640 rubles, I tapped my card, and the points never came."

The agent finds the guest by the phone number from the form and fetches the receipts. Receipt 4112 is on the card but earned nothing, so it proposes crediting 44 points, the guest's 7% tier on 640. The backend validates the action, and the agent routes the ticket to the loyalty department and drafts a reply.

After a phone call with the guest, the operator writes to the agent: "Boris called back: the October 13 receipt is the only one missing. He asked when the points will show up, please mention that in the reply." The agent checks its numbers again, leaves the proposal as it was and rewrites only the draft.

The operator approves the action and the backend credits the points. One more message, "The points are credited. Update the reply: say they are already on his card", and the agent updates the draft again. The operator sends it by email and the ticket is resolved.

<img src="docs/screenshots/ticket-chat.webp" alt="The whole ticket: the guest's message, the agent's proposal, two operator messages to the agent, the executed action and the reply sent by email">

You can run the same scenarios on your machine with the coffee shop simulator described below.

## What you can configure

Your backend publishes a manifest with its tools, actions, playbooks, departments and domain knowledge, and the agent picks up a new version without a change in Kvitok (see the [Support Action Protocol](docs/protocol.md)). The backend team keeps this knowledge in git next to their code. The support team writes its policy (tone, what not to promise, when to hand over to a human) and its departments in the UI. Every change creates a new version, and each agent run records the version it used.

The model is anything behind an OpenAI-compatible endpoint with tool calling: OpenAI, OpenRouter, a LiteLLM proxy, vLLM or Ollama. Each workspace sets its own provider, model and prices, so every agent run has a known cost. A ticket shows what the agent spent on it, and the Analytics page breaks spending down by day, department, model and ticket, next to ticket volume, response times and how operators used the agent's drafts.

<img src="docs/screenshots/agent-settings.webp" alt="Agent settings: the model, the support policy written by the support team and the list of LLM providers">

Routing rules run before and after the agent. They match the channel, the sender and their domain, the subject and body (regular expressions included), source metadata, ticket and customer fields, and the hour and weekday. After the agent they can also use its department, its confidence and whether it asked for a human. Tickets below a confidence threshold go to a triage queue, and a department set by an operator stays fixed.

<img src="docs/screenshots/rules.webp" alt="Routing rules before and after the agent">

Each workspace defines its own ticket and customer fields, and Kvitok records who filled in each value. Requests come from mailboxes over IMAP and SMTP and from API channels, which get replies and status changes back through signed webhooks. The interface is in English or Russian, set once per installation; a new language is one more YAML catalog.

## Safety

The agent never acts on its own. It proposes actions, an operator approves them, and the backend validates the parameters again before executing.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/safety-dark.svg">
  <img src="docs/diagrams/safety.svg" alt="The life of an action: the agent proposes it; the backend validates it and returns a preview, or an error the agent corrects; the operator approves it; the backend validates it again against the current state and executes it once by idempotency key">
</picture>

Customer messages and data from the backend reach the model wrapped in tags and marked as untrusted. The agent cannot pick which customer it works with: Kvitok passes the customer reference from the ticket, and the backend answers requests for another customer's objects as if they did not exist. Mailbox passwords, webhook secrets and model keys are encrypted at rest.

<img src="docs/screenshots/prompt-injection.webp" alt="A customer message posing as a system instruction to credit 500 points; the agent proposes nothing and asks the operator">

<sub>A guest's message pretends to be an operator instruction to credit 500 points and issue a coupon. The agent treats it as customer text, proposes nothing and asks the operator whether such an approval exists.</sub>

See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## Connecting your backend

A backend implements a few signed HTTP endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /manifest` | tools, actions, playbooks, departments, domain knowledge |
| `POST /customers/resolve` | find a customer by phone, email or another identity |
| `POST /context` | the customer card shown to the agent and the operator |
| `POST /tools/{name}` | read data for the agent |
| `POST /actions/{name}/validate` | check proposed parameters and return a preview |
| `POST /actions/{name}/execute` | execute an approved action, idempotently |

The existing support pipeline can stay in place: Kvitok can receive copies of the same requests and run alongside it, so you can compare the two before switching.

<img src="docs/screenshots/integration.webp" alt="A connected backend: its tools, actions, knowledge for the agent and suggested departments, all from the manifest">

[`packages/protocol`](packages/protocol) has the schemas, the request signing, a client and a conformance suite you can run against your staging backend. The coffee shop simulator in [`apps/coffee-sim`](apps/coffee-sim) is a complete reference implementation. Both are MIT licensed, so you can copy their code into a closed backend.

## Getting started

> [!WARNING]
> Kvitok is not ready for production. It has no releases, it has not run in production, and the only stack in the repository is the development one: hot reload, demo credentials, example secrets in `.env.example`, nothing hardened. There is no deployment guide yet. Use Kvitok locally to try it and to connect your project in development, with synthetic or staging data, never real customer requests.

### Run Kvitok locally

You need Docker. The development stack includes Postgres, Redis, Mailpit, the API, the queue worker, the web interface, the coffee shop simulator and a fake LLM that answers by simple rules, so no model key is required.

```bash
cp apps/api/.env.example apps/api/.env
```

```bash
docker compose up -d
```

The first start installs dependencies and applies migrations, which takes a couple of minutes. Then create a demo workspace and an admin user:

```bash
docker compose exec api pnpm --filter @kvitok/api db:seed
```

Open http://localhost:3000 and sign in as `admin@example.com` / `admin12345`. The API is at http://localhost:3001. Without `db:seed`, the first visit opens a setup page that creates the first superadmin and workspace.

### Run it on a server

A production installation runs from the published Docker image with one compose file: the app, the queue worker and, optionally, Postgres, Redis and Caddy with automatic HTTPS. Each of the three can be replaced with your own. See [docs/deployment.md](docs/deployment.md).

### Try it on the simulator

1. Settings → Agent → LLM providers: add `http://fake-llm:3999/v1` with any model name, or a real provider and key. The fake LLM only shows the flow; to see the agent reason, use a real model.
2. Settings → Integrations → Connect a backend: address `http://coffee-sim:3100`, secret `coffee-sim-dev-secret`.
3. Settings → Channels: create an API channel and copy its key, which is shown once. Then load the simulator's scenario tickets:

```bash
docker compose exec coffee-sim pnpm --filter @kvitok/coffee-sim seed --api http://api:3001/api --channel <channelId> --key <channel key>
```

### Connect your project with Claude Code

Kvitok ships a [Claude Code](https://claude.com/product/claude-code) plugin that works in your backend's repository and in Kvitok at once. It studies how your support works today, adds the protocol endpoints to your backend and sets up a workspace for your project.

Create an access token in Settings → Access tokens, install the plugin from your Kvitok checkout, and start Claude Code in your backend's repository with the backend running:

```bash
claude plugin install kvitok --marketplace "$(pwd)"
```

```bash
export KVITOK_URL=http://localhost:3001 KVITOK_TOKEN=kvt_…
```

```bash
claude
```

Then ask it to set Kvitok up for the project. Kvitok runs in containers, so it reaches a backend on your machine at `host.docker.internal`, not `localhost`. You add the model provider yourself, and your model key never passes through Claude Code. The token scopes, an example request and the review afterwards are in [docs/mcp.md](docs/mcp.md#setting-up-a-project-with-claude-code).

### Connect your project by hand

Implement the endpoints from [docs/protocol.md](docs/protocol.md) in your backend; the simulator in [`apps/coffee-sim`](apps/coffee-sim) is a complete example. Check them with the conformance suite, then connect the backend in Settings → Integrations and configure departments, fields, rules and the policy in the settings. Send requests through an API channel or a mailbox.

[docs/development.md](docs/development.md) covers running without Docker, the simulator, agent evaluation, the checks and migrations.

## Evaluating the agent

The simulator ships with scenarios: a world of customers, receipts and coupons, a ticket, and the expected outcome (department, actions and their parameters, actions that must not be proposed). `pnpm eval` runs them all against a real model and reports which passed, along with tokens and cost. Use it to compare models or to check a change to the policy or the playbooks before it reaches customers. Each run costs money, so set `--budget`.

## Working with an external agent

Kvitok serves an MCP endpoint at `/api/mcp`. With a personal access token, Claude Code or another agent can read the configuration, tickets and agent runs, change departments, fields, rules, playbooks and the support policy, and replay past tickets to see what a change would do. Every change goes to the change log under the token that made it. See [docs/mcp.md](docs/mcp.md).

## Status

Kvitok is in early development: it has no releases and has not run in production. Working today: email and API channels, routing rules, custom fields, the agent with read tools and validated actions, the ticket chat with the agent, integrations through the protocol, agent evaluation, an MCP server for external agents and the English and Russian interface.

The agent's prompt is in English. The agent drafts replies in the customer's language and writes summaries, findings and messages for the operator in the installation language. Next up are operator notifications (web push and Telegram), then an automatic mode for safe cases, SLA, templates and macros, and a website widget and a Telegram bot as sources.

## Built with

NestJS on Fastify, Prisma with PostgreSQL, BullMQ with Redis, Nuxt 4 with Nuxt UI, and zod schemas shared between the API, the UI and the protocol.

## Documentation

- [docs/protocol.md](docs/protocol.md): the Support Action Protocol
- [docs/development.md](docs/development.md): running, configuring and testing
- [docs/deployment.md](docs/deployment.md): running in production from the Docker image
- [docs/mcp.md](docs/mcp.md): the MCP server for external agents
- [CHANGELOG.md](CHANGELOG.md): what each release changed

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the commit format and the checks, and the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Copyright (C) 2026 Egor Lazarev.

The system (`apps/api`, `apps/web`, `packages/shared`, `packages/i18n` and everything else not listed below) is licensed under the [GNU Affero General Public License v3.0](LICENSE). You may use, modify and run it, including commercially; if you offer a modified version to users over a network, you must make its source code available to them under the same license.

The protocol packages are licensed under the [MIT License](packages/protocol/LICENSE), so backends can implement the protocol and embed its code without taking on the AGPL:

- `packages/protocol`: schemas, request signing, client and conformance checks;
- `apps/coffee-sim`: the reference backend that speaks the protocol.
