#!/usr/bin/env bash
set -euo pipefail

# Intended for the isolated GitHub release job; no dependencies or Agent processes run here.
case ${RELEASE_BUMP:?Missing bump} in patch|minor|major) ;; *) echo 'Invalid version bump.' >&2; exit 1 ;; esac
base=${RELEASE_BASE:?Missing base commit}
run_id=${RELEASE_RUN_ID:?Missing workflow run ID}
[[ "$base" =~ ^[0-9a-f]{40}$ && "$run_id" =~ ^[0-9]+$ ]] || { echo 'Invalid release identity.' >&2; exit 1; }
: "${GITHUB_OUTPUT:?Missing output file}"
[[ -z "$(git status --porcelain)" ]] || { echo 'Release checkout must be clean.' >&2; exit 1; }
[[ "$(git rev-parse HEAD)" == "$base" ]] || { echo 'Release checkout differs from requested commit.' >&2; exit 1; }
git fetch origin main --tags

manifest=packages/device-agent/package.json
version=$(node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const pkg = JSON.parse(readFileSync(process.argv[1], "utf8"));
  if (pkg.name !== "agent-workbench-connector" || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(pkg.version)) {
    throw new Error("Expected the connector package with a stable version");
  }
  const parts = pkg.version.split(".").map(Number);
  const index = { major: 0, minor: 1, patch: 2 }[process.env.RELEASE_BUMP];
  parts[index]++;
  for (let i = index + 1; i < parts.length; i++) parts[i] = 0;
  if (!parts.every(Number.isSafeInteger)) throw new Error("Version is out of range");
  console.log(parts.join("."));
' "$manifest")
tag="agent-v$version"
message=$(printf 'chore(agent): release %s\n\nAgent-Release-Run: %s' "$version" "$run_id")

if git show-ref --verify --quiet "refs/tags/$tag"; then
  # Retrying this workflow must reuse its own release, never increment again or move a tag.
  commit=$(git rev-parse "$tag^{commit}")
  [[ "$(git show -s --format=%P "$commit")" == "$base" ]] || { echo 'Release tag has a different parent.' >&2; exit 1; }
  [[ "$(git show -s --format=%B "$commit")" == "$message" ]] || { echo 'Release tag belongs to another workflow run.' >&2; exit 1; }
  [[ "$(git diff-tree --no-commit-id --name-only -r "$commit")" == "$manifest" ]] || { echo 'Release tag contains unexpected changes.' >&2; exit 1; }
  git show "$commit:$manifest" | node --input-type=module -e '
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    const expected = JSON.parse(readFileSync(process.argv[1], "utf8"));
    expected.version = process.argv[2];
    assert.deepEqual(JSON.parse(readFileSync(0, "utf8")), expected);
  ' "$manifest" "$version"
  git merge-base --is-ancestor "$commit" origin/main
  echo "Reusing release $tag from this workflow run."
else
  [[ "$(git rev-parse origin/main)" == "$base" ]] || { echo 'main has advanced; start a new release from current main.' >&2; exit 1; }
  node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";
    const file = process.argv[1];
    const source = readFileSync(file, "utf8");
    // Preserve all formatting; only the top-level version value changes.
    const current = JSON.parse(source).version;
    const needle = "\"version\": " + JSON.stringify(current);
    if (source.split(needle).length !== 2) throw new Error("Ambiguous version field");
    writeFileSync(file, source.replace(needle, "\"version\": " + JSON.stringify(process.argv[2])));
  ' "$manifest" "$version"
  git add -- "$manifest"
  git -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' commit -m "$message"
  git tag "$tag"
  # No force push, no partial main/tag update, no automatic retry on uncertain outcomes.
  git push --atomic origin HEAD:refs/heads/main "refs/tags/$tag:refs/tags/$tag"
fi
printf 'tag=%s\nversion=%s\n' "$tag" "$version" >> "$GITHUB_OUTPUT"
