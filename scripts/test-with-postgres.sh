#!/usr/bin/env bash
#
# Runs the API test suite against a real PostgreSQL, including the PrismaStore
# conformance suite that is skipped without a database.
#
# The repository already ships a Postgres in docker-compose.yml, so this uses
# that rather than asking anyone to install a server and put psql on their
# PATH. Every command runs inside the container, so the host needs Docker and
# nothing else.
#
#   pnpm test:db
#
set -euo pipefail

SCRATCH_DB="rescue_test"
DB_USER="rescue"
DB_PASSWORD="rescue"
COMPOSE_SERVICE="postgres"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

if ! command -v docker >/dev/null 2>&1; then
  cat >&2 <<'MSG'
Docker is not installed, and this script uses the Postgres in docker-compose.yml.

Either install Docker Desktop, or install PostgreSQL directly and run the suite
against it yourself:

  brew install postgresql@16
  brew services start postgresql@16
  createdb rescue_test
  DATABASE_URL=postgresql://localhost:5432/rescue_test pnpm db:deploy
  DATABASE_URL=postgresql://localhost:5432/rescue_test pnpm --filter @rescue/api test
MSG
  exit 1
fi

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  else
    docker-compose "$@"
  fi
}

echo "==> starting $COMPOSE_SERVICE"
compose up -d "$COMPOSE_SERVICE"

echo "==> waiting for it to accept connections"
for attempt in $(seq 1 60); do
  if compose exec -T "$COMPOSE_SERVICE" pg_isready -U "$DB_USER" >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    echo "postgres did not become ready within 60 seconds" >&2
    compose logs --tail=30 "$COMPOSE_SERVICE" >&2
    exit 1
  fi
  sleep 1
done

# Idempotent: re-running must not fail on an existing database. The suite
# truncates every table between cases anyway, so a leftover one is harmless.
echo "==> ensuring the $SCRATCH_DB database exists"
if ! compose exec -T "$COMPOSE_SERVICE" \
  psql -U "$DB_USER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$SCRATCH_DB'" \
  | grep -q 1; then
  compose exec -T "$COMPOSE_SERVICE" createdb -U "$DB_USER" "$SCRATCH_DB"
fi

# The port the container publishes, so this keeps working if compose is edited.
port="$(compose port "$COMPOSE_SERVICE" 5432 | sed 's/.*://')"
export DATABASE_URL="postgresql://$DB_USER:$DB_PASSWORD@localhost:$port/$SCRATCH_DB"
echo "==> DATABASE_URL=postgresql://$DB_USER:***@localhost:$port/$SCRATCH_DB"

echo "==> applying migrations"
pnpm --filter @rescue/database exec prisma migrate deploy

echo "==> running the API suite, PrismaStore included"
pnpm --filter @rescue/api test

echo
echo "Done. The database is still running; stop it with:"
echo "  docker compose stop $COMPOSE_SERVICE"
