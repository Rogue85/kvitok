# Support Action Protocol, version 1

How a project backend (an online shop, a loyalty program, an internal system) gives the support system customer data and executes actions. The backend implements a few HTTP endpoints; the support core calls them on behalf of the agent and the operator.

- Request and response schemas: `packages/protocol/src/schemas.ts` (zod). The core validates responses with them, and the conformance checks use them too.
- Reference implementation: the coffee shop simulator `apps/coffee-sim`.
- To check your own implementation, see "Conformance checks" at the end.

## Principles

- **The core does not know the domain.** What a customer has (receipts, orders, visits) and what can be done with them is described by the backend in its manifest.
- **The agent only proposes.** An action is executed after an operator approves it; the backend validates the parameters itself both on validate and on execute. An operator may also propose an action by hand from the ticket; it goes through the same validate and execute.
- **The core supplies the customer.** `customer_ref` comes from the ticket; the model cannot replace it. The backend must check that the requested objects (a receipt, an order) belong to this customer and respond to other customers' objects exactly as to nonexistent ones. This protects against prompt injection in emails.

## Request signing

Every core request is signed with the integration's shared secret:

```
X-Support-Timestamp: 1792060200
X-Support-Signature: sha256=<hex>
```

`hex` is HMAC-SHA256 with the secret over the string:

```
{timestamp}.{METHOD}.{path}.{body}
```

- `path` is the path with the query, as in the request line, including the prefix: `/api/support/tools/get_coupons`;
- `body` is the body as is, an empty string for GET;
- the allowed clock skew is ±300 seconds;
- the comparison is constant-time.

A wrong, expired or missing signature is `401 invalid_signature`.

Example check in PHP (Laravel):

```php
$ts = $request->header('X-Support-Timestamp');
$payload = $ts.'.'.strtoupper($request->method()).'.'.$request->getRequestUri().'.'.$request->getContent();
$expected = 'sha256='.hash_hmac('sha256', $payload, $secret);
abort_unless($ts && abs(time() - (int) $ts) <= 300 && hash_equals($expected, (string) $request->header('X-Support-Signature')), 401);
```

## Endpoints

Paths are relative to the integration's base URL.

| Method and path | Body | Response |
|---|---|---|
| `GET /manifest` | — | the manifest, an `ETag` header; `304` on `If-None-Match` with the same ETag |
| `POST /customers/resolve` | `{ identities: { phone?, email?, card_number?, … } }` | `{ status: found, customer_ref, display_name?, matched_by? }` · `{ status: not_found }` · `{ status: ambiguous, candidates: [{ customer_ref, display_name, hint?, matched_by? }] }` |
| `POST /context` | `{ customer_ref }` | the customer card: `{ title?, summary?, sections: [{ key, title, display, data }], refs, fields? }` |
| `POST /tools/{name}` | `{ customer_ref \| null, args }` | `{ summary?, data, display?, refs }` |
| `POST /actions/{name}/validate` | `{ customer_ref, params }` | `{ ok, normalized_params?, preview?, warnings[], errors[{ path?, message }] }` |
| `POST /actions/{name}/execute` | `{ customer_ref, params, context? }` + the `Idempotency-Key` header | `{ status: executed \| failed, result?, external_ref?, error? }` |
| `GET /actions/executions/{key}` | — | `{ status: executed \| failed \| pending \| unknown, action?, result?, external_ref?, error? }` |
| `GET /option-sets/{name}` | — | the options of a directory: `{ options: [{ value, label, group?, description?, active? }] }`, an `ETag` header; `304` on `If-None-Match` with the same ETag |

### Manifest

