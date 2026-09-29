#!/usr/bin/env bash
set -euo pipefail

# Installed root-owned; the CI key has no shell, forwarding or arbitrary sudo access.
if [[ ${SSH_ORIGINAL_COMMAND:-} =~ ^deploy\ ([0-9a-f]{40})$ ]]; then
  exec sudo -n /usr/local/sbin/auto-workflow-deploy "${BASH_REMATCH[1]}"
fi
echo 'Only deploy <40-character commit SHA> is permitted.' >&2
exit 64
