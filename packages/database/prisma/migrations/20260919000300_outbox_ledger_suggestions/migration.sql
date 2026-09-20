-- Phase 4: the transactional outbox, the money ledger, and recorded AI
-- suggestions.

CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'DEAD');

-- The outbox. A row is written in the same transaction as the state change it
-- describes; a worker turns rows into effects.
CREATE TABLE "OutboxMessage" (
  "id"          TEXT NOT NULL,
  "topic"       TEXT NOT NULL,
  "dedupeKey"   TEXT NOT NULL,
  "jobId"       TEXT,
  "payload"     JSONB NOT NULL,
  "status"      "OutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attempts"    INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError"   TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deliveredAt" TIMESTAMP(3),
  CONSTRAINT "OutboxMessage_pkey" PRIMARY KEY ("id")
);

-- Enqueueing the same intent twice collapses to one row. This is the whole
-- reason the pipeline can be at-least-once at the edge without the provider
-- being told twice.
CREATE UNIQUE INDEX "OutboxMessage_dedupeKey_key" ON "OutboxMessage"("dedupeKey");

-- The worker's claim query.
CREATE INDEX "OutboxMessage_status_availableAt_idx" ON "OutboxMessage"("status", "availableAt");
CREATE INDEX "OutboxMessage_jobId_createdAt_idx" ON "OutboxMessage"("jobId", "createdAt");

ALTER TABLE "OutboxMessage"
  ADD CONSTRAINT "OutboxMessage_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Attempts cannot run away, and a delivered row must carry its timestamp while
-- an undelivered one must not: the pair is read as "is this done", so they may
-- not disagree.
ALTER TABLE "OutboxMessage"
  ADD CONSTRAINT "OutboxMessage_attempts_sane" CHECK ("attempts" >= 0 AND "attempts" <= 100);
ALTER TABLE "OutboxMessage"
  ADD CONSTRAINT "OutboxMessage_delivered_iff_sent"
  CHECK (("status" = 'SENT') = ("deliveredAt" IS NOT NULL));

CREATE TYPE "LedgerEntryKind" AS ENUM (
  'AUTHORISATION', 'AUTHORISATION_VOID', 'CAPTURE', 'REFUND', 'PAYOUT', 'PAYOUT_REVERSAL'
);

-- Append-only money movements in integer euro cents, signed from RESCUE's
-- point of view. There is no balance column: a balance is a fold over these.
CREATE TABLE "LedgerEntry" (
  "id"                TEXT NOT NULL,
  "jobId"             TEXT NOT NULL,
  "kind"              "LedgerEntryKind" NOT NULL,
  "amountCents"       INTEGER NOT NULL,
  "currency"          TEXT NOT NULL DEFAULT 'EUR',
  "externalReference" TEXT,
  "note"              TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LedgerEntry_jobId_createdAt_idx" ON "LedgerEntry"("jobId", "createdAt");
CREATE INDEX "LedgerEntry_kind_createdAt_idx" ON "LedgerEntry"("kind", "createdAt");

ALTER TABLE "LedgerEntry"
  ADD CONSTRAINT "LedgerEntry_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A zero-value movement is never a real one, and the sign has to agree with
-- the kind or summing the column stops meaning anything. Money in from a
-- customer is positive; money out to a provider or back to a customer is
-- negative.
ALTER TABLE "LedgerEntry"
  ADD CONSTRAINT "LedgerEntry_amount_not_zero" CHECK ("amountCents" <> 0);
ALTER TABLE "LedgerEntry"
  ADD CONSTRAINT "LedgerEntry_sign_matches_kind" CHECK (
    ("kind" IN ('AUTHORISATION', 'CAPTURE', 'PAYOUT_REVERSAL') AND "amountCents" > 0)
    OR
    ("kind" IN ('AUTHORISATION_VOID', 'REFUND', 'PAYOUT') AND "amountCents" < 0)
  );
ALTER TABLE "LedgerEntry"
  ADD CONSTRAINT "LedgerEntry_currency_is_euro" CHECK ("currency" = 'EUR');

-- A model-produced suggestion with the provenance to explain it later.
CREATE TABLE "Suggestion" (
  "id"              TEXT NOT NULL,
  "jobId"           TEXT NOT NULL,
  "kind"            TEXT NOT NULL,
  "output"          JSONB NOT NULL,
  "promptId"        TEXT NOT NULL,
  "promptVersion"   TEXT NOT NULL,
  "model"           TEXT NOT NULL,
  "confidence"      DOUBLE PRECISION NOT NULL,
  "latencyMs"       INTEGER NOT NULL,
  "fellBackToRules" BOOLEAN NOT NULL DEFAULT false,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Suggestion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Suggestion_jobId_createdAt_idx" ON "Suggestion"("jobId", "createdAt");

ALTER TABLE "Suggestion"
  ADD CONSTRAINT "Suggestion_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Suggestion"
  ADD CONSTRAINT "Suggestion_confidence_is_a_probability"
  CHECK ("confidence" >= 0 AND "confidence" <= 1);

-- Suggestions are evidence of what was proposed, not a record to be tidied.
-- Append-only, like JobEvent and AuditLog.
CREATE OR REPLACE FUNCTION rescue_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Suggestion_append_only"
  BEFORE UPDATE OR DELETE ON "Suggestion"
  FOR EACH ROW EXECUTE FUNCTION rescue_reject_mutation();

CREATE TRIGGER "LedgerEntry_append_only"
  BEFORE UPDATE OR DELETE ON "LedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION rescue_reject_mutation();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rescue_app') THEN
    GRANT SELECT, INSERT, UPDATE ON "OutboxMessage" TO rescue_app;
    -- No UPDATE or DELETE: the triggers above would refuse anyway, and the
    -- grant says so at the permission layer too.
    GRANT SELECT, INSERT ON "LedgerEntry" TO rescue_app;
    GRANT SELECT, INSERT ON "Suggestion" TO rescue_app;
  ELSE
    RAISE NOTICE 'Role rescue_app does not exist; skipping Phase 4 grants.';
  END IF;
END
$$;
