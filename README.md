# storage.telecrypt.io

The static React/Vite site served at [storage.telecrypt.io](https://storage.telecrypt.io).
It uses the exact published `@telecrypt-io/storage@0.2.0` browser library; storage protocol,
cryptography, and the command-line client deliberately live in their own repositories.

## Source boundaries

- [`storage-sdk`](https://github.com/TeleCrypt-io/storage-sdk) owns the library source and future package releases.
- [`storage-cli`](https://github.com/TeleCrypt-io/storage-cli) owns the CLI migration source.
- This repository owns only the static website, its UI tests, and its GitHub Pages deployment.

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

## Authentication

The web application is OAuth/OIDC-only: it never presents, receives, or stores a Matrix
password. Local browser E2E tests authenticate through the disposable MAS authorization server,
then verify restoration from the OAuth session persisted by the application.

## Releases and deployment

Pushes and pull requests to `main` only verify the source. GitHub Pages deploys only when an
immutable `storage-web-v*` release tag is pushed. A deployment therefore always identifies the
exact source release that produced it; it never builds from a branch.
