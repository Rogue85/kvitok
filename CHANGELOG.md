# Changelog

Notable changes for people who run Kvitok or connect a backend to it. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html): before 1.0.0, a minor version may break compatibility, and such a change is marked **Breaking** with migration steps. How versions are cut: [CONTRIBUTING.md](CONTRIBUTING.md#releases).

## [Unreleased]

### Added

- The ticket queue has filters by assignee, department, priority, channel, tags, agent state, creation and last message dates, and custom fields marked "In filters", each with several values. A "Waiting for a decision" filter finds tickets with an open question from the agent, a proposed action or a customer to confirm, and the queue marks such tickets. The queue can be sorted by the oldest message, creation date or priority, and the tabs show ticket counts.
- Operators can select tickets in the queue, by page or every ticket matching the filter (up to 500), and change their status, assignee, priority, department or tags at once. Each ticket goes through the same checks and webhooks as a single change; tickets that refuse it, for example without required fields, stay selected with the reason. The API is `POST /api/workspaces/:id/tickets/bulk`; the list API takes comma-separated values and the new filters.
- Saved queue views: save the current tab, filters, sort and search under a name, open it from the menu next to the filters, save changes to it, rename or delete it. Views are personal; admins can also share one with the whole workspace, and changes to shared views appear in the audit log. The queue reopens with the filters it was last left with in this browser.

### Changed

- Consecutive ticket events between messages, such as the department, tags and fields set by rules and the agent, collapse into one line with their results and expand on click. Delivery and action failures and status changes stay on their own lines, and failures are shown in red.

## [0.1.0] - 2026-11-01

The first release.

### Added

- Tickets from a mailbox (IMAP) and from the ingest API, replies by email or to the source's webhook.
- An AI agent that reads the customer's data in a connected backend, picks a department, drafts a reply and proposes actions. The operator talks it over with the agent in the ticket and approves each action.
- The Support Action Protocol for connecting backends, version 1, with an MIT-licensed client and conformance suite.
- Routing rules, departments, custom fields, playbooks, customer identification and an audit log per workspace.
- Agent cost per ticket and over time.
- Users with access per workspace, superadministrators and a first-run setup page.
- An MCP server for configuring a workspace from an external agent.
- Running in production from one Docker image, with optional bundled Postgres, Redis and Caddy. The running version is shown in the profile and in `GET /api/health`.
