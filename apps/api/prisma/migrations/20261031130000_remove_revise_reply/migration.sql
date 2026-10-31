-- «Переписать ответ» заменён сообщением агенту (этап 3.9.4).
-- Старые прогоны revise_reply были уточнениями черновика — переносим их в refine.
UPDATE "agent_runs" SET "mode" = 'refine' WHERE "mode" = 'revise_reply';
UPDATE "agent_runs" SET "trigger" = jsonb_set("trigger", '{type}', '"operator_message"') WHERE "trigger"->>'type' = 'revise';

ALTER TYPE "AgentRunMode" RENAME TO "AgentRunMode_old";
CREATE TYPE "AgentRunMode" AS ENUM ('triage', 'refine');
ALTER TABLE "agent_runs" ALTER COLUMN "mode" TYPE "AgentRunMode" USING ("mode"::text::"AgentRunMode");
DROP TYPE "AgentRunMode_old";

ALTER TABLE "agent_settings" DROP COLUMN "revise_model";
