/**
 * Webhook triggers (PLAN C.6, R3 item 6): shared types.
 *
 * A hook is a signed public endpoint `POST /hooks/<id>` on the public ingress
 * listener. Hook definitions live in `~/.kirie/webhooks.db`; each hook's
 * secret lives in the credential store, never in config or in the database.
 */

/** Signature scheme, pinned per hook. A delivery is only checked against its hook's scheme. */
export type WebhookSource = "github" | "sentry" | "generic" | "bearer" | "alertmanager";

export const WEBHOOK_SOURCES: readonly WebhookSource[] = ["github", "sentry", "generic", "bearer", "alertmanager"];

/** `notify`: no model call, a rendered message. `task`: model work under a tool profile. */
export type WebhookAction = "notify" | "task";

/**
 * `summarize`: one no-tools model call. `investigate`: a background task with
 * read-only local tools. `full`: today's background task options; needs
 * `webhooks.allowFullProfile` and a per-hook opt-in.
 */
export type WebhookToolProfile = "summarize" | "investigate" | "full";

export const WEBHOOK_TOOL_PROFILES: readonly WebhookToolProfile[] = ["summarize", "investigate", "full"];

export interface WebhookDefinition {
  /** "<slug>-<8 hex>", also the URL path segment */
  id: string;
  /** Owner-facing slug */
  name: string;
  source: WebhookSource;
  enabled: boolean;
  /** Credential-store key of the current secret */
  secretRef: string;
  /** Credential-store key of the previous secret during a rotation grace window */
  prevSecretRef: string | null;
  prevSecretExpiresAt: string | null;
  /** Event filter; empty means every event */
  events: string[];
  action: WebhookAction;
  toolProfile: WebhookToolProfile;
  /** Per-hook opt-in for the `full` profile (the second of two keys) */
  allowFull: boolean;
  /** Owner-written, trusted. Payload values are never interpolated into it */
  instructions: string;
  /** Dot paths extracted into the message or the untrusted_fields block; empty means the source's defaults */
  fields: string[];
  /** Include the raw (truncated, scrubbed) payload in task prompts */
  includeRaw: boolean;
  /** CIDRs; empty means any address. Defense in depth only, never the authentication */
  ipAllowlist: string[];
  /** Per-minute limit; null means the config default */
  ratePerMin: number | null;
  /** Per-day cap; null means the config default */
  dailyCap: number | null;
  /** Static delivery target: the owner DM the hook was created from */
  channel: string;
  chatId: string;
  /** First good signature or provider ping */
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * accepted: claimed, action pending. done: action handed off or completed.
 * failed: the action failed or a restart interrupted it. ignored: event filter.
 * ping: provider ping. throttled: post-auth limit; a provider retry may claim it again.
 */
export type WebhookDeliveryStatus = "accepted" | "done" | "failed" | "ignored" | "ping" | "throttled";

export interface WebhookDelivery {
  id: number;
  hookId: string;
  /** sha256 hex */
  dedupeKey: string;
  /** X-GitHub-Delivery, Request-ID, X-Kirie-Delivery. Informational only, never the replay key */
  providerId: string | null;
  event: string | null;
  status: WebhookDeliveryStatus;
  taskId: string | null;
  /** Short reason for failed / throttled rows. Never payload text */
  note: string | null;
  bodyBytes: number | null;
  remoteIp: string | null;
  receivedAt: string;
}

/** Why a request was refused before authentication completed. Visible to the owner only. */
export type WebhookRejectReason =
  | "unknown_hook"
  | "disabled"
  | "unavailable"
  | "ip_not_allowed"
  | "missing_signature"
  | "bad_signature"
  | "missing_timestamp"
  | "stale_timestamp";
