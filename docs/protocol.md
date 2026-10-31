# Support Action Protocol, version 1

How a project backend (an online shop, a loyalty program, an internal system) gives the support system customer data and executes actions. The backend implements a few HTTP endpoints; the support core calls them on behalf of the agent and the operator.

- Request and response schemas: `packages/protocol/src/schemas.ts` (zod). The core validates responses with them, and the conformance checks use them too.
- Reference implementation: the coffee shop simulator `apps/coffee-sim`.
- To check your own implementation, see "Conformance checks" at the end.

## Principles

- **The core does not know the domain.** What a customer has (receipts, orders, visits) and what can be done with them is described by the backend in its manifest.
- **The agent only proposes.** An action is executed after an operator approves it; the backend validates the parameters itself both on validate and on execute.
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
| `POST /customers/resolve` | `{ identities: { phone?, email?, card_number?, … } }` | `{ status: found, customer_ref, display_name? }` · `{ status: not_found }` · `{ status: ambiguous, candidates: [{ customer_ref, display_name, hint? }] }` |
| `POST /context` | `{ customer_ref }` | the customer card: `{ title?, summary?, sections: [{ key, title, display, data }], refs }` |
| `POST /tools/{name}` | `{ customer_ref \| null, args }` | `{ summary?, data, display?, refs }` |
| `POST /actions/{name}/validate` | `{ customer_ref, params }` | `{ ok, normalized_params?, preview?, warnings[], errors[{ path?, message }] }` |
| `POST /actions/{name}/execute` | `{ customer_ref, params }` + the `Idempotency-Key` header | `{ status: executed \| failed, result?, external_ref?, error? }` |
| `GET /actions/executions/{key}` | — | `{ status: executed \| failed \| pending \| unknown, action?, result?, external_ref?, error? }` |

### Manifest

```json
{
  "protocol_version": 1,
  "name": "acme_coffee",
  "title": "Acme Coffee",
  "identity_types": ["phone", "email", "card_number"],
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
    "examples": [{ "params": { "basis": "base_cashback", "amount": 19, "transaction_id": null, "receipt_total": 380 } }]
  }],
  "playbooks": [{ "key": "points_not_accrued", "title": "…", "when": "…", "body": "markdown", "suggested_department": "loyalty", "tools": ["get_transactions"], "actions": ["accrue_points"] }],
  "suggested_departments": [{ "key": "loyalty", "title": "Loyalty", "description": "…", "examples": ["…"] }]
}
```

- The `name` of tools, actions, playbooks and departments is lowercase Latin letters, digits and `_`.
- `input_schema` is the JSON Schema of an object. The model sees it as the tool's argument schema, so write field descriptions for the model.
- `display` is how the UI shows the result: `kv`, `table`, `timeline`, `markdown`, `json`.
- `requires_customer: false` marks reference data (promos, menu) available without a resolved customer; the core passes `customer_ref: null`.
- `cache_ttl_seconds` is how long the result may be reused in later agent runs. After an operator message the agent does not fetch the same data again until it expires. `0` means do not reuse.
- `examples` are used for documentation, a test call in the UI and conformance checks.
- `instructions` and `playbooks` are domain knowledge for the agent: how to read tool data and how to handle typical requests. The policy for talking to customers is set by the support team in its own interface and does not belong here.

### Data: tools and context

- `data` goes to the model as is: compact JSON with clear keys. Times carry a time zone or a convention stated in `instructions`.
- `refs` are links to objects in the backend admin: `{ type, id, title?, url? }`.
- The core truncates large responses and tells the model the data was cut. It is better to limit the selection right away (`limit`, a period).
- Another customer's object is `404 not_found`, the same as a nonexistent one.

### Actions

- **validate** responds `200` even when the parameters are semantically invalid: `{ ok: false, errors: [...] }`. The agent gets the errors and can fix the parameters ("the receipt belongs to another guest", "points for the receipt were already credited"). `422` is only for parameters that fail `input_schema`.
- `normalized_params` are the parameters that will be executed, for example a recalculated amount; the difference is explained in `warnings`.
- `preview` is one line for the operator: what will happen.
- **execute** must run the validate checks again: the data may have changed since the proposal. If they fail, respond `{ status: failed, error }`.
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
| 404 | `unknown_tool`, `unknown_action` | no such tool or action |
| 404 | `unknown_customer` | `customer_ref` not found |
| 404 | `not_found` | the object is not found or belongs to another customer |
| 409 | `idempotency_conflict` | the key was already used with other parameters |
| 422 | `invalid_arguments` | the arguments fail `input_schema` |
| 5xx | `internal` | a temporary failure: the core retries reads and asks for the status of execute |

## Conformance checks

The check suite in `packages/protocol` verifies:
- the manifest and ETag;
- the signature: missing, with a foreign secret, expired, from another endpoint;
- resolve;
- the customer card;
- tool responses;
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
