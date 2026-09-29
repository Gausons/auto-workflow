#!/usr/bin/env bash
set -euo pipefail
export PATH=/opt/node/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 077

[[ $EUID == 0 && $# == 1 && $1 =~ ^[0-9a-f]{40}$ ]] || exit 64
revision=$1
base=/opt/auto-workflow
data=/var/lib/auto-workflow
exec 9>/run/lock/auto-workflow-deploy.lock
flock -w 900 9

release=$(mktemp -d "$base/releases/${revision}.XXXXXX")
archive=$(mktemp /var/tmp/auto-workflow-release.XXXXXX)
previous=$(readlink -f "$base/current")
stopped=false
switched=false

# Invoked by the EXIT trap, including failures before the service is stopped.
# shellcheck disable=SC2317
recover() {
  result=$?
  trap - EXIT
  rm -f "$archive"
  if [[ $result != 0 && $stopped == true ]]; then
    if [[ $switched == true ]]; then
      ln -sfn "$previous" "$base/current.next"
      mv -Tf "$base/current.next" "$base/current"
    fi
    systemctl restart auto-workflow || true
    echo 'Deployment failed; previous code restored. Database was not reverted. Check the backup before any data recovery.' >&2
  fi
  exit "$result"
}
trap 'recover' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

cat > "$archive"
chown auto-workflow:auto-workflow "$release" "$archive"
runuser -u auto-workflow -- tar --no-same-owner --no-same-permissions -xzf "$archive" -C "$release"
[[ $(cat "$release/REVISION") == "$revision" ]]
[[ -f "$release/public/build/.vite/manifest.json" && -f "$release/server.ts" ]]
[[ ! -e "$release/.workflow-data" && ! -L "$release/.workflow-data" ]]
ln -s "$data/runtime" "$release/.workflow-data"
cd "$release"
runuser -u auto-workflow -- env CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --prod --frozen-lockfile --ignore-scripts
runuser -u auto-workflow -- node --import tsx --input-type=module -e 'await import("./src/database.ts"); await import("./src/issueSources/preload.ts");'

# Stop before copying SQLite, including any WAL, to keep the backup consistent.
backup="$base/backups/$(date -u +%Y%m%dT%H%M%SZ)-${revision}"
mkdir -p "$backup"
stopped=true
systemctl stop auto-workflow
shopt -s nullglob
database_files=("$data"/workflow.sqlite*)
[[ ${#database_files[@]} -gt 0 ]]
cp -a "${database_files[@]}" "$backup/"
cp -a /etc/auto-workflow/auto-workflow.env "$backup/"
tar -czf "$backup/runtime-and-tenants.tar.gz" -C "$data" runtime tenants
printf '%s\n' "$previous" > "$backup/PREVIOUS_RELEASE"

ln -sfn "$release" "$base/current.next"
mv -Tf "$base/current.next" "$base/current"
switched=true
systemctl start auto-workflow
for ((attempt = 0; attempt < 30; attempt++)); do
  if curl --fail --silent --max-time 3 http://127.0.0.1:4173/devices > /dev/null &&
      [[ $(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 3 http://127.0.0.1:4173/api/auth/session) == 401 ]]; then
    stopped=false
    printf 'Deployed %s\nBackup: %s\n' "$revision" "$backup"
    exit 0
  fi
  sleep 2
done
echo 'Health checks failed.' >&2
exit 1
