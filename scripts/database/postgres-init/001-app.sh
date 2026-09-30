#!/usr/bin/env bash
set -euo pipefail
app_password=$(cat /run/secrets/app-password)
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=app_password="$app_password" <<'SQL'
CREATE ROLE auto_workflow LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE EXTENSION IF NOT EXISTS vector;
GRANT CONNECT ON DATABASE auto_workflow TO auto_workflow;
GRANT USAGE, CREATE ON SCHEMA public TO auto_workflow;
SQL
