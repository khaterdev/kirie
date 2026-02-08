import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { readFile, writeFile, unlink, chmod, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CredentialStoreOptions {
  /** Override credentials directory (default: ~/.kirie/credentials/) */
  credentialsDir?: string;
  /** Passphrase for PBKDF2 key derivation (fallback when keychain unavailable) */
  passphrase?: string;
  /** Service name used in macOS Keychain */
  keychainService?: string;
  /** Account name used in macOS Keychain */
  keychainAccount?: string;
}

export interface CredentialAuditEntry {
  key: string;
  fileSize: number;
  permissions: string;
  lastModified: Date;
  integrityOk: boolean;
}

interface EncryptedPayload {
  /** Version for forward compatibility */
  v: 1;
  /** Base64-encoded IV (12 bytes) */
  iv: string;
  /** Base64-encoded salt used for PBKDF2 (32 bytes) – stored per-file for key rotation */
  salt: string;
  /** Base64-encoded ciphertext */
  ct: string;
  /** Base64-encoded auth tag (16 bytes) */
  tag: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALGORITHM = "aes-256-gcm" as const;
const IV_BYTES = 12;
const SALT_BYTES = 32;
const KEY_BYTES = 32;
const TAG_BYTES = 16;
const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_DIGEST = "sha512";
const FILE_PERMISSION = 0o600;
const DIR_PERMISSION = 0o700;
const KEYCHAIN_SERVICE = "kirie-credential-store";
const KEYCHAIN_ACCOUNT = "master-key";
const CREDENTIAL_FILE_EXT = ".enc";
const ENV_PREFIX = "KIRIE_CREDENTIAL_";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeKeyName(key: string): string {
  if (!key || typeof key !== "string") {
    throw new CredentialStoreError("Credential key must be a non-empty string");
  }
  // Allow alphanumeric, dots, underscores, hyphens
  if (!/^[a-zA-Z0-9._-]+$/.test(key)) {
    throw new CredentialStoreError(
      `Invalid credential key "${key}": only alphanumeric, dots, underscores, and hyphens are allowed`,
    );
  }
  return key;
}

function keyToFilename(key: string): string {
  return sanitizeKeyName(key) + CREDENTIAL_FILE_EXT;
}

function filenameToKey(filename: string): string {
  if (!filename.endsWith(CREDENTIAL_FILE_EXT)) {
    throw new CredentialStoreError(`Invalid credential file: ${filename}`);
  }
  return filename.slice(0, -CREDENTIAL_FILE_EXT.length);
}

function envKeyName(credKey: string): string {
  return ENV_PREFIX + credKey.replace(/[.-]/g, "_").toUpperCase();
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CredentialStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CredentialStoreError";
  }
}

// ---------------------------------------------------------------------------
// CredentialStore
// ---------------------------------------------------------------------------

export class CredentialStore {
  private readonly credentialsDir: string;
  private readonly keychainService: string;
  private readonly keychainAccount: string;
  private readonly passphrase: string | undefined;
  private masterKeyCache: Buffer | null = null;

  constructor(options: CredentialStoreOptions = {}) {
    this.credentialsDir =
      options.credentialsDir ?? join(homedir(), ".kirie", "credentials");
    this.keychainService = options.keychainService ?? KEYCHAIN_SERVICE;
    this.keychainAccount = options.keychainAccount ?? KEYCHAIN_ACCOUNT;
    this.passphrase = options.passphrase;
    this.ensureDir();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Retrieve a credential value by key. Returns undefined if not found. */
  async get(key: string): Promise<string | undefined> {
    sanitizeKeyName(key);

    // Check environment variable first (CI/CD fallback)
    const envVal = process.env[envKeyName(key)];
    if (envVal !== undefined) {
      return envVal;
    }

    const filePath = join(this.credentialsDir, keyToFilename(key));
    if (!existsSync(filePath)) {
      return undefined;
    }

    try {
      const raw = await readFile(filePath, "utf-8");
      const payload: EncryptedPayload = JSON.parse(raw);
      return this.decrypt(payload);
    } catch (err) {
      throw new CredentialStoreError(
        `Failed to read credential "${key}": ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  /** Store a credential value under the given key. Overwrites if exists. */
  async set(key: string, value: string): Promise<void> {
    sanitizeKeyName(key);

    if (typeof value !== "string" || value.length === 0) {
      throw new CredentialStoreError("Credential value must be a non-empty string");
    }

    const payload = await this.encrypt(value);
    const filePath = join(this.credentialsDir, keyToFilename(key));
    await writeFile(filePath, JSON.stringify(payload), { mode: FILE_PERMISSION });
    // Ensure permissions even if file previously existed with wrong mode
    await chmod(filePath, FILE_PERMISSION);
  }

  /** Delete a stored credential. Returns true if it existed. */
  async delete(key: string): Promise<boolean> {
    sanitizeKeyName(key);
    const filePath = join(this.credentialsDir, keyToFilename(key));
    if (!existsSync(filePath)) {
      return false;
    }
    await unlink(filePath);
    return true;
  }

  /** List all stored credential keys (does not include env-only credentials). */
  list(): string[] {
    if (!existsSync(this.credentialsDir)) {
      return [];
    }
    return readdirSync(this.credentialsDir)
      .filter((f) => f.endsWith(CREDENTIAL_FILE_EXT))
      .map(filenameToKey)
      .sort();
  }

  /** Audit all stored credentials for integrity and file permission issues. */
  async audit(): Promise<CredentialAuditEntry[]> {
    const keys = this.list();
    const results: CredentialAuditEntry[] = [];

    for (const key of keys) {
      const filePath = join(this.credentialsDir, keyToFilename(key));
      const fileStat = await stat(filePath);
      const permissions = (fileStat.mode & 0o777).toString(8);
      let integrityOk = true;

      try {
        const raw = await readFile(filePath, "utf-8");
        const payload: EncryptedPayload = JSON.parse(raw);
        // Attempt decryption to verify integrity
        this.decrypt(payload);
      } catch {
        integrityOk = false;
      }

      results.push({
        key,
        fileSize: fileStat.size,
        permissions,
        lastModified: fileStat.mtime,
        integrityOk,
      });
    }

    return results;
  }

  /** Resolve a $credential:key reference to its value. */
  async resolve(ref: string): Promise<string> {
    const prefix = "$credential:";
    if (!ref.startsWith(prefix)) {
      throw new CredentialStoreError(
        `Invalid credential reference: "${ref}" (must start with "${prefix}")`,
      );
    }
    const key = ref.slice(prefix.length);
    const value = await this.get(key);
    if (value === undefined) {
      throw new CredentialStoreError(
        `Credential "${key}" not found. Set it with: kirie credential set ${key}`,
      );
    }
    return value;
  }

  // -----------------------------------------------------------------------
  // Encryption / Decryption
  // -----------------------------------------------------------------------

  private async encrypt(plaintext: string): Promise<EncryptedPayload> {
    const iv = randomBytes(IV_BYTES);
    const salt = randomBytes(SALT_BYTES);
    const derivedKey = this.deriveKey(await this.getMasterKey(), salt);

    const cipher = createCipheriv(ALGORITHM, derivedKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf-8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return {
      v: 1,
      iv: iv.toString("base64"),
      salt: salt.toString("base64"),
      ct: encrypted.toString("base64"),
      tag: tag.toString("base64"),
    };
  }

  private decrypt(payload: EncryptedPayload): string {
    if (payload.v !== 1) {
      throw new CredentialStoreError(
        `Unsupported credential format version: ${String(payload.v)}`,
      );
    }

    const iv = Buffer.from(payload.iv, "base64");
    const salt = Buffer.from(payload.salt, "base64");
    const ct = Buffer.from(payload.ct, "base64");
    const tag = Buffer.from(payload.tag, "base64");

    if (iv.length !== IV_BYTES) {
      throw new CredentialStoreError("Invalid IV length");
    }
    if (tag.length !== TAG_BYTES) {
      throw new CredentialStoreError("Invalid auth tag length");
    }

    const masterKey = this.getMasterKeySync();
    const derivedKey = this.deriveKey(masterKey, salt);

    const decipher = createDecipheriv(ALGORITHM, derivedKey, iv);
    decipher.setAuthTag(tag);

    try {
      const decrypted = Buffer.concat([decipher.update(ct), decipher.final()]);
      return decrypted.toString("utf-8");
    } catch (err) {
      throw new CredentialStoreError(
        "Decryption failed: credential may be corrupt or master key has changed",
        { cause: err },
      );
    }
  }

  // -----------------------------------------------------------------------
  // Key Management
  // -----------------------------------------------------------------------

  private deriveKey(masterKey: Buffer, salt: Buffer): Buffer {
    return pbkdf2Sync(
      masterKey,
      salt,
      PBKDF2_ITERATIONS,
      KEY_BYTES,
      PBKDF2_DIGEST,
    );
  }

  private async getMasterKey(): Promise<Buffer> {
    if (this.masterKeyCache) {
      return this.masterKeyCache;
    }
    const key = this.loadMasterKey();
    this.masterKeyCache = key;
    return key;
  }

  private getMasterKeySync(): Buffer {
    if (this.masterKeyCache) {
      return this.masterKeyCache;
    }
    const key = this.loadMasterKey();
    this.masterKeyCache = key;
    return key;
  }

  private loadMasterKey(): Buffer {
    // 1. Environment variable override (for CI/CD)
    const envKey = process.env["KIRIE_MASTER_KEY"];
    if (envKey) {
      const buf = Buffer.from(envKey, "base64");
      if (buf.length < KEY_BYTES) {
        throw new CredentialStoreError(
          "KIRIE_MASTER_KEY must be at least 32 bytes (base64-encoded)",
        );
      }
      return buf;
    }

    // 2. macOS Keychain via `security` CLI
    if (process.platform === "darwin") {
      try {
        return this.loadFromKeychain();
      } catch {
        // Keychain not available or key not stored yet; fall through
      }
    }

    // 3. Passphrase-based PBKDF2 derivation
    if (this.passphrase) {
      const passphraseSalt = Buffer.from(
        `kirie:${this.keychainService}:${this.keychainAccount}`,
        "utf-8",
      );
      return pbkdf2Sync(
        this.passphrase,
        passphraseSalt,
        PBKDF2_ITERATIONS,
        KEY_BYTES,
        PBKDF2_DIGEST,
      );
    }

    // 4. Auto-generate and store in keychain (macOS only)
    if (process.platform === "darwin") {
      const newKey = randomBytes(KEY_BYTES);
      try {
        this.storeInKeychain(newKey);
        return newKey;
      } catch (err) {
        throw new CredentialStoreError(
          "No master key available. Set KIRIE_MASTER_KEY env var or provide a passphrase.",
          { cause: err },
        );
      }
    }

    throw new CredentialStoreError(
      "No master key available. Set KIRIE_MASTER_KEY env var or provide a passphrase.",
    );
  }

  private loadFromKeychain(): Buffer {
    const output = execSync(
      `security find-generic-password -s ${JSON.stringify(this.keychainService)} -a ${JSON.stringify(this.keychainAccount)} -w 2>/dev/null`,
      { encoding: "utf-8", timeout: 5000 },
    ).trim();

    if (!output) {
      throw new CredentialStoreError("Empty keychain entry");
    }

    return Buffer.from(output, "base64");
  }

  private storeInKeychain(key: Buffer): void {
    const b64 = key.toString("base64");
    execSync(
      `security add-generic-password -s ${JSON.stringify(this.keychainService)} -a ${JSON.stringify(this.keychainAccount)} -w ${JSON.stringify(b64)} -U`,
      { encoding: "utf-8", timeout: 5000 },
    );
  }

  // -----------------------------------------------------------------------
  // File System
  // -----------------------------------------------------------------------

  private ensureDir(): void {
    if (!existsSync(this.credentialsDir)) {
      mkdirSync(this.credentialsDir, { recursive: true, mode: DIR_PERMISSION });
    }
  }

  /** Verify directory permissions are secure. Returns issues found. */
  async verifyPermissions(): Promise<string[]> {
    const issues: string[] = [];

    try {
      const dirStat = await stat(this.credentialsDir);
      const dirMode = dirStat.mode & 0o777;
      if (dirMode !== DIR_PERMISSION) {
        issues.push(
          `Credentials directory has permissions ${dirMode.toString(8)}, expected ${DIR_PERMISSION.toString(8)}`,
        );
      }
    } catch {
      issues.push("Credentials directory does not exist or is not accessible");
      return issues;
    }

    const files = readdirSync(this.credentialsDir).filter((f) =>
      f.endsWith(CREDENTIAL_FILE_EXT),
    );

    for (const file of files) {
      const filePath = join(this.credentialsDir, file);
      const fileStat = statSync(filePath);
      const fileMode = fileStat.mode & 0o777;
      if (fileMode !== FILE_PERMISSION) {
        issues.push(
          `${file} has permissions ${fileMode.toString(8)}, expected ${FILE_PERMISSION.toString(8)}`,
        );
      }
    }

    return issues;
  }

  /** Constant-time comparison helper exposed for transport security. */
  static safeCompare(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
      return false;
    }
    return timingSafeEqual(bufA, bufB);
  }
}
