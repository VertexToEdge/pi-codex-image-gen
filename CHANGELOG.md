# Changelog

All notable changes to this project will be documented in this file.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning for releases.

## [Unreleased]

### Fixed

- Save and return images immediately after receiving their SSE output item, without waiting for gateway EOF or stream cancellation acknowledgement.
- End parsing on `response.completed` or `[DONE]`; enforce a five-minute gateway deadline, including retries, and interrupt pending stream reads on cancellation.

### Changed

- Replace an unsupported Pi-only image-save helper with atomic filesystem writes compatible with OMP.

- Rename the npm package to `pi-codex-compatible-image-gen`.

- Allow selecting gateway image routes `gpt-image-2.5-flare` and `gpt-image-2.5-sunburst` through the tool's `model` parameter; forward the selected route unchanged.


## [0.1.8] - 2026-05-10

### Fixed

- Disable install/update telemetry automatically in CI environments.

## [0.1.7] - 2026-05-10

### Added

- Install/update telemetry ping to `mocito.dev`, gated by Pi telemetry/offline settings and deduplicated per package version.

## [0.1.6] - 2026-05-09

### Changed

- Switched development, CI, and publish workflows from Bun to npm with `package-lock.json` for better Pi package consistency.

## [0.1.5] - 2026-05-07

### Added

- CI workflow running type-check and `pack:dry-run` on every push and PR.
- `CHANGELOG.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`.
- GitHub PR template and issue templates (bug report, feature request).
- `.editorconfig` for consistent editor settings.

### Changed

- `peerDependencies` relaxed to `"*"`; pinned versions moved to `devDependencies`.
- `tsconfig.json` module resolution updated from `Node16` to `NodeNext`.
- `package.json`: added `author`, `bugs`, `homepage`, `publishConfig.access`, `engines`, `pi-extension` keyword; community docs included in published `files`.

## [0.1.4] - 2026-05-07

### Fixed

- Added `repository.url` to `package.json`, required by npm provenance (sigstore) verification.

## [0.1.3] - 2026-05-07

### Changed

- Migrated peer dependencies from `@mariozechner` to `@earendil-works` scope (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` v0.74.0).

### Added

- `.github/workflows/publish.yml`: OIDC-based npm publish triggered on GitHub release.
- `scripts.check` and `scripts.pack:dry-run` in `package.json`.

## [0.1.2] - 2025

### Changed

- Moved extension entry point to `index.ts` at the package root for a cleaner npm package name display in Pi.

## [0.1.1] - 2025

### Fixed

- Fixed extension identifier to use the package name instead of `package:file`.

## [0.1.0] - 2025

### Added

- Initial release.
- `codex_generate_image` Pi extension using the OpenAI Codex ChatGPT backend (`gpt-image-2`). Piggybacks on Pi's `openai-codex` login — no `OPENAI_API_KEY` required.
- `skills/imagegen` Pi skill with prompting playbook, chroma-key transparency workflow, and Python CLI fallback (`image_gen.py`).
- Save-mode configuration (`none`, `project`, `global`, `custom`) with env and config-file overrides.
- SSE stream parsing with exponential backoff retry on transient errors.
