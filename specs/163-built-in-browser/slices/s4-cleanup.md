# S4: Remove the old proxy browser

Skills: `pichamber-change-discipline`, `ui-api-decoupling`.

## Acceptance criteria

- `IframeBrowserPane` (external sites proxied under the PiChamber origin) is gone; no runtime shows an external page inside the PiChamber origin. The dev server Preview pane is unchanged. Proof: tests, `bun run dead-code`, review of remaining `allowExternal` consumers.
- This folder is deleted and the lasting rules live in the owning `DOCUMENTATION.md` files, `packages/electron/README.md` and ADR 0012. The pull request closes #163. Proof: diff.

## Notes

- S3 already removed `IframeBrowserPane` and its unused helpers: the remote pane replaced it on every non-Electron runtime, which left it without a caller. S4 checks what remains of the external proxy path.

- Keep the server's `allowExternal` path only if `lib/preview/domAssetInlining.ts` still needs it.
- Lasting rules to move: the single owner rules of the spec README and the remote browser wire format (into `packages/web/server/lib/browser/DOCUMENTATION.md`).
