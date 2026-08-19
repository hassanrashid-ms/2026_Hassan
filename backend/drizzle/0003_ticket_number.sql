-- Five steps, in this order, because the backfill runs against databases that
-- already hold conversations. A NOT NULL column added in one step would abort
-- on every one of them. The end state matches meta/0003_snapshot.json.

-- 1. the counter
ALTER TABLE "workspace" ADD COLUMN "ticket_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

-- 2. the column, nullable for now
ALTER TABLE "conversation" ADD COLUMN "number" integer;--> statement-breakpoint

-- 3. BACKFILL — number each workspace's conversations from 1 by created_at.
--    Ties broken by id so a re-run is deterministic.
UPDATE "conversation" AS c
   SET "number" = n.rn
  FROM (
    SELECT id,
           row_number() OVER (PARTITION BY workspace_id ORDER BY created_at, id) AS rn
      FROM "conversation"
  ) AS n
 WHERE c.id = n.id
   AND c."number" IS NULL;--> statement-breakpoint

-- 4. BACKFILL — park each workspace's counter on its own max, so the next
--    allocation continues the sequence instead of colliding with it.
UPDATE "workspace" AS w
   SET "ticket_seq" = COALESCE(m.max_number, 0)
  FROM (
    SELECT ws.id, MAX(c."number") AS max_number
      FROM "workspace" ws
      LEFT JOIN "conversation" c ON c.workspace_id = ws.id
     GROUP BY ws.id
  ) AS m
 WHERE w.id = m.id;--> statement-breakpoint

-- 5. now the constraint holds, so state it
ALTER TABLE "conversation" ALTER COLUMN "number" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_workspace_number_uk" ON "conversation" USING btree ("workspace_id","number");
