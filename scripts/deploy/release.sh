#!/usr/bin/env bash
set -euo pipefail
export PATH=/opt/node/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 077

[[ $EUID == 0 && $# == 1 && $1 =~ ^[0-9a-f]{40}$ ]] || exit 64
revision=$1
image="auto-workflow:$revision"
base=/opt/auto-workflow
data=/var/lib/auto-workflow
exec 9>/run/lock/auto-workflow-deploy.lock
flock -w 900 9

archive=$(mktemp /var/tmp/auto-workflow-image.XXXXXX)
previous_container=''
legacy=false
stopped=false
created=false
previous_policy='unless-stopped'

# Called indirectly by the EXIT trap.
# shellcheck disable=SC2317
recover() {
  result=$?
  trap - EXIT
  rm -f "$archive"
  if [[ $result != 0 && $stopped == true ]]; then
    if [[ $created == true ]]; then docker rm -f auto-workflow || true; fi
    if [[ -n $previous_container ]]; then
      docker rename "$previous_container" auto-workflow
      docker update --restart="$previous_policy" auto-workflow > /dev/null
      docker start auto-workflow > /dev/null
    elif [[ $legacy == true ]]; then
      systemctl start auto-workflow
    fi
    echo 'Deployment failed; previous service restored. Database was not reverted; inspect the backup before data recovery.' >&2
  fi
  exit "$result"
}
trap 'recover' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

cat > "$archive"
docker load --input "$archive"
[[ $(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image") == "$revision" ]]
[[ $(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image") == linux/amd64 ]]
# Never mount production data during import validation.
docker run --rm --network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  "$image" node --import tsx --input-type=module -e 'await import("./src/database.ts"); await import("./src/issueSources/preload.ts");'

# Initial SQLite import is an explicit maintenance operation, never an ordinary release.
[[ -f $data/MYSQL_MIGRATED ]] || { echo "Complete and verify the initial MySQL cutover first." >&2; exit 1; }
# Production releases require the separately provisioned persistent MySQL service.
[[ $(docker inspect --format '{{.State.Health.Status}}' auto-workflow-mysql) == healthy ]]
docker network inspect auto-workflow > /dev/null

backup=$(mktemp -d "$base/backups/$(date -u +%Y%m%dT%H%M%SZ)-${revision}.XXXXXX")
if docker container inspect auto-workflow > /dev/null 2>&1; then
  previous_policy=$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' auto-workflow)
  printf '%s\n' "$(docker inspect --format '{{.Config.Image}}' auto-workflow)" > "$backup/PREVIOUS_IMAGE"
  docker stop --time 20 auto-workflow > /dev/null
  # Rename before recording the stopped state, so recovery always has a valid name.
  previous_container="auto-workflow-previous-$(basename "$backup")"
  if ! docker rename auto-workflow "$previous_container"; then
    docker start auto-workflow > /dev/null
    previous_container=''
    exit 1
  fi
  stopped=true
  docker update --restart=no "$previous_container" > /dev/null
elif systemctl is-active --quiet auto-workflow; then
  legacy=true
  stopped=true
  readlink -f "$base/current" > "$backup/PREVIOUS_RELEASE"
  systemctl stop auto-workflow
else
  echo 'Expected an existing container or legacy service; refusing an ambiguous migration.' >&2
  exit 1
fi

# Stop the application writer before backing up MySQL and retaining the legacy SQLite files.
docker exec auto-workflow-mysql mysqldump --defaults-extra-file=/run/secrets/client.cnf \
  --single-transaction --routines --triggers --hex-blob --no-tablespaces --set-gtid-purged=OFF auto_workflow > "$backup/mysql.sql"
shopt -s nullglob
database_files=("$data"/workflow.sqlite*)
if [[ ${#database_files[@]} -gt 0 ]]; then cp -a "${database_files[@]}" "$backup/"; fi
cp -a /etc/auto-workflow/auto-workflow.env "$backup/"
tar -czf "$backup/runtime-and-tenants.tar.gz" -C "$data" runtime tenants

# Node parses the mounted dotenv file; Docker --env-file does not unquote values.
# Fixed process variables override deployment-specific values in the mounted file.
docker create --name auto-workflow --restart unless-stopped --init \
  --user "$(id -u auto-workflow):$(id -g auto-workflow)" \
  --read-only --tmpfs /tmp:rw,nosuid,nodev,size=128m --cap-drop ALL --security-opt no-new-privileges \
  --log-opt max-size=10m --log-opt max-file=3 \
  --network auto-workflow --publish 127.0.0.1:4173:4173 \
  --mount "type=bind,src=$data,dst=$data" \
  --mount "type=bind,src=$data/runtime,dst=/app/.workflow-data" \
  --mount type=bind,src=/etc/auto-workflow,dst=/run/config,readonly \
  --env HOST=0.0.0.0 --env PORT=4173 --env NODE_ENV=production \
  --env DATABASE_DRIVER=mysql --env MYSQL_HOST=auto-workflow-mysql \
  --env MYSQL_DATABASE=auto_workflow --env MYSQL_USER=auto_workflow --env MYSQL_PORT=3306 \
  --env "DATABASE_PATH=$data/workflow.sqlite" --env "TENANT_ENV_DIR=$data/tenants" \
  --env "CODEX_WORKSPACE_DIR=$data/workspace" --env ACP_ENABLED=false \
  --env CODEX_EXECUTABLE=/nonexistent/codex \
  "$image" > /dev/null
created=true
docker start auto-workflow > /dev/null
for ((attempt = 0; attempt < 30; attempt++)); do
  if docker exec auto-workflow node scripts/deploy/container-health.mjs; then
    if [[ $legacy == true ]]; then systemctl disable auto-workflow; fi
    printf '%s\n' "$image" > "$base/DOCKER_IMAGE"
    stopped=false
    printf 'Deployed container %s\nBackup: %s\n' "$image" "$backup"
    exit 0
  fi
  sleep 2
done
echo 'Container health checks failed.' >&2
exit 1