```json
{
  "protocol_version": 1,
  "name": "acme_coffee",
  "title": "Acme Coffee",
  "identity_types": [
    "email",
    { "type": "phone", "label": "Phone", "normalize": "digits" },
    { "type": "card_number", "label": "Loyalty card", "pattern": "(?<!\\d)(?<value>7777\\d{12})(?!\\d)", "normalize": "digits", "description": "16 digits starting with 7777" }
  ],
  "instructions": "How points, promos and the journal work… (markdown)",
  "tools": [{
    "name": "get_transactions",
    "title": "Guest receipts",
    "description": "For the model: what it returns and when to call it",
    "input_schema": { "type": "object", "properties": { "limit": { "type": "integer" } } },
    "display": "table",
    "requires_customer": true,
    "cache_ttl_seconds": 300,
    "examples": [{ "args": { "limit": 10 } }]
  }],
  "actions": [{
    "name": "accrue_points",
    "title": "Credit points",
    "description": "When it is appropriate and how to compute the parameters",
    "input_schema": { "type": "object", "required": ["basis", "amount"], "properties": { } },
    "requires_approval": true,
    "audience": ["agent", "operator"],
    "examples": [{ "params": { "basis": "base_cashback", "amount": 19, "transaction_id": null, "receipt_total": 380 } }]
  }, {
    "name": "adjust_points",
    "title": "Goodwill points",
    "description": "A compensation the rules do not cover",
    "input_schema": { "type": "object", "required": ["amount", "comment"], "properties": { "amount": { "type": "integer", "minimum": 1, "title": "Points" }, "comment": { "type": "string", "title": "Comment" } } },
    "audience": ["operator"]
  }],
  "playbooks": [{ "key": "points_not_accrued", "title": "…", "when": "…", "body": "markdown", "suggested_department": "loyalty", "tools": ["get_transactions"], "actions": ["accrue_points"] }],
  "suggested_departments": [{ "key": "loyalty", "title": "Loyalty", "description": "…", "examples": ["…"] }],
  "option_sets": [{ "name": "places", "title": "Coffee shops", "description": "value is the shop id, the same as place_id in get_transactions" }]
}
```

- The `name` of tools, actions, playbooks and departments is lowercase Latin letters, digits and `_`.
- `identity_types` lists what resolve searches by. An entry is a type name or an object:
  - `label` — how the support UI names the identity;
  - `pattern` — a JavaScript regular expression (matched case-insensitively) that finds such values in message text; the value is the named group `value`, otherwise group 1, otherwise the whole match. Values found this way are not trusted: the core sends them to resolve and the support team decides what a match means;
  - `normalize` — how values compare: `digits` (phones, cards), `lowercase` (emails), `none`;
  - `description` — for the agent: what the value looks like.
- `input_schema` is the JSON Schema of an object. The model sees it as the tool's argument schema, so write field descriptions for the model.
- `display` is how the UI shows the result: `kv`, `table`, `timeline`, `markdown`, `json`.
- `requires_customer: false` marks reference data (promos, menu) available without a resolved customer; the core passes `customer_ref: null`.
- `cache_ttl_seconds` is how long the result may be reused in later agent runs. After an operator message the agent does not fetch the same data again until it expires. `0` means do not reuse.
- `examples` are used for documentation, a test call in the UI and conformance checks.
- `audience` says who may start an action: `agent` — the agent proposes it, `operator` — an operator proposes it by hand from the ticket. The default is both. An action for operators only (`["operator"]`, for example a goodwill credit with your own limits) is never shown to the agent. A support core older than this field ignores it and offers such an action to the agent too; an operator still approves every action.
- An operator proposing an action by hand fills in a form built from `input_schema`. Flat parameters make a form: strings, numbers, integers, booleans, enums and nullable ones; a property's `title` labels its field and `description` hints under it. Nested objects, arrays and `oneOf`/`anyOf` get a JSON editor instead.
- `instructions` and `playbooks` are domain knowledge for the agent: how to read tool data and how to handle typical requests. The policy for talking to customers is set by the support team in its own interface and does not belong here.

### Option sets

A backend can publish directories for select fields: coffee shops, cities, products, plans. The support team binds a field to a directory; the core keeps the options in sync, the agent picks one of them, and the operator chooses from the same list.

- The manifest declares a directory in `option_sets`: `name`, `title` and `description`. Write the description for the model: what an option is and **where its value appears in tool data** ("value is the shop id, the same as `place_id` in `get_transactions`"). With that, the agent copies the id from a receipt instead of matching addresses.
- `GET /option-sets/{name}` returns all options. An option is:
  - `value` — up to 200 characters, unique in the set and **stable**: tickets store it. A new value is a new option. Ids are fine: operators see the label;
  - `label` — what the operator sees, up to 200 characters;
  - `group` — optional, up to 100 characters: groups options in the UI and tells repeated labels apart (a city, a category);
  - `description` — optional, up to 500 characters: aliases, landmarks, former names. The agent sees it, and the search covers it;
  - `active` — `false` retires an option (a closed shop): tickets keep it, but nobody can choose it anymore. An option the backend stops returning is retired the same way.
- At most 1,000 options in a set and 20 sets in a manifest.
- Return an `ETag`: the core syncs the sets with the manifest and asks with `If-None-Match`.
- An undeclared set is `404 unknown_option_set`.
- A failed sync never empties a set: the core keeps the previous options.

### Customer resolve

