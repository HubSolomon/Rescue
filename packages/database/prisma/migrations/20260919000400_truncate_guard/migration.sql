-- The hole in append-only: TRUNCATE.
--
-- Found by a backup-and-restore drill, not by reading the code. The existing
-- guards are row-level BEFORE UPDATE OR DELETE triggers, and PostgreSQL does
-- not fire row-level triggers for TRUNCATE -- there are no rows involved, only
-- a file being replaced. So every table the system treats as immutable could
-- be emptied by one statement, and the audit log would not even record that it
-- happened, because the audit log is one of the tables.
--
-- The fix is a statement-level trigger, which is the only kind TRUNCATE fires.
-- It is not defence against a determined superuser -- nothing in the database
-- is -- but it is defence against the case that actually occurs: a cleanup
-- script, a test fixture pointed at the wrong DATABASE_URL, or an ORM reset
-- helper run against production.

CREATE OR REPLACE FUNCTION rescue_reject_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; TRUNCATE is not permitted', TG_TABLE_NAME
    USING
      ERRCODE = 'insufficient_privilege',
      HINT = 'Row-level triggers do not fire on TRUNCATE. If this is a scratch database, drop the trigger explicitly and say so in the script.';
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "JobEvent_no_truncate" ON "JobEvent";
CREATE TRIGGER "JobEvent_no_truncate"
  BEFORE TRUNCATE ON "JobEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION rescue_reject_truncate();

DROP TRIGGER IF EXISTS "AuditLog_no_truncate" ON "AuditLog";
CREATE TRIGGER "AuditLog_no_truncate"
  BEFORE TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION rescue_reject_truncate();

DROP TRIGGER IF EXISTS "LedgerEntry_no_truncate" ON "LedgerEntry";
CREATE TRIGGER "LedgerEntry_no_truncate"
  BEFORE TRUNCATE ON "LedgerEntry"
  FOR EACH STATEMENT EXECUTE FUNCTION rescue_reject_truncate();

DROP TRIGGER IF EXISTS "Suggestion_no_truncate" ON "Suggestion";
CREATE TRIGGER "Suggestion_no_truncate"
  BEFORE TRUNCATE ON "Suggestion"
  FOR EACH STATEMENT EXECUTE FUNCTION rescue_reject_truncate();

-- TRUNCATE on a parent cascades to children that reference it, and that
-- cascade fires the child's own statement-level trigger -- so truncating
-- "Job" is refused by "JobEvent"'s guard rather than quietly taking the
-- events with it. Verified, because the reverse would have made this
-- migration worthless.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rescue_app') THEN
    -- Belt and braces. TRUNCATE is not granted by default, but an application
    -- role that happens to own its tables has it implicitly, and that is the
    -- common accident in a deployment where one role ran the migrations.
    REVOKE TRUNCATE ON "JobEvent", "AuditLog", "LedgerEntry", "Suggestion" FROM rescue_app;
  ELSE
    RAISE NOTICE 'Role rescue_app does not exist; skipping TRUNCATE revocations.';
  END IF;
END
$$;
