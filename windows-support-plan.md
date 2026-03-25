# Windows Support Plan

## Overview

Kirie currently runs on macOS and Linux. A user attempting to install on Windows (Node.js 24, Windows 10/11) hit two issues: workspace path problems and embedding model download crash. A full audit revealed several areas that need fixing for proper Windows support.

## Current State

- **Platform detection**: Partially exists. `packages/skills/src/types.ts` defines `os?: ("darwin" | "linux" | "win32")[]` and the skill loader checks `process.platform`. Credential store checks for `darwin`. No centralized platform utility.
- **fastembed**: `2.1.0` (3 months old), depends on `onnxruntime-node@1.21.0` (outdated, latest is `1.24.3`)
- **onnxruntime-node**: `1.21.0` locked. Latest `1.24.3` has explicit Windows x64 + arm64 prebuilts, Node 22 support added in `1.24.1`. Node 24 not officially confirmed but N-API should provide forward compat.
- **Setup wizard**: No error handling around embedding model download (line 460-461 of `apps/cli/src/setup.ts`). If ONNX init fails, entire setup crashes.
- **Existing safe exec utility**: `src/utils/execFileNoThrow.ts` exists. Use `execFileSync`/`execFile` instead of `exec` to avoid shell injection.
- **Test framework**: Vitest with `*.test.ts` files co-located with source. Config at root `vitest.config.ts`.

---

## Testing Requirements

Every phase MUST include real test files that:
- Use Vitest (`import { describe, it, expect, vi } from "vitest"`)
- Follow the existing co-located `*.test.ts` convention (test file next to source file)
- Test actual behavior, not mock everything away. Mock only external dependencies (filesystem, child_process) where necessary to simulate cross-platform behavior
- Cover both happy path AND error/edge cases
- All tests MUST pass before the phase is considered complete

**Final gate**: After all phases are implemented, `pnpm test` must pass with zero failures across the entire repo.

---

## Phase 1: Platform Detection & Utilities

**Goal**: Centralized platform detection so all code can branch cleanly.

### 1.1 Create `packages/core/src/platform.ts`

```typescript
import { execFileSync } from "node:child_process";

export const IS_WINDOWS = process.platform === "win32";
export const IS_MACOS = process.platform === "darwin";
export const IS_LINUX = process.platform === "linux";

/**
 * Cross-platform binary existence check.
 * Uses execFileSync with `where` on Windows, `which` on Unix.
 * No shell invocation -- safe from injection.
 */
export function binExists(name: string): boolean {
  try {
    const cmd = IS_WINDOWS ? "where" : "which";
    execFileSync(cmd, [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
```

### 1.2 Update `packages/skills/src/loader.ts:64`

Replace the Unix-only `execSync("which ...")` call with the cross-platform `binExists` from `@kirie/core`.

**Files**: `packages/core/src/platform.ts` (new), `packages/core/src/index.ts` (export), `packages/skills/src/loader.ts` (update import)

### 1.3 Tests: `packages/core/src/platform.test.ts`

Test file: `packages/core/src/platform.test.ts`

Tests to write:
- `binExists` returns `true` for a binary that definitely exists on all platforms (e.g. `node`)
- `binExists` returns `false` for a binary that does not exist (e.g. `nonexistent_binary_xyz_12345`)
- `binExists` does not throw on non-existent binary (returns false gracefully)
- `IS_WINDOWS`, `IS_MACOS`, `IS_LINUX` are booleans and exactly one matches `process.platform`
- `binExists` is safe with special characters in binary name (no shell injection): pass names like `; rm -rf /` and verify it returns false without executing anything
- Mock `process.platform` to `"win32"` and verify `binExists` calls `where` (use `vi.spyOn` on `child_process.execFileSync`)
- Mock `process.platform` to `"darwin"` and verify `binExists` calls `which`

---

## Phase 2: Embedding Model & ONNX Runtime

**Goal**: Local embeddings work on Windows, and failures are handled gracefully.

### 2.1 Update `onnxruntime-node` to `1.24.3`

Current: `1.21.0` (locked via fastembed). Latest: `1.24.3` with:
- Explicit Windows x64 + arm64 prebuilt binaries
- Node.js 22 support (added in 1.24.1)
- Fixed NuGet path resolution bugs that caused Windows install failures
- Lowered minimum Windows version to 10.0.19041 (Server 2019 compat)

**Action**: Add `onnxruntime-node: "^1.24.3"` and `onnxruntime-common: "^1.24.3"` as direct dependencies in `packages/memory/package.json` to override fastembed's pinned `1.21.0`. This is a standard pnpm override pattern.

