-- One currency per workspace: model prices and run costs are in it.
ALTER TABLE "workspaces" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'USD';

-- The currency most runs of the workspace were priced in; without runs, the one its models were priced in.
UPDATE "workspaces" w
SET "currency" = c."currency"
FROM (
  SELECT DISTINCT ON ("workspace_id") "workspace_id", upper("currency") AS "currency"
  FROM "agent_runs"
  WHERE "currency" ~* '^[a-z]{3}$'
  GROUP BY "workspace_id", upper("currency")
  ORDER BY "workspace_id", count(*) DESC
) c
WHERE c."workspace_id" = w."id";

UPDATE "workspaces" w
SET "currency" = c."currency"
FROM (
  SELECT DISTINCT ON (p."workspace_id") p."workspace_id", upper(m->>'currency') AS "currency"
  FROM "llm_providers" p, jsonb_array_elements(p."models") m
  WHERE m->>'currency' ~* '^[a-z]{3}$'
  GROUP BY p."workspace_id", upper(m->>'currency')
  ORDER BY p."workspace_id", count(*) DESC
) c
WHERE c."workspace_id" = w."id"
  AND NOT EXISTS (SELECT 1 FROM "agent_runs" r WHERE r."workspace_id" = w."id" AND r."currency" IS NOT NULL);

-- A cost in another currency cannot be converted: the run becomes unpriced, its tokens stay.
UPDATE "agent_runs" r
SET "cost" = NULL
FROM "workspaces" w
WHERE w."id" = r."workspace_id" AND r."cost" IS NOT NULL AND upper(coalesce(r."currency", '')) <> w."currency";

UPDATE "llm_providers"
SET "models" = (SELECT coalesce(jsonb_agg(m - 'currency'), '[]'::jsonb) FROM jsonb_array_elements("models") m)
WHERE jsonb_typeof("models") = 'array';

-- AlterTable
ALTER TABLE "agent_runs" DROP COLUMN "currency";
