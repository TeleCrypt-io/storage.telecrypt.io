import assert from "node:assert/strict";
import { EXPECTED_PROVENANCE, validateSharedUiRelease } from "./verify-provenance.mjs";

const release = {
  tag_name: EXPECTED_PROVENANCE.canonical_release,
  name: EXPECTED_PROVENANCE.canonical_release,
  target_commitish: EXPECTED_PROVENANCE.canonical_commit,
  draft: false,
  prerelease: false,
  immutable: true,
  assets: [{
    id: 1,
    name: `telecrypt-io-ui-${EXPECTED_PROVENANCE.version}.tgz`,
    state: "uploaded",
    size: 1,
    digest: `sha256:${"a".repeat(64)}`,
  }],
};

assert.equal(validateSharedUiRelease(release), true);
for (const mutate of [
  (value) => { value.immutable = false; },
  (value) => { value.target_commitish = "f".repeat(40); },
  (value) => { value.assets = []; },
  (value) => { value.assets[0].digest = "sha256:not-a-digest"; },
]) {
  const invalid = structuredClone(release);
  mutate(invalid);
  assert.throws(() => validateSharedUiRelease(invalid), /shared UI Release/u);
}

console.log("shared UI provenance release checks passed");