### 2.2 Investigate fastembed update

Current: `2.1.0`. Check `fastembed-js` GitHub for newer releases that bump onnxruntime. If none exist, the direct override in 2.1 is sufficient.

### 2.3 Fix setup wizard error handling

**File**: `apps/cli/src/setup.ts` (lines 452-464)

Current code (no error handling):
```typescript
if (embeddingProvider === "local") {
  const dl = await p.confirm({ message: "Download embedding model now (~33MB)?", initialValue: true });
  if (!p.isCancel(dl) && dl) {
    const s = p.spinner();
    s.start("Downloading snowflake-arctic-embed-s...");
    const { ensureModelDownloaded } = await import("@kirie/memory");
    await ensureModelDownloaded();
    s.stop("Embedding model downloaded");
  }
}
```

**Replace with**:
```typescript
if (embeddingProvider === "local") {
  const dl = await p.confirm({ message: "Download embedding model now (~33MB)?", initialValue: true });
  if (!p.isCancel(dl) && dl) {
    const s = p.spinner();
    s.start("Downloading snowflake-arctic-embed-s...");
    try {
      const { ensureModelDownloaded } = await import("@kirie/memory");
      await ensureModelDownloaded();
      s.stop("Embedding model downloaded");
    } catch (err) {
      s.stop("Failed to download embedding model");
      p.log.warn(`Embedding model download failed: ${(err as Error).message}`);
      p.log.info("You can retry later with: kirie embeddings download");

      const fallback = await p.select({
        message: "How would you like to handle embeddings?",
        options: [
          { value: "openai", label: "Use OpenAI API instead", hint: "Requires API key" },
          { value: "noop", label: "Disable for now", hint: "No semantic search" },
          { value: "local", label: "Keep local (will retry on first use)" },
        ],
      });
      if (!p.isCancel(fallback) && fallback !== "local") {
        embeddingProvider = fallback;
        if (fallback === "openai") {
          const key = await p.text({ message: "OpenAI API key for embeddings", placeholder: "sk-..." });
          if (!p.isCancel(key)) embeddingApiKey = key as string;
        }
      }
    }
  }
}
```

### 2.4 Add `kirie embeddings download` CLI command

Add a standalone CLI command to retry model download outside of setup. Useful when setup skipped download or it failed.

**File**: `apps/cli/src/index.ts` (add command), reuse `ensureModelDownloaded` from `@kirie/memory`

### 2.5 Wrap LocalEmbeddings init with graceful fallback

**File**: `packages/memory/src/embeddings.ts` (line 85-113)

The `init()` method in `LocalEmbeddings` should catch ONNX init errors and log a clear message instead of crashing the daemon:
```
[embeddings] Failed to initialize local ONNX model: <error>
[embeddings] Falling back to NoopEmbeddings. Semantic search disabled.
[embeddings] To fix: run "kirie embeddings download" or switch to OpenAI embeddings.
```

### 2.6 Tests: `packages/memory/src/embeddings.test.ts`

Test file: `packages/memory/src/embeddings.test.ts`

Tests to write:
- `LocalEmbeddings.init()` catches ONNX init failure and falls back to `NoopEmbeddings` instead of throwing
- `LocalEmbeddings.init()` logs a warning message when fallback occurs
- `NoopEmbeddings.embed()` returns empty arrays (verify noop behavior)
- `createEmbeddings()` factory returns correct type based on config (`"local"`, `"openai"`, `"noop"`)
- When `ensureModelDownloaded` throws, the error is catchable and contains a useful message

---

## Phase 3: npm Scripts (Cross-Platform)

**Goal**: All npm scripts work on Windows cmd.exe, PowerShell, and Unix shells.

### 3.1 Replace `rm -rf dist` in all package.json `clean` scripts

**14 files** have `"clean": "rm -rf dist"` which fails on Windows cmd.exe.

**Fix**: Use Node.js built-in (zero dependencies):
```json
"clean": "node -e \"require('fs').rmSync('dist',{recursive:true,force:true})\""
```

**All files to update**:
- `packages/core/package.json`
- `packages/memory/package.json`
- `packages/media/package.json`
- `packages/voice/package.json`
- `packages/skills/package.json`
- `packages/canvas/package.json`
- `packages/plugin-sdk/package.json`
- `apps/daemon/package.json`
- `apps/cli/package.json`
- `channels/telegram/package.json`
- `channels/discord/package.json`
- `channels/slack/package.json`
- `channels/signal/package.json`
- `channels/whatsapp/package.json`

