#!/usr/bin/env bash
#
# Provokes every invariant the database is supposed to enforce, and reports
# which ones actually refused.
#
# The point is not to test the application. The application has 314 tests and
# they all pass against the in-memory store, which enforces these rules in
# TypeScript. This asks the different question: if something reached the
# database another way -- a migration script, a support query, a second
# service, a bug that bypassed the store -- would PostgreSQL still say no?
#
# Every case below is written to be *allowed* if the constraint is missing. A
# passing run means each one was refused. Run it against a scratch database:
#
#   DATABASE_URL=postgresql://postgres@localhost:5432/rescue_check \
#     bash scripts/check-database.sh
#
set -uo pipefail

URL="${DATABASE_URL:?set DATABASE_URL to a scratch database}"
case "$URL" in
  *test*|*scratch*|*check*|*ci*) ;;
  *) echo "Refusing to run: DATABASE_URL does not look like a scratch database." >&2; exit 2 ;;
esac

pass=0
fail=0

# Runs a statement that MUST be refused. Prints the outcome either way.
refuses() {
  local label="$1" sql="$2" expect="${3:-}"
  local out
  out="$(psql "$URL" -q -v ON_ERROR_STOP=1 -c "$sql" 2>&1)"
  if [ $? -eq 0 ]; then
    printf '  ALLOWED  %s\n' "$label"
    fail=$((fail + 1))
    return
  fi
  if [ -n "$expect" ] && ! grep -qi -- "$expect" <<<"$out"; then
    printf '  WRONG    %s (refused, but not by %s)\n' "$label" "$expect"
    fail=$((fail + 1))
    return
  fi
  printf '  refused  %s\n' "$label"
  pass=$((pass + 1))
}

# Runs a statement that MUST succeed. A constraint that also blocks the legal
# case is a bug, and a suite that only tests refusals never finds it.
allows() {
  local label="$1" sql="$2"
  if psql "$URL" -q -v ON_ERROR_STOP=1 -c "$sql" >/dev/null 2>&1; then
    printf '  allowed  %s\n' "$label"
    pass=$((pass + 1))
  else
    printf '  REFUSED  %s (this one should have worked)\n' "$label"
    fail=$((fail + 1))
  fi
}

echo "==> seeding"
# The append-only tables refuse TRUNCATE, which is the point of this whole
# script -- so the seed says out loud that it is standing the guard down, as
# the trigger's own HINT asks. Only the four `_no_truncate` triggers; the
# UPDATE and DELETE guards stay armed, and the cases below prove it.
psql "$URL" -q -v ON_ERROR_STOP=1 <<'SQL' || exit 1
ALTER TABLE "JobEvent"    DISABLE TRIGGER "JobEvent_no_truncate";
ALTER TABLE "AuditLog"    DISABLE TRIGGER "AuditLog_no_truncate";
ALTER TABLE "LedgerEntry" DISABLE TRIGGER "LedgerEntry_no_truncate";
ALTER TABLE "Suggestion"  DISABLE TRIGGER "Suggestion_no_truncate";

-- AuditLog is named explicitly: it has no foreign key to Job, so unlike
-- JobEvent, LedgerEntry and Suggestion the cascade never reaches it, and a
-- second run would collide on its primary key.
TRUNCATE TABLE "Membership", "Vehicle", "ProviderDocument", "Evidence",
               "Assignment", "AssignmentOffer", "Quote", "IdempotencyKey",
               "AuditLog", "Job", "Provider", "Organization", "User" CASCADE;

