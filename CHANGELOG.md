# Changelog

All notable changes to `@hasna/actions` are documented here.

## 0.1.6

### Changed

- **Reconcile `main` to the published npm line.** `main` had diverged: npm `latest`
  was `0.1.5` (published 2026-06-29) while `origin/main` was still `0.1.0` and had
  never received the `0.1.1`–`0.1.5` bumps. The published `0.1.5` code lived only on
  `feature/first-action-layer` (PR #1), and no git tags existed for any published
  version. This release merges the published `0.1.5` line into `main` (no-ff,
  preserving both histories) so that future fixes target the actually-deployed code.
  - Verified `feature/first-action-layer` (`b5cff00`) is byte-for-byte identical to
    the published `@hasna/actions@0.1.5` tarball (`dist/` diff clean) before merging;
    backfilled the missing `v0.1.5` tag at that commit.
  - Conflicts resolved in favor of the deployed (published) code.
  - Kept the additive docs contributed on `main` (`CONTRIBUTING.md`, `SECURITY.md`).
  - Removed the incompatible alternate contract-package design (`src/manifest.ts` and
    its tests, `src/mcp/capabilities.ts`) from the tree; those commits remain in git
    history via the no-ff merge (no commits lost).
- Version bumped above the published line (`0.1.5` → `0.1.6`); `src/version.ts` kept
  in sync with `package.json`.

## 0.1.5

- Last version published to npm prior to the reconciliation (2026-06-29). See the
  `feature/first-action-layer` history for the `0.1.1`–`0.1.5` changes (compact
  action CLI/MCP outputs, project dashboard capabilities, action queue contracts).

## 0.1.0

- Initial `open-actions` contract package scaffold.