- The core sends every identity it has: the trusted ones (the email sender, identities from the source) and values people typed in messages. An identity that matches nobody is ignored.
- All matching identities point to one customer — `found`; to different customers (or one identity to several) — `ambiguous` with the candidates.
- `matched_by` lists the identity types that point to the customer (in `found` and in every candidate). It lets the core tell a customer confirmed by the sender's email from one found only by a card number someone typed. Without it, the core treats a match as made by the typed values only and asks the support team more often.

### Data: tools and context

- `data` goes to the model as is: compact JSON with clear keys. Times carry a time zone or a convention stated in `instructions`.
- `refs` are links to objects in the backend admin: `{ type, id, title?, url? }`.
- The core truncates large responses and tells the model the data was cut. It is better to limit the selection right away (`limit`, a period).
- Another customer's object is `404 not_found`, the same as a nonexistent one.
- The customer card may carry `fields`: customer attributes the support system can store in its customer fields (a tier, a plan, an employee number) — `{ "<key>": value }`, where a value is a string, a number, a boolean, `null` or a list of strings. The support team maps the keys to its fields; values are stored only for a customer the team trusts.

### Actions

- **validate** responds `200` even when the parameters are semantically invalid: `{ ok: false, errors: [...] }`. The agent gets the errors and can fix the parameters ("the receipt belongs to another guest", "points for the receipt were already credited"). `422` is only for parameters that fail `input_schema`.
- `normalized_params` are the parameters that will be executed, for example a recalculated amount; the difference is explained in `warnings`.
- `preview` is one line for the operator: what will happen.
- **execute** must run the validate checks again: the data may have changed since the proposal. If they fail, respond `{ status: failed, error }`.
- **Who started it.** execute carries `context`: `{ source: agent | operator, ticket?: "T-482", operator?: { email } }`. `source` is who proposed the action, `operator` is the one who pressed "Execute" (for an agent proposal, the one who approved it). Use it for your own audit; the operator's email is an employee's personal data, so keep it as you keep other such data. `context` is not part of the idempotency fingerprint: a retry with the same key and parameters is the same execution whatever its `context`. Ignore request fields you do not know: new optional ones may appear within version 1.
- **Idempotency.**
  - The execute response is stored by `Idempotency-Key`. A repeat with the same key and the same parameters returns the previous response and executes nothing again.
  - The same key with other parameters is `409 idempotency_conflict`.
  - The key is checked before the parameters.
- **Execution status.** If the execute response was lost (timeout, 502), the core asks `GET /actions/executions/{key}`:
  - `executed` and `failed` — the outcome is known;
  - `pending` — still running;
  - `unknown` — the request never arrived; the core repeats it with the same key.

## Errors

```json
{ "error": { "code": "invalid_arguments", "message": "amount: required", "details": [ ] } }
```

| HTTP | code | When |
|---|---|---|
| 401 | `invalid_signature` | the signature is wrong, expired or missing |
| 404 | `unknown_tool`, `unknown_action`, `unknown_option_set` | no such tool, action or option set |
| 404 | `unknown_customer` | `customer_ref` not found |
| 404 | `not_found` | the object is not found or belongs to another customer |
| 409 | `idempotency_conflict` | the key was already used with other parameters |
| 422 | `invalid_arguments` | the arguments fail `input_schema` |
| 5xx | `internal` | a temporary failure: the core retries reads and asks for the status of execute |

## Conformance checks

The check suite in `packages/protocol` verifies:
- the manifest and ETag;
- the signature: missing, with a foreign secret, expired, from another endpoint;
- resolve, `matched_by` and that an identity matching nobody does not hide the customer;
- the customer card;
- tool responses;
- option sets and their ETag;
- error codes;
- execute idempotency and the execution status.

Profile (`profile.json`):

```json
{
  "baseUrl": "https://staging.example.com/api/support",
  "secret": "may be omitted and passed in PROTOCOL_SECRET instead",
  "customer": { "identities": { "phone": "79000000001" } },
  "tools": { "get_receipt": { "transaction_id": "…" } },
  "actions": { "accrue_points": { "basis": "base_cashback", "amount": 19, "transaction_id": null, "receipt_total": 380 } },
  "execute": true
}
```

```bash
PROTOCOL_SECRET=… pnpm --filter @kvitok/protocol conformance --profile profile.json
```

The execute checks really execute the action. Use a test customer on staging and `"execute": false` in production.

The simulator is checked the same way:

```bash
pnpm --filter @kvitok/coffee-sim conformance
```