ALTER TABLE "JobEvent"    ENABLE TRIGGER "JobEvent_no_truncate";
ALTER TABLE "AuditLog"    ENABLE TRIGGER "AuditLog_no_truncate";
ALTER TABLE "LedgerEntry" ENABLE TRIGGER "LedgerEntry_no_truncate";
ALTER TABLE "Suggestion"  ENABLE TRIGGER "Suggestion_no_truncate";
INSERT INTO "Organization"(id,name,"updatedAt") VALUES ('o1','Nordlicht',now());
INSERT INTO "User"(id,subject,email,name,"updatedAt") VALUES ('u1','dev|a','a@example.com','Anna Klein',now());
INSERT INTO "Provider"(id,"legalName",status,"basePostalCode","serviceRadiusKm","serviceTypes","contactEmail","updatedAt")
  VALUES ('p1','Hansa Transport','ACTIVE','28195',50,'{FAILED_DELIVERY}','p@example.com',now());
INSERT INTO "Job"(id,"organizationId",type,status,urgency,pickup,items,"updatedAt")
  VALUES ('j1','o1','FAILED_DELIVERY','DRAFT','SAME_DAY','{"line1":"Am Markt 1","postalCode":"28195"}','[]',now());
INSERT INTO "JobEvent"(id,"jobId","actorId",type,payload) VALUES ('e1','j1','u1','JOB_CREATED','{}');
INSERT INTO "AuditLog"(id,"actorId",action,"entityType","entityId",metadata) VALUES ('a1','u1','JOB_CREATED','Job','j1','{}');
INSERT INTO "LedgerEntry"(id,"jobId",kind,"amountCents") VALUES ('l1','j1','CAPTURE',29750);
INSERT INTO "Suggestion"(id,"jobId",kind,output,"promptId","promptVersion",model,confidence,"latencyMs")
  VALUES ('s1','j1','triage','{}','triage.v','1','stub',0.8,42);
INSERT INTO "OutboxMessage"(id,topic,"dedupeKey","jobId",payload) VALUES ('m1','job.created','job.created:j1','j1','{}');
SQL

echo
echo "==> money cannot be wrong"
refuses "a quote whose gross is not net plus VAT" \
  "INSERT INTO \"Quote\"(id,\"jobId\",\"organizationId\",\"netCents\",\"vatCents\",\"grossCents\",\"vatRateBasisPoints\",\"validUntil\") VALUES ('qx','j1','o1',10000,1900,99999,1900,now())" \
  "gross_is_net_plus_vat"
refuses "a quote with a negative net" \
  "INSERT INTO \"Quote\"(id,\"jobId\",\"organizationId\",\"netCents\",\"vatCents\",\"grossCents\",\"vatRateBasisPoints\",\"validUntil\") VALUES ('qy','j1','o1',-100,-19,-119,1900,now())" \
  "amounts_nonnegative"
refuses "a negative payout on an offer" \
  "INSERT INTO \"AssignmentOffer\"(id,\"jobId\",\"providerId\",\"payoutNetCents\",\"expiresAt\") VALUES ('ox','j1','p1',-1,now())" \
  "payout_nonnegative"
refuses "a ledger entry of zero" \
  "INSERT INTO \"LedgerEntry\"(id,\"jobId\",kind,\"amountCents\") VALUES ('lz','j1','CAPTURE',0)" \
  "amount_not_zero"
refuses "a POSITIVE payout — money out must be negative" \
  "INSERT INTO \"LedgerEntry\"(id,\"jobId\",kind,\"amountCents\") VALUES ('lp','j1','PAYOUT',5000)" \
  "sign_matches_kind"
refuses "a NEGATIVE capture — money in must be positive" \
  "INSERT INTO \"LedgerEntry\"(id,\"jobId\",kind,\"amountCents\") VALUES ('lc','j1','CAPTURE',-5000)" \
  "sign_matches_kind"
refuses "a ledger entry in another currency" \
  "INSERT INTO \"LedgerEntry\"(id,\"jobId\",kind,\"amountCents\",currency) VALUES ('lu','j1','CAPTURE',100,'USD')" \
  "currency_is_euro"
allows  "a correctly signed payout" \
  "INSERT INTO \"LedgerEntry\"(id,\"jobId\",kind,\"amountCents\") VALUES ('lok','j1','PAYOUT',-20000)"

