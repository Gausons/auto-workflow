#!/usr/bin/env bash
set -euo pipefail

# Installed root-owned; the CI key has no shell, forwarding or arbitrary sudo access.
if [[ ${SSH_ORIGINAL_COMMAND:-} == capabilities ]]; then
  printf '%s\n' registry-v1
  exit 0
fi
if [[ ${SSH_ORIGINAL_COMMAND:-} =~ ^deploy\ ([0-9a-f]{40})\ (sha256:[0-9a-f]{64})$ ]]; then
  exec sudo -n /usr/local/sbin/auto-workflow-deploy "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
fi
if [[ ${SSH_ORIGINAL_COMMAND:-} =~ ^deploy\ ([0-9a-f]{40})$ ]]; then
  exec sudo -n /usr/local/sbin/auto-workflow-deploy "${BASH_REMATCH[1]}"
fi
echo 'Only capabilities or deploy <40-character commit SHA> [sha256:<digest>] is permitted.' >&2
exit 64