### 3.2 Tests: Verify clean scripts

Test file: `packages/core/src/scripts.test.ts`

Tests to write:
- Read every `package.json` in the monorepo that has a `"clean"` script and assert it does NOT contain `rm -rf` (regression test)
- Assert all `clean` scripts use the cross-platform `node -e` pattern or another Windows-safe approach
- This is a static analysis test that reads actual package.json files from disk, not a mock

---

## Phase 4: Credential Store (Windows Support)

**Goal**: Credential storage works on Windows without crashing.

### 4.1 Skip Unix file permission checks on Windows

**File**: `packages/core/src/security/credential-store.ts`

Lines 430-462 check Unix-style permissions (`0o600`, `0o700`) which are meaningless on Windows. `fs.chmod()` only controls the read-only flag on Windows.

**Fix**: Wrap permission checks with:
```typescript
if (process.platform !== "win32") {
  // existing permission validation logic
}
```

### 4.2 Verify non-macOS fallback

Lines 355-362, 380-390 already check `process.platform === "darwin"`. Verify the fallback path works on Windows (PBKDF2 derivation from passphrase or `KIRIE_MASTER_KEY` env var). Add a setup hint on Windows: "Set KIRIE_MASTER_KEY environment variable for credential encryption."

### 4.3 (Future) Add Windows Credential Manager support

Use `keytar` npm package or Windows `cmdkey` CLI. Not blocking for initial support since `KIRIE_MASTER_KEY` env var and passphrase fallback both work.

### 4.4 Tests: `packages/core/src/security/credential-store.test.ts`

Test file: `packages/core/src/security/credential-store.test.ts`

Tests to write:
- Permission validation is skipped when `process.platform` is mocked to `"win32"` (no error thrown for files without Unix perms)
- Permission validation runs normally when `process.platform` is `"darwin"` or `"linux"`
- `KIRIE_MASTER_KEY` env var is accepted as key source on all platforms
- PBKDF2 passphrase derivation works (not platform-dependent)
- macOS Keychain code path is only called when `process.platform === "darwin"` (mock and verify)
- Credential store initializes without error when run in a mocked Windows environment (no Keychain, no Unix perms)

---

## Phase 5: Signal Handling

**Goal**: Daemon shutdown works cleanly on Windows.

### 5.1 Handle SIGKILL differences

**File**: `apps/daemon/src/lifecycle.ts` (lines 1094-1100)

On Windows, `SIGKILL` doesn't exist. Node.js on Windows translates `kill()` to process termination.

**Fix**:
```typescript
if (process.platform === "win32") {
  kokoroProc.kill(); // Default signal, terminates on Windows
} else {
  kokoroProc.kill("SIGKILL");
}
```

### 5.2 SIGTERM/SIGINT handling

Lines 1010-1011: On Windows, `SIGINT` works (Ctrl+C), `SIGTERM` is not reliably delivered. Current code is acceptable since Node.js handles translation. Add a comment documenting this behavior.

### 5.3 Tests: `apps/daemon/src/lifecycle.test.ts`

Test file: `apps/daemon/src/lifecycle.test.ts`

Tests to write:
- When `process.platform` is `"win32"`, `kill()` is called without a signal argument (not `"SIGKILL"`)
- When `process.platform` is `"darwin"` or `"linux"`, `kill("SIGKILL")` is used
- The kill call does not throw regardless of platform
- Mock a child process object and verify the correct kill method is invoked per platform

---

## Phase 6: Docker/Sandbox Paths

**Goal**: Docker volume mounts work correctly with Windows paths.

### 6.1 Path conversion for Docker bind mounts

**File**: `packages/core/src/sandbox/docker.ts`

Windows paths like `C:\Users\foo\.kirie\workspace` need conversion to `/c/Users/foo/.kirie/workspace` for Docker Desktop on Windows.

**Fix**: Add a path conversion helper in `platform.ts`:
```typescript
export function toDockerPath(hostPath: string): string {
  if (!IS_WINDOWS) return hostPath;
  return hostPath
    .replace(/^([A-Z]):\\/, (_, drive) => `/${drive.toLowerCase()}/`)
    .replace(/\\/g, "/");
}
```

Use this in `docker.ts` when building `-v` bind mount arguments.

### 6.2 Tests: Add to `packages/core/src/platform.test.ts`

Additional tests in the existing platform test file:

Tests to write:
- `toDockerPath("C:\\Users\\foo\\.kirie")` returns `"/c/Users/foo/.kirie"` when `IS_WINDOWS` is true
- `toDockerPath("D:\\Projects\\app")` returns `"/d/Projects/app"` (different drive letter)
- `toDockerPath("/home/user/.kirie")` returns the same path unchanged on non-Windows
- `toDockerPath` handles paths with spaces: `"C:\\Program Files\\app"` returns `"/c/Program Files/app"`
- `toDockerPath` handles lowercase drive letters gracefully
- `toDockerPath` handles UNC paths or returns them unchanged (edge case)

---

## Phase 7: CI & Full Verification

### 7.1 CI: Add Windows runner

Add a Windows runner to GitHub Actions CI:
```yaml
strategy:
  matrix:
    os: [ubuntu-latest, macos-latest, windows-latest]
```

### 7.2 Final test gate

After all phases are complete:

1. Run `pnpm test` -- **ALL tests must pass** (existing + new)
2. Run `pnpm build` -- build must succeed
3. Run `pnpm lint` (if configured) -- no new lint errors

If any test fails, the implementation is not complete. Fix the failure before moving on.

### 7.3 Manual testing checklist

- [ ] `pnpm install` completes on Windows (Node 22 + Node 24)
- [ ] `pnpm build` completes on Windows
- [ ] `pnpm test` passes on Windows
- [ ] `kirie setup` runs end-to-end on Windows
- [ ] Local embedding download + init works on Windows
- [ ] Embedding download failure is caught gracefully with fallback options
- [ ] Daemon starts and responds on Telegram from Windows
- [ ] `pnpm clean` works on Windows
- [ ] Credential store works with `KIRIE_MASTER_KEY` env var on Windows
- [ ] Docker sandbox mounts work with Windows paths (if Docker Desktop installed)

---

## Test Files Summary

| Phase | Test File | What It Tests |
|-------|-----------|---------------|
| 1 | `packages/core/src/platform.test.ts` | `binExists()`, platform constants, shell injection safety, cross-platform command selection |
| 2 | `packages/memory/src/embeddings.test.ts` | ONNX init failure fallback, `NoopEmbeddings` behavior, `createEmbeddings` factory |
| 3 | `packages/core/src/scripts.test.ts` | Static analysis: no `rm -rf` in any package.json clean script |
| 4 | `packages/core/src/security/credential-store.test.ts` | Permission checks skipped on Windows, env var key source, platform-guarded Keychain |
| 5 | `apps/daemon/src/lifecycle.test.ts` | Signal handling per platform, correct kill method invocation |
| 6 | `packages/core/src/platform.test.ts` (extended) | `toDockerPath()` Windows path conversion, drive letters, spaces, edge cases |

---

## Dependency Updates Summary

| Package | Current | Target | Reason |
|---------|---------|--------|--------|
| `onnxruntime-node` | `1.21.0` (via fastembed) | `^1.24.3` | Windows prebuilts, Node 22 support, NuGet path fix |
| `onnxruntime-common` | `1.21.0` (via fastembed) | `^1.24.3` | Must match onnxruntime-node version |
| `fastembed` | `2.1.0` | Check for updates, otherwise keep + override onnxruntime | Dependency chain |

---

## Priority Order

| Priority | Phase | Description | Impact |
|----------|-------|-------------|--------|
| 1 | 2.3 | Fix setup crash (error handling on embedding download) | **Critical** -- setup crashes on Windows |
| 2 | 2.1 | Update onnxruntime-node to 1.24.3 | **Critical** -- Windows prebuilts missing in 1.21.0 |
| 3 | 1 | Platform detection + fix `which` command + tests | **High** -- skill detection broken on Windows |
| 4 | 3 | Fix `rm -rf` in 14 npm scripts + regression test | **High** -- `pnpm clean` broken on Windows |
| 5 | 4.1 | Skip permission checks on Windows + tests | **High** -- credential store may crash |
| 6 | 2.5-2.6 | Wrap LocalEmbeddings init with fallback + tests | **Medium** -- daemon crash prevention |
| 7 | 5 | Signal handling fixes + tests | **Medium** -- clean shutdown on Windows |
| 8 | 2.4 | Add `kirie embeddings download` command | **Medium** -- UX improvement |
| 9 | 6 | Docker path conversion + tests | **Low** -- only affects sandbox users on Windows |
| 10 | 7 | CI Windows runner + full test gate | **Ongoing** |
| 11 | 4.3 | Windows Credential Manager | **Future** |