echo
echo "==> the audit trail cannot be edited"
refuses "UPDATE on JobEvent"    "UPDATE \"JobEvent\" SET type='TAMPERED'"         "append-only"
refuses "DELETE on JobEvent"    "DELETE FROM \"JobEvent\""                        "append-only"
refuses "UPDATE on AuditLog"    "UPDATE \"AuditLog\" SET action='TAMPERED'"       "append-only"
refuses "DELETE on AuditLog"    "DELETE FROM \"AuditLog\""                        "append-only"
refuses "UPDATE on LedgerEntry" "UPDATE \"LedgerEntry\" SET \"amountCents\"=1"    "append-only"
refuses "DELETE on LedgerEntry" "DELETE FROM \"LedgerEntry\""                     "append-only"
refuses "UPDATE on Suggestion"  "UPDATE \"Suggestion\" SET confidence=1"          "append-only"
refuses "DELETE on Suggestion"  "DELETE FROM \"Suggestion\""                      "append-only"

echo
echo "==> ...nor emptied, which row-level triggers do not catch"
refuses "TRUNCATE JobEvent"     "TRUNCATE TABLE \"JobEvent\""     "TRUNCATE is not permitted"
refuses "TRUNCATE AuditLog"     "TRUNCATE TABLE \"AuditLog\""     "TRUNCATE is not permitted"
refuses "TRUNCATE LedgerEntry"  "TRUNCATE TABLE \"LedgerEntry\""  "TRUNCATE is not permitted"
refuses "TRUNCATE Suggestion"   "TRUNCATE TABLE \"Suggestion\""   "TRUNCATE is not permitted"
refuses "TRUNCATE Job CASCADE — reaching them all sideways" \
  "TRUNCATE TABLE \"Job\" CASCADE" "TRUNCATE is not permitted"

echo
echo "==> the outbox"
refuses "a duplicate dedupe key" \
  "INSERT INTO \"OutboxMessage\"(id,topic,\"dedupeKey\",\"jobId\",payload) VALUES ('m2','job.created','job.created:j1','j1','{}')" \
  "dedupeKey"
refuses "SENT with no delivery timestamp" \
  "UPDATE \"OutboxMessage\" SET status='SENT' WHERE id='m1'" \
  "delivered_iff_sent"
refuses "a delivery timestamp without SENT" \
  "UPDATE \"OutboxMessage\" SET \"deliveredAt\"=now() WHERE id='m1'" \
  "delivered_iff_sent"
refuses "a negative attempt count" \
  "UPDATE \"OutboxMessage\" SET attempts=-1 WHERE id='m1'" \
  "attempts_sane"
allows  "SENT together with its timestamp" \
  "UPDATE \"OutboxMessage\" SET status='SENT', \"deliveredAt\"=now() WHERE id='m1'"

echo
echo "==> tenancy and the rest"
refuses "a membership in two tenants at once" \
  "INSERT INTO \"Membership\"(id,\"userId\",\"organizationId\",\"providerId\",role) VALUES ('mx','u1','o1','p1','ADMIN')" \
  "single_tenant"
refuses "an availability note while still accepting work" \
  "UPDATE \"Provider\" SET \"acceptingWork\"=true, \"availabilityNote\"='in der Werkstatt' WHERE id='p1'" \
  "note_only_when_paused"
refuses "a confidence above one" \
  "INSERT INTO \"Suggestion\"(id,\"jobId\",kind,output,\"promptId\",\"promptVersion\",model,confidence,\"latencyMs\") VALUES ('s2','j1','triage','{}','p','1','m',1.4,1)" \
  "confidence_is_a_probability"
refuses "evidence of zero bytes" \
  "INSERT INTO \"Evidence\"(id,\"jobId\",kind,\"mimeType\",\"sizeBytes\",\"storageKey\") VALUES ('ev','j1','PICKUP_PHOTO','image/jpeg',0,'k/1')" \
  "size_positive"
