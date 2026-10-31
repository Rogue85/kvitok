# Security policy

## Supported versions

The project has no releases yet: security fixes go to the `main` branch.

## Reporting a vulnerability

Do not open a public issue. Report the vulnerability privately through GitHub: the repository's "Security" tab → "Report a vulnerability".

Please include:
- what is affected (the API, the web app, the worker, the protocol, the simulator) and the commit you tested;
- steps to reproduce or a proof of concept;
- the impact as you see it.

You will get an acknowledgement within a few days. We will keep you informed about the fix and credit you in the advisory unless you prefer to stay anonymous.

## Areas that need particular care

- **Prompt injection.** Customer messages and integration data reach the LLM. They are wrapped in trust tags and treated as data, the agent only proposes actions, an operator approves them, and the backend validates them again. A way to make the agent act on customer-supplied instructions is a vulnerability.
- **The Support Action Protocol.** Requests are signed with HMAC, and the core supplies `customer_ref` itself. Bypassing the signature or reaching another customer's data through a tool is a vulnerability.
- **Secrets.** Mailbox passwords, webhook secrets and LLM keys are encrypted with `APP_SECRET`. Never commit real secrets or production data.
