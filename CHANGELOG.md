# Changelog

Notable changes for people who run Kvitok or connect a backend to it. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html): before 1.0.0, a minor version may break compatibility, and such a change is marked **Breaking** with migration steps. How versions are cut: [CONTRIBUTING.md](CONTRIBUTING.md#releases).

## [Unreleased]

## [0.5.0] - 2026-11-02

### Added

- Tickets can have several assignees. Pick them in the ticket's properties: members of the ticket's department come first, the rest are listed with their departments and whether they accept tickets. Bulk actions add an assignee to every selected ticket or remove all of them. The queue's assignee filter finds tickets where any of the chosen people is an assignee.
- Departments can hand tickets out in turn. In Settings → Departments set "Assignment" to "In turn": a ticket that lands in the department, by a routing rule, the agent or an operator, goes to the next member of the department who accepts tickets, unless one of its assignees already works there; so does a reopened ticket none of whose assignees works there. Each operator switches "Accepting tickets" at the bottom of the sidebar; admins can switch it for anyone in Settings → Members. Pausing keeps the tickets a person has, and tickets that arrive while nobody accepts them stay unassigned. Existing departments keep assigning by hand.
- Two settings in Settings → General, both on by default. "Assign the operator who works on a ticket": whoever replies to the customer, writes to the agent or decides on an action becomes an assignee. "Assignees keep their tickets in other departments": an assignee keeps a ticket moved to a department they cannot see, and operators can call in members of other departments to work on a ticket together; such an assignee sees only that ticket. Turning it off removes assignees outside their departments from open tickets and hands those tickets out again.
- MCP: `create_department` and `update_department` take `assignmentMode`, `update_workspace` takes the assignment settings, the new `list_members` and `set_accepting_tickets` tools manage who accepts tickets, `describe_workspace` shows all of it, and `search_tickets` and `get_ticket` filter by and show the assignees.
- For the API: `PUT /api/workspaces/:id/members/:userId/accepting-tickets` (a member for themself, an admin for anyone); `acceptingTickets` in members and in `/api/auth/me`, `assignment` in the workspace, `assignmentMode` in departments.

### Changed

- **Breaking:** the tickets API has `assignees` (each with `source`: `manual`, `rule`, `auto` or `action`) instead of `assignee`. `PATCH /api/workspaces/:id/tickets/:ticketId` and the bulk change take `assigneeIds` (the whole list; `[]` removes everyone), or `addAssigneeIds` and `removeAssigneeIds`, instead of `assigneeId`, which is now refused. Replace `assigneeId: id` with `assigneeIds: [id]` and `assigneeId: null` with `assigneeIds: []`. Ticket events record `assignees_changed` with the added and removed people instead of `assignee_changed`. On upgrade a ticket keeps its assignee if that person still sees the ticket's department through their own departments; an assignee who no longer does (a closed ticket of a member restricted later, a member who left) is dropped, since an assignee can now see the ticket.
- A ticket moved to a department its assignee cannot see no longer loses that assignee, unless "Assignees keep their tickets in other departments" is off. The `ticket.access` event of `/api/workspaces/:id/events` tells the people added to or removed from a ticket's assignees that their access to it may have changed.
- The agent stops moving a ticket between departments once a person of the ticket's department has taken it: assigned by hand or by a rule, or worked on it. An assignee the department gave the ticket to in turn who has not worked on it yet, a member of another department called in, and anyone while the ticket is in the triage department do not count, so telling the agent in triage where a ticket belongs still lets it move the ticket.
- Removing a member from a workspace removes them from its tickets' assignees, and their open tickets are handed out again where the department does so.

## [0.4.0] - 2026-11-01

### Changed

- **Breaking:** `VAPID_SUBJECT` must now be `mailto:…` or an https URL, or the API does not start. If you set it to a bare address such as `you@example.com`, change it to `mailto:you@example.com` before updating, or remove it to use the default. `deploy/.env.example` now lists the VAPID settings.
- The web interface works on phones. Below tablet landscape width a tab bar at the bottom leads to tickets, analytics and notifications, and "More" opens the full menu. The ticket queue is a list of cards with the status, priority, department, assignee and list fields, and sorting and bulk actions take less room. A ticket fills the screen: the properties open as a sheet, the header keeps the number and the subject, and the composers fit the width. Settings, administration and the profile show their tables as cards on phones, and their forms and dialogs stack into one column. On iPhone the app respects the notch and the home indicator when installed on the Home Screen, and fields no longer zoom the page on focus. Desktop layouts are unchanged.

### Fixed

- Web push to iPhone and iPad failed with `403 BadJwtToken` when `VAPID_SUBJECT` was not set and `WEB_ORIGIN` was not https: Apple rejects the `mailto:admin@localhost` contact sent then. The contact now defaults to `WEB_ORIGIN` on a public https domain, else to the first superadmin's email, and the API logs a warning when neither is public.

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