allows  "pausing with a note" \
  "UPDATE \"Provider\" SET \"acceptingWork\"=false, \"availabilityNote\"='in der Werkstatt' WHERE id='p1'"

echo
echo "==> the claim the worker actually issues"
# Not a constraint: the concurrency primitive the whole outbox rests on. Two
# workers polling at the same instant must take DISJOINT rows -- if they
# overlap, every notification goes out twice. Two real sessions, the second
# claiming while the first still holds its lock.
psql "$URL" -q -v ON_ERROR_STOP=1 -c \
  "INSERT INTO \"OutboxMessage\"(id,topic,\"dedupeKey\",\"jobId\",payload) SELECT 'c'||i,'job.created','claim:'||i,'j1','{}' FROM generate_series(1,6) i" >/dev/null 2>&1

claim_sql='BEGIN;
SELECT id FROM "OutboxMessage" WHERE status = '"'"'PENDING'"'"'
  ORDER BY "createdAt", id LIMIT 3 FOR UPDATE SKIP LOCKED;
SELECT pg_sleep(1.5);
COMMIT;'

psql "$URL" -At -q -c "$claim_sql" >/tmp/claim-a.txt 2>&1 &
worker_a=$!
sleep 0.4
psql "$URL" -At -q -c "$claim_sql" >/tmp/claim-b.txt 2>&1 &
worker_b=$!
wait "$worker_a" "$worker_b"

ids_of() { grep -E '^c[0-9]+$' "$1" | sort; }
a_ids="$(ids_of /tmp/claim-a.txt)"
b_ids="$(ids_of /tmp/claim-b.txt)"
overlap="$(comm -12 <(printf '%s\n' "$a_ids") <(printf '%s\n' "$b_ids") | tr -d '[:space:]')"
a_count=$(printf '%s\n' "$a_ids" | grep -c . || true)
b_count=$(printf '%s\n' "$b_ids" | grep -c . || true)

if [ "$a_count" -eq 3 ] && [ "$b_count" -eq 3 ] && [ -z "$overlap" ]; then
  printf '  ok       two concurrent claims took disjoint batches (%s | %s)\n' \
    "$(printf '%s' "$a_ids" | tr '\n' ' ')" "$(printf '%s' "$b_ids" | tr '\n' ' ')"
  pass=$((pass + 1))
else
  printf '  FAILED   concurrent claims overlapped or came up short (a=%d b=%d shared=%s)\n' \
    "$a_count" "$b_count" "${overlap:-none}"
  fail=$((fail + 1))
fi

# And the lease: a claimed row must not be handed out again while it is held.
allows  "pushing availableAt forward as a lease" \
  "UPDATE \"OutboxMessage\" SET \"availableAt\" = now() + interval '60 seconds' WHERE id = 'c1'"
held=$(psql "$URL" -Atc "SELECT count(*) FROM \"OutboxMessage\" WHERE status='PENDING' AND \"availableAt\" <= now() AND id='c1'" 2>/dev/null)
if [ "$held" = "0" ]; then
  printf '  ok       a leased row is not due again until the lease expires\n'
  pass=$((pass + 1))
else
  printf '  FAILED   a leased row was still claimable\n'
  fail=$((fail + 1))
fi

echo
echo "==> retention deletes what it is allowed to, and nothing else"
allows  "deleting a delivered outbox row" \
  "DELETE FROM \"OutboxMessage\" WHERE status='SENT'"
allows  "deleting an idempotency record" \
  "DELETE FROM \"IdempotencyKey\" WHERE \"expiresAt\" < now()"
refuses "deleting a ledger entry, even during retention" \
  "DELETE FROM \"LedgerEntry\" WHERE \"createdAt\" < now()" \
  "append-only"

echo
printf '\n%s\n' "-----------------------------------------"
printf '%d checks passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
