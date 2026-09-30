#!/usr/bin/env bash
# Run as root after loading pgvector/pgvector:0.8.6-pg17-bookworm.
set -euo pipefail
umask 077
[[ $EUID == 0 ]] || exit 64
config=/etc/auto-workflow-postgres
init_script=${1:?Provide the path to scripts/database/postgres-init/001-app.sh}
[[ -f $init_script ]]
if docker container inspect auto-workflow-postgres > /dev/null 2>&1; then
  echo 'PostgreSQL container already exists; refusing to overwrite it.' >&2
  exit 1
fi
[[ ! -e $config && ! -e /var/lib/auto-workflow-postgres ]] || { echo 'Existing data/configuration requires inspection.' >&2; exit 1; }
docker image inspect pgvector/pgvector:0.8.6-pg17-bookworm > /dev/null
docker network inspect auto-workflow > /dev/null 2>&1 || docker network create auto-workflow > /dev/null
install -d -m 700 "$config" /var/lib/auto-workflow-postgres
openssl rand -hex 32 > "$config/admin-password"
openssl rand -hex 32 > "$config/app-password"
# Only individual files are mounted. Parent remains root-only on the host.
chmod 644 "$config/app-password"
install -m 644 "$init_script" "$config/init-app.sh"
docker run -d --name auto-workflow-postgres --restart unless-stopped \
  --network auto-workflow --log-opt max-size=10m --log-opt max-file=3 \
  --mount type=bind,src=/var/lib/auto-workflow-postgres,dst=/var/lib/postgresql/data \
  --mount "type=bind,src=$config/admin-password,dst=/run/secrets/admin-password,readonly" \
  --mount "type=bind,src=$config/app-password,dst=/run/secrets/app-password,readonly" \
  --mount "type=bind,src=$config/init-app.sh,dst=/docker-entrypoint-initdb.d/001-app.sh,readonly" \
  --env POSTGRES_PASSWORD_FILE=/run/secrets/admin-password \
  --env POSTGRES_DB=auto_workflow --env POSTGRES_USER=postgres \
  --env 'POSTGRES_INITDB_ARGS=--encoding=UTF8 --locale=C' \
  --health-cmd='pg_isready -U postgres -d auto_workflow' \
  --health-interval=5s --health-timeout=5s --health-retries=20 \
  pgvector/pgvector:0.8.6-pg17-bookworm postgres -c shared_buffers=128MB -c max_connections=30 > /dev/null
for ((attempt = 0; attempt < 60; attempt++)); do
  if [[ $(docker inspect --format '{{.State.Health.Status}}' auto-workflow-postgres) == healthy ]] && \
    docker exec -u postgres auto-workflow-postgres psql -U postgres -d auto_workflow -tAc "SELECT '[1,0]'::vector <=> '[1,0]'::vector" > /dev/null 2>&1; then
    echo 'PostgreSQL + pgvector ready. Credentials remain in the root-only configuration directory.'
    exit 0
  fi
  sleep 2
done
echo 'Initialization failed; retained data and configuration for diagnosis.' >&2
exit 1
