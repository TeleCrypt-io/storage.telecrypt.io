# storage.telecrypt.io

The static React/Vite site served at [storage.telecrypt.io](https://storage.telecrypt.io).
It uses the exact published `@telecrypt-io/storage@0.2.13` browser library; storage protocol,
cryptography, and the command-line client deliberately live in their own repositories.

## Source boundaries

- [`storage-sdk`](https://github.com/TeleCrypt-io/storage-sdk) owns the library source and future package releases.
- [`storage-cli`](https://github.com/TeleCrypt-io/storage-cli) owns the CLI migration source.
- This repository owns only the static website, its UI tests, and its GitHub Pages deployment.

## Security boundaries

The web client uses MAS/OIDC authorization-code + PKCE only; it never collects or sends a Matrix
compatibility-login password. GitHub Pages cannot set response headers, so `index.html` provides an
early CSP meta policy as a baseline. A header CSP remains required when the static site moves behind
a header-capable edge. Vite relaxes only `connect-src` for its development server so the disposable
localhost MAS/Synapse fixture remains usable. Production and preproduction runtime settings are
served from the public `runtime-settings.json` file; the compiled JS and CSS assets do not embed
either endpoint. The settings file is validated before the UI renders: both endpoints must be
canonical HTTPS TeleCrypt URLs, and the homeserver and issuer must share an origin. The same exact
compiled JS, CSS, and other application assets can therefore be served in both environments. The
public settings file is separate environment configuration and is expected to differ.

## Shared UI vendor baseline

`src/vendor/telecrypt-ui/product.css` is an exact local vendor copy of the
canonical shared UI stylesheet. `src/theme.css` imports it directly, keeping
this repository self-contained without a runtime package dependency. The
vendor `PROVENANCE.json` records the exact `TeleCrypt-io/ui` release and commit,
Storage baseline, and content hash.

## Development and checks

```
npm ci
npm run dev       # http://localhost:5173
npm run lint
npm test          # component/wiring tests; no browser Harness execution in CI
npm run build
```

Browser acceptance tooling is operator-local Harness work, never a GitHub Actions job.

## Releases and deployment

Pushes and pull requests to `main` only verify the source. GitHub Pages deploys only when an
annotated `storage-web-v*` release tag is pushed. The workflow checks the tag type and package
version, and the repository ruleset forbids updating or deleting a release tag. Every correction
therefore requires a new version. The Pages artifact contains the production runtime settings;
preproduction must serve the same compiled assets with its own separately managed runtime settings
file, without rebuilding those assets. Promotion records must compare the compiled asset hashes
and record each environment's settings separately. The CSP permits HTTPS TeleCrypt subdomains for
these shared assets; a header-capable preproduction and production edge should narrow that policy
to each environment's exact backend origin when those hosts are selected.
