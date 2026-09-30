#!/usr/bin/env bash
# Run as root once after loading the official mysql:8.4 image.
set -euo pipefail
umask 077
[[ $EUID == 0 ]] || exit 64
config=/etc/auto-workflow-mysql
if docker container inspect auto-workflow-mysql > /dev/null 2>&1; then
  echo 'MySQL container already exists; inspect it instead of overwriting credentials.' >&2
  exit 1
fi
[[ ! -e $config && ! -e /var/lib/auto-workflow-mysql ]] || { echo 'Existing MySQL data/configuration requires manual inspection.' >&2; exit 1; }
docker image inspect mysql:8.4 > /dev/null
docker network inspect auto-workflow > /dev/null 2>&1 || docker network create auto-workflow > /dev/null
install -d -m 700 "$config" /var/lib/auto-workflow-mysql
openssl rand -hex 32 > "$config/root-password"
openssl rand -hex 32 > "$config/app-password"
printf '[client]\nuser=root\npassword=%s\n' "$(cat "$config/root-password")" > "$config/client.cnf"
# MySQL's entrypoint reads root-owned secret files before dropping privileges.
docker run -d --name auto-workflow-mysql --restart unless-stopped \
  --network auto-workflow --log-opt max-size=10m --log-opt max-file=3 \
  --mount type=bind,src=/var/lib/auto-workflow-mysql,dst=/var/lib/mysql \
  --mount "type=bind,src=$config,dst=/run/secrets,readonly" \
  --env MYSQL_ROOT_PASSWORD_FILE=/run/secrets/root-password \
  --env MYSQL_DATABASE=auto_workflow --env MYSQL_USER=auto_workflow \
  --env MYSQL_PASSWORD_FILE=/run/secrets/app-password \
  --health-cmd='mysqladmin --defaults-extra-file=/run/secrets/client.cnf ping --silent' \
  --health-interval=10s --health-timeout=5s --health-retries=6 --health-start-period=60s \
  mysql:8.4 --innodb-buffer-pool-size=128M --max-connections=30 --performance-schema=OFF \
  --mysqlx=OFF --max-allowed-packet=64M > /dev/null
for ((attempt = 0; attempt < 60; attempt++)); do
  if [[ $(docker inspect --format '{{.State.Health.Status}}' auto-workflow-mysql) == healthy ]]; then
    echo 'MySQL ready. Application credentials are stored in /etc/auto-workflow-mysql/app-password.'
    exit 0
  fi
  sleep 2
done
echo 'MySQL initialization failed; retained data/configuration for diagnosis.' >&2
exit 1
