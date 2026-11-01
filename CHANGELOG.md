# Changelog

Notable changes for people who run Kvitok or connect a backend to it. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html): before 1.0.0, a minor version may break compatibility, and such a change is marked **Breaking** with migration steps. How versions are cut: [CONTRIBUTING.md](CONTRIBUTING.md#releases).

## [Unreleased]

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
