-- Make the audit trail immutable at the database level.
--
-- Finding H5 in docs/audits/FOUNDATION_AUDIT.md: an audit log that the
-- application can rewrite is not an audit log. The application role gets
-- INSERT and SELECT on these two tables and nothing else, so a compromised or
-- buggy service cannot alter history even with full application privileges.
--
-- The role name is configurable. Set it before running migrations:
--   psql -v rescue_app_role=rescue_app ...
-- When the role does not exist this migration is a no-op, so local
-- development and CI (which use a superuser) are unaffected.

DO $$
DECLARE
  app_role TEXT := COALESCE(current_setting('rescue.app_role', true), 'rescue_app');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    RAISE NOTICE 'Role % does not exist; skipping append-only grants.', app_role;
    RETURN;
  END IF;

  EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "JobEvent" FROM %I', app_role);
  EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "AuditLog" FROM %I', app_role);
  EXECUTE format('GRANT INSERT, SELECT ON TABLE "JobEvent" TO %I', app_role);
  EXECUTE format('GRANT INSERT, SELECT ON TABLE "AuditLog" TO %I', app_role);
END
$$;

-- Belt and braces: block UPDATE and DELETE for every role except the table
-- owner, so the protection survives someone granting privileges by hand later.
CREATE OR REPLACE FUNCTION rescue_reject_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER "JobEvent_append_only"
  BEFORE UPDATE OR DELETE ON "JobEvent"
  FOR EACH ROW EXECUTE FUNCTION rescue_reject_mutation();

CREATE TRIGGER "AuditLog_append_only"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION rescue_reject_mutation();
