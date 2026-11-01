# Changelog

Notable changes for people who run Kvitok or connect a backend to it. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html): before 1.0.0, a minor version may break compatibility, and such a change is marked **Breaking** with migration steps. How versions are cut: [CONTRIBUTING.md](CONTRIBUTING.md#releases).

## [Unreleased]

### Fixed

- Web push to iPhone and iPad failed with `403 BadJwtToken` when `VAPID_SUBJECT` was not set and `WEB_ORIGIN` was not https: Apple rejects the `mailto:admin@localhost` contact sent then. The contact now defaults to `WEB_ORIGIN` on a public https domain, else to the first superadmin's email, and the API logs a warning when neither is public. `VAPID_SUBJECT` must now be `mailto:…` or an https URL, or the API does not start.

## [0.3.0] - 2026-11-01

### Added

- Web push notifications for operators. In Notifications (the bell next to the profile) each person turns them on per browser or device and chooses, per workspace, which events reach them: new tickets, assignments, customer messages, questions and proposals of the agent, undelivered replies and, for admins, agent failures. Each event can cover their own tickets, unassigned ones or all, and tickets of others can be narrowed by department and priority. A new ticket or customer message waits up to 45 seconds for the agent's analysis, so the notification shows the department and the summary; messages during the wait join one notification. The page checks the current device step by step (HTTPS, browser support, the Home Screen on iPhone and iPad, the permission) and says how to fix what fails. Signing out on a device stops its notifications. Push needs HTTPS; the VAPID keys are generated on first use, or set with `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT`.
- Department access: an admin can limit an operator or a viewer to chosen departments in Settings → Members, when adding them, and a superadmin in Administration → Users. Such a member sees and works only with tickets of those departments: in the queue, search, the ticket page, live updates, analytics, the test mailbox outbox, notifications and over MCP with their access token. Members of the triage department also see tickets without a department. Only a member who sees a ticket's department can be its assignee: a ticket moved to a department its assignee cannot see is unassigned, and so are a member's open tickets in departments they lose and, when the triage department changes, tickets without a department whose assignee no longer sees them. An operator can still hand a ticket over to a department they cannot see, after a confirmation. Existing members keep every department, and admins always see everything.
- For the API: the members API, `PUT /api/admin/users/:id/memberships/:workspaceId` and `/api/auth/me` carry each member's departments; the event stream `/api/workspaces/:id/events` sends only events of tickets the user may see, plus `ticket.moved` when a ticket changes department and `access.changed` when the user's own access changes. A ticket outside the caller's departments answers 404, like a missing one.

### Changed

- The MCP `get_prompt_preview` tool needs the admin role, like the prompt preview in the interface: it shows the whole ticket and reads the customer's data from the backend.

## [0.2.0] - 2026-11-01

### Added

- The ticket queue has filters by assignee, department, priority, channel, tags, agent state, creation and last message dates, and custom fields marked "In filters", each with several values. A "Waiting for a decision" filter finds tickets with an open question from the agent, a proposed action or a customer to confirm, and the queue marks such tickets. The queue can be sorted by the oldest message, creation date or priority, and the tabs show ticket counts.
- Operators can select tickets in the queue, by page or every ticket matching the filter (up to 500), and change their status, assignee, priority, department or tags at once. Each ticket goes through the same checks and webhooks as a single change; tickets that refuse it, for example without required fields, stay selected with the reason. The API is `POST /api/workspaces/:id/tickets/bulk`; the list API takes comma-separated values and the new filters.
- Saved queue views: save the current tab, filters, sort and search under a name, open it from the menu next to the filters, save changes to it, rename or delete it. Views are personal; admins can also share one with the whole workspace, and changes to shared views appear in the audit log. The queue reopens with the filters it was last left with in this browser.
- The running version is shown next to the logo in the sidebar and links to the Kvitok repository on GitHub.

### Changed

- Consecutive ticket events between messages, such as the department, tags and fields set by rules and the agent, collapse into one line with their results and expand on click. Delivery and action failures and status changes stay on their own lines, and failures are shown in red.

### Fixed

- The first reads of a new workspace's agent settings no longer fail with a unique constraint error when they run at once, for example in the MCP `describe_workspace` tool.

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
