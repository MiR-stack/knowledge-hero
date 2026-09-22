#!/bin/bash
set -euo pipefail

# Creates the application DB role used by the API through PgBouncer.
# Table grants are applied in the Drizzle migration (0000_initial.sql).
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rag_app') THEN
      CREATE ROLE rag_app WITH LOGIN PASSWORD 'rag_app' NOSUPERUSER NOBYPASSRLS;
    END IF;
  END
  \$\$;
EOSQL
