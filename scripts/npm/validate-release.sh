#!/usr/bin/env bash
set -euo pipefail

# Read metadata only; never extract or execute code from an archive before publication.
tag=${GITHUB_REF_NAME:?Missing release tag}
if [[ ! "$tag" =~ ^agent-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo 'Expected a stable agent-vX.Y.Z release tag.' >&2
  exit 1
fi
version=${tag#agent-v}
archive="dist/device-agent/agent-workbench-connector-$version.tgz"
shopt -s nullglob
archives=(dist/device-agent/*.tgz)
if [[ ${#archives[@]} -ne 1 || "${archives[0]}" != "$archive" ]]; then
  echo 'Expected exactly one archive matching the release tag.' >&2
  exit 1
fi
tar -xOf "$archive" package/package.json | node --input-type=module -e '
  import assert from "node:assert/strict";
  import { readFileSync } from "node:fs";
  const packed = JSON.parse(readFileSync(0, "utf8"));
  const source = JSON.parse(readFileSync("packages/device-agent/package.json", "utf8"));
  for (const manifest of [packed, source]) {
    assert.equal(manifest.name, "agent-workbench-connector");
    assert.equal(manifest.version, process.argv[1]);
    assert.equal(manifest.repository?.url, "git+https://github.com/Gausons/auto-workflow.git");
    assert.equal(manifest.private, undefined);
  }
  // pnpm pack removes the build-only prepack lifecycle script from the published manifest.
  if (source.scripts) delete source.scripts.prepack;
  assert.deepEqual(packed, source, "Archive metadata differs from the tagged source");
' "$version"
printf 'archive=%s\nversion=%s\n' "$archive" "$version" >> "${GITHUB_OUTPUT:?Missing output file}"
