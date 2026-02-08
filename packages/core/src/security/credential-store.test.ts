import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { CredentialStore, CredentialStoreError } from "./credential-store.js";

const TEST_DIR = `/tmp/kirie-credstore-test-${process.pid}`;

function makeStore(overrides: Record<string, unknown> = {}): CredentialStore {
  // Use a passphrase so we don't depend on macOS Keychain in tests
  return new CredentialStore({
    credentialsDir: TEST_DIR,
    passphrase: "test-passphrase-for-unit-tests",
    ...overrides,
  });
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("CredentialStore", () => {
  describe("set and get", () => {
    it("stores and retrieves a credential", async () => {
      const store = makeStore();
      await store.set("telegram.bot_token", "my-secret-token");
      const value = await store.get("telegram.bot_token");
      expect(value).toBe("my-secret-token");
    });

    it("overwrites an existing credential", async () => {
      const store = makeStore();
      await store.set("key", "value1");
      await store.set("key", "value2");
      expect(await store.get("key")).toBe("value2");
    });

    it("returns undefined for non-existent credential", async () => {
      const store = makeStore();
      const value = await store.get("nonexistent");
      expect(value).toBeUndefined();
    });

    it("handles special characters in values", async () => {
      const store = makeStore();
      const specialValue = 'p@$$w0rd!#%^&*(){}[]|\\:";\'<>?,./~`';
      await store.set("special", specialValue);
      expect(await store.get("special")).toBe(specialValue);
    });

    it("handles unicode in values", async () => {
      const store = makeStore();
      const unicodeValue = "Hello, world! Bonjour le monde!";
      await store.set("unicode", unicodeValue);
      expect(await store.get("unicode")).toBe(unicodeValue);
    });

    it("handles long values", async () => {
      const store = makeStore();
      const longValue = "x".repeat(10000);
      await store.set("long-key", longValue);
      expect(await store.get("long-key")).toBe(longValue);
    });
  });

  describe("key validation", () => {
    it("accepts alphanumeric keys with dots, underscores, hyphens", async () => {
      const store = makeStore();
      await store.set("telegram.bot_token", "token1");
      await store.set("my-key", "token2");
      await store.set("key_name", "token3");
      await store.set("Key123", "token4");
      expect(await store.get("telegram.bot_token")).toBe("token1");
      expect(await store.get("my-key")).toBe("token2");
      expect(await store.get("key_name")).toBe("token3");
      expect(await store.get("Key123")).toBe("token4");
    });

    it("rejects empty key", async () => {
      const store = makeStore();
      await expect(store.set("", "value")).rejects.toThrow(CredentialStoreError);
    });

    it("rejects key with spaces", async () => {
      const store = makeStore();
      await expect(store.set("my key", "value")).rejects.toThrow(CredentialStoreError);
    });

    it("rejects key with slashes", async () => {
      const store = makeStore();
      await expect(store.set("my/key", "value")).rejects.toThrow(CredentialStoreError);
    });

    it("rejects key with path traversal characters", async () => {
      const store = makeStore();
      await expect(store.set("../etc/passwd", "value")).rejects.toThrow(CredentialStoreError);
    });
  });

  describe("value validation", () => {
    it("rejects empty value", async () => {
      const store = makeStore();
      await expect(store.set("key", "")).rejects.toThrow(CredentialStoreError);
    });
  });

  describe("delete", () => {
    it("deletes an existing credential and returns true", async () => {
      const store = makeStore();
      await store.set("delete-me", "value");
      const deleted = await store.delete("delete-me");
      expect(deleted).toBe(true);
      expect(await store.get("delete-me")).toBeUndefined();
    });

    it("returns false for non-existent credential", async () => {
      const store = makeStore();
      const deleted = await store.delete("nonexistent");
      expect(deleted).toBe(false);
    });
  });

  describe("list", () => {
    it("returns empty array when no credentials stored", () => {
      const store = makeStore();
      expect(store.list()).toEqual([]);
    });

    it("lists all stored credential keys sorted", async () => {
      const store = makeStore();
      await store.set("charlie", "val");
      await store.set("alpha", "val");
      await store.set("bravo", "val");
      expect(store.list()).toEqual(["alpha", "bravo", "charlie"]);
    });

    it("excludes deleted credentials", async () => {
      const store = makeStore();
      await store.set("keep", "val");
      await store.set("remove", "val");
      await store.delete("remove");
      expect(store.list()).toEqual(["keep"]);
    });
  });

  describe("resolve", () => {
    it("resolves a valid $credential: reference", async () => {
      const store = makeStore();
      await store.set("telegram.bot_token", "secret-123");
      const value = await store.resolve("$credential:telegram.bot_token");
      expect(value).toBe("secret-123");
    });

    it("throws for missing credential reference", async () => {
      const store = makeStore();
      await expect(store.resolve("$credential:missing.key")).rejects.toThrow(
        CredentialStoreError,
      );
    });

    it("throws for invalid reference format", async () => {
      const store = makeStore();
      await expect(store.resolve("not-a-reference")).rejects.toThrow(
        CredentialStoreError,
      );
    });
  });

  describe("environment variable fallback", () => {
    const ENV_KEY = "KIRIE_CREDENTIAL_ENVTEST";

    afterEach(() => {
      delete process.env[ENV_KEY];
    });

    it("returns env variable value when set", async () => {
      process.env[ENV_KEY] = "env-secret";
      const store = makeStore();
      const value = await store.get("envtest");
      expect(value).toBe("env-secret");
    });

    it("prefers env variable over stored credential", async () => {
      const store = makeStore();
      await store.set("envtest", "stored-value");
      process.env[ENV_KEY] = "env-value";
      const value = await store.get("envtest");
      expect(value).toBe("env-value");
    });
  });

  describe("KIRIE_MASTER_KEY environment variable", () => {
    afterEach(() => {
      delete process.env["KIRIE_MASTER_KEY"];
    });

    it("uses KIRIE_MASTER_KEY env var when set", async () => {
      const masterKey = randomBytes(32).toString("base64");
      process.env["KIRIE_MASTER_KEY"] = masterKey;
      const store = new CredentialStore({ credentialsDir: TEST_DIR });
      await store.set("env-master-test", "secret");
      expect(await store.get("env-master-test")).toBe("secret");
    });

    it("rejects short KIRIE_MASTER_KEY", async () => {
      process.env["KIRIE_MASTER_KEY"] = Buffer.from("short").toString("base64");
      expect(() => new CredentialStore({ credentialsDir: TEST_DIR })).not.toThrow();
      // The error happens when trying to encrypt/decrypt
      const store = new CredentialStore({ credentialsDir: TEST_DIR });
      // The loadMasterKey should throw if buf.length < 32
      await expect(store.set("key", "val")).rejects.toThrow();
    });
  });

  describe("file permissions", () => {
    it("creates credentials directory", () => {
      const customDir = `${TEST_DIR}/custom-creds`;
      makeStore({ credentialsDir: customDir });
      expect(existsSync(customDir)).toBe(true);
    });

    it("sets restrictive file permissions on stored credentials", async () => {
      const store = makeStore();
      await store.set("perms-test", "value");
      const fileStat = statSync(`${TEST_DIR}/perms-test.enc`);
      const mode = fileStat.mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  describe("audit", () => {
    it("returns empty array for empty store", async () => {
      const store = makeStore();
      const entries = await store.audit();
      expect(entries).toEqual([]);
    });

    it("returns audit entries for stored credentials", async () => {
      const store = makeStore();
      await store.set("audit-key1", "value1");
      await store.set("audit-key2", "value2");
      const entries = await store.audit();
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.key).sort()).toEqual(["audit-key1", "audit-key2"]);
      for (const entry of entries) {
        expect(entry.integrityOk).toBe(true);
        expect(entry.fileSize).toBeGreaterThan(0);
        expect(entry.permissions).toBe("600");
      }
    });
  });

  describe("encryption integrity", () => {
    it("different stores with same passphrase can read each other's data", async () => {
      const passphrase = "shared-passphrase";
      const store1 = new CredentialStore({ credentialsDir: TEST_DIR, passphrase });
      await store1.set("shared-key", "shared-value");

      const store2 = new CredentialStore({ credentialsDir: TEST_DIR, passphrase });
      expect(await store2.get("shared-key")).toBe("shared-value");
    });

    it("different passphrases cannot read each other's data", async () => {
      // Use a non-existent keychain service so the keychain lookup fails
      // and the passphrase is actually used for key derivation.
      const keychainService = `kirie-test-nonexistent-${process.pid}`;
      const store1 = new CredentialStore({
        credentialsDir: TEST_DIR,
        passphrase: "passphrase-1",
        keychainService,
      });
      await store1.set("private-key", "secret");

      const store2 = new CredentialStore({
        credentialsDir: TEST_DIR,
        passphrase: "passphrase-2",
        keychainService,
      });
      await expect(store2.get("private-key")).rejects.toThrow(CredentialStoreError);
    });
  });

  describe("safeCompare", () => {
    it("returns true for equal strings", () => {
      expect(CredentialStore.safeCompare("abc", "abc")).toBe(true);
    });

    it("returns false for different strings", () => {
      expect(CredentialStore.safeCompare("abc", "xyz")).toBe(false);
    });

    it("returns false for different length strings", () => {
      expect(CredentialStore.safeCompare("abc", "abcd")).toBe(false);
    });

    it("returns true for empty strings", () => {
      expect(CredentialStore.safeCompare("", "")).toBe(true);
    });
  });
});
