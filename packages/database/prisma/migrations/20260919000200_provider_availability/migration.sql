-- Provider self-managed availability.
--
-- Separate from "status": that column records what RESCUE decided about the
-- company (vetted, suspended, rejected) and only staff may change it. These two
-- record what the company says about today, and the provider changes them
-- itself. Existing rows default to accepting work, which is the behaviour
-- before this migration.
ALTER TABLE "Provider" ADD COLUMN "acceptingWork" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Provider" ADD COLUMN "availabilityNote" TEXT;

-- A note explains a pause. It is meaningless -- and misleading in a dispatcher
-- list -- next to a provider that is taking work, so the two columns may not
-- disagree.
ALTER TABLE "Provider"
  ADD CONSTRAINT "Provider_note_only_when_paused"
  CHECK ("acceptingWork" = false OR "availabilityNote" IS NULL);

-- Dispatch filters on this alongside status when building the eligible set.
CREATE INDEX "Provider_status_acceptingWork_idx" ON "Provider"("status", "acceptingWork");
