#!/usr/bin/env bash
set -euo pipefail

# Storage vendors the stylesheet, so this is a release-time provenance gate,
# not a runtime download. Keep the selected release exact until the shared UI
# source publishes a successor and this checkout updates its provenance.
ui_tag="v0.1.1"
ui_asset="telecrypt-io-ui-0.1.1.tgz"
temporary_dir="$(mktemp -d)"
trap 'rm -rf -- "$temporary_dir"' EXIT

bounded_command() {
  local output="$1" error="$2"
  shift 2
  python3 scripts/bounded-command.py \
    --stdout "$output" --stderr "$error" \
    --max-stdout-bytes 1048576 --max-stderr-bytes 524288 \
    --timeout-seconds 120 --kill-after-seconds 5 -- "$@"
  test ! -s "$error"
}

release_json="$temporary_dir/release.json"
bounded_command "$release_json.stdout" "$release_json.stderr" \
  gh api --hostname github.com --header 'X-GitHub-Api-Version: 2026-03-10' \
  "/repos/TeleCrypt-io/ui-shared-css/releases/tags/$ui_tag"
mv -- "$release_json.stdout" "$release_json"

jq -e --arg tag "$ui_tag" --arg asset "$ui_asset" '
  type == "object" and .tag_name == $tag and .name == $tag and
  .draft == false and .prerelease == false and .immutable == true and
  (.target_commitish | type == "string" and test("^[0-9a-f]{40}$")) and
  (.assets | type == "array" and length == 1) and
  (.assets[0] | type == "object" and .name == $asset and .state == "uploaded" and
    (.id | type == "number" and . > 0 and floor == .) and
    (.size | type == "number" and . > 0 and floor == .) and
    (.digest | type == "string" and test("^sha256:[0-9a-f]{64}$")))
' "$release_json" >/dev/null

asset_id="$(jq -er '.assets[0].id' "$release_json")"
asset_size="$(jq -er '.assets[0].size' "$release_json")"
asset_digest="$(jq -er '.assets[0].digest' "$release_json")"
archive="$temporary_dir/$ui_asset"
bounded_command "$archive.stdout" "$archive.stderr" \
  gh api --hostname github.com --header 'Accept: application/octet-stream' \
  --header 'X-GitHub-Api-Version: 2026-03-10' --output "$archive" \
  "repos/TeleCrypt-io/ui-shared-css/releases/assets/$asset_id"
test ! -s "$archive.stdout" -a "$(wc -c <"$archive")" = "$asset_size"
test "sha256:$(sha256sum "$archive" | awk '{print $1}')" = "$asset_digest"
node scripts/verify-provenance.mjs "$release_json" "$archive"
