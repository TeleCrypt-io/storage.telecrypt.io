import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const provenancePath = "src/vendor/telecrypt-ui/PROVENANCE.json";
const stylesheetPath = "src/vendor/telecrypt-ui/product.css";
const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
const stylesheetHash = createHash("sha256").update(readFileSync(stylesheetPath)).digest("hex");

const expected = {
  vendor: "@telecrypt-io/ui",
  version: "0.1.1",
  canonical_source: "https://github.com/TeleCrypt-io/ui-shared-css",
  canonical_release: "v0.1.1",
  canonical_commit: "0034946dde095d3a1df80b2bdd9a6e6b317dcf09",
  source_file: "src/product.css",
  sha256: "ce9c3c0ff968d3156521e79f9f81a800441f730c2875adf37a7d28c57cab5f6a",
};

if (JSON.stringify(Object.keys(provenance).sort()) !== JSON.stringify(Object.keys(expected).sort())) {
  throw new Error("UI provenance must contain exactly the supported schema");
}

for (const [key, value] of Object.entries(expected)) {
  if (provenance[key] !== value) {
    throw new Error(`UI provenance ${key} does not match the selected release`);
  }
}
if (stylesheetHash !== expected.sha256) {
  throw new Error("Vendored UI stylesheet hash does not match the selected release");
}
