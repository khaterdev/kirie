/**
 * Per-source knowledge (PLAN C.6, R3 "Signature schemes"): event names,
 * provider delivery ids, pings, default fields, provider setup text and the
 * sample payloads `/webhook test` signs.
 */

import { randomBytes } from "node:crypto";
import type { WebhookHeaders } from "./verify.js";
import type { WebhookSource } from "./types.js";

const SAFE_TOKEN_RE = /[^A-Za-z0-9._:/-]/g;

function clean(value: string | null | undefined, max = 100): string | null {
  if (typeof value !== "string") return null;
  const v = value.replace(SAFE_TOKEN_RE, "").slice(0, max);
  return v.length > 0 ? v : null;
}

function bodyString(body: unknown, key: string): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const v = (body as Record<string, unknown>)[key];
  return typeof v === "string" ? v : null;
}

/** Event name for the filter and the message header. Sanitised to a short token. */
export function webhookEventName(source: WebhookSource, headers: WebhookHeaders, body: unknown): string | null {
  switch (source) {
    case "github": {
      const ev = clean(headers.get("x-github-event"), 60);
      if (!ev) return null;
      const action = clean(bodyString(body, "action"), 40);
      return action ? `${ev}.${action}` : ev;
    }
    case "sentry": {
      const res = clean(headers.get("sentry-hook-resource"), 60);
      const action = clean(bodyString(body, "action"), 40);
      if (res && action) return `${res}.${action}`;
      return res ?? action;
    }
    case "alertmanager":
      return clean(bodyString(body, "status"), 40);
    case "generic":
    case "bearer":
      return clean(headers.get("x-kirie-event"), 60) ?? clean(bodyString(body, "event"), 60) ?? clean(bodyString(body, "type"), 60);
  }
}

/** Informational provider id (never the replay key: these headers are not signed). */
export function webhookProviderId(source: WebhookSource, headers: WebhookHeaders): string | null {
  switch (source) {
    case "github": return clean(headers.get("x-github-delivery"));
    case "sentry": return clean(headers.get("request-id"));
    default: return clean(headers.get("x-kirie-delivery"));
  }
}

/** A provider's "is this endpoint alive" request. Answered 200 pong, no action. */
export function isWebhookPing(source: WebhookSource, event: string | null): boolean {
  if (source === "github") return event === "ping";
  if (source === "sentry") return event === "installation.created";
  if (source === "generic" || source === "bearer") return event === "ping";
  return false;
}

/** Event filter: an entry matches the exact event, or any event under it ("issues" and "issues.*" match "issues.opened"). */
export function webhookEventMatches(filters: readonly string[], event: string | null): boolean {
  if (filters.length === 0) return true;
  if (!event) return false;
  return filters.some((f) => {
    const base = f.endsWith(".*") ? f.slice(0, -2) : f;
    return event === base || event.startsWith(`${base}.`);
  });
}

/** Fields shown when a hook names none. */
export function defaultWebhookFields(source: WebhookSource): string[] {
  switch (source) {
    case "github":
      return [
        "repository.full_name", "action", "sender.login", "ref",
        "workflow_run.name", "workflow_run.conclusion", "workflow_run.html_url",
        "pull_request.title", "pull_request.html_url", "issue.title", "issue.html_url",
        "head_commit.message", "release.tag_name",
      ];
    case "sentry":
      return ["action", "data.issue.title", "data.issue.culprit", "data.issue.level", "data.issue.permalink", "data.event.title"];
    case "alertmanager":
      return ["status", "commonLabels.alertname", "commonLabels.severity", "commonAnnotations.summary", "commonAnnotations.description", "externalURL"];
    case "generic":
    case "bearer":
      return ["event", "type", "title", "summary", "message", "status", "url"];
  }
}

/** A synthetic payload for `/webhook test`, with a nonce so each test is a new delivery. */
export function sampleWebhookPayload(source: WebhookSource): { body: Record<string, unknown>; headers: Record<string, string> } {
  const nonce = randomBytes(6).toString("hex");
  switch (source) {
    case "github":
      return {
        body: { action: "completed", repository: { full_name: "example/kirie-test" }, sender: { login: "kirie-test" },
          workflow_run: { name: "CI", conclusion: "success", html_url: "https://github.com/example/kirie-test/actions" }, kirie_test: nonce },
        headers: { "x-github-event": "workflow_run", "x-github-delivery": `test-${nonce}` },
      };
    case "sentry":
      return {
        body: { action: "created", data: { issue: { title: "Kirie test issue", level: "error", culprit: "test" } }, kirie_test: nonce },
        headers: { "sentry-hook-resource": "issue", "request-id": `test-${nonce}` },
      };
    case "alertmanager":
      return {
        body: { status: "firing", commonLabels: { alertname: "KirieTest", severity: "info" },
          commonAnnotations: { summary: "Kirie webhook test alert" }, kirie_test: nonce },
        headers: {},
      };
    case "generic":
    case "bearer":
      return { body: { event: "test", title: "Kirie webhook test", kirie_test: nonce }, headers: { "x-kirie-delivery": `test-${nonce}` } };
  }
}

/** Provider setup steps shown by `/webhook add` and `/webhook show`. Never contains the secret. */
export function webhookSetupText(source: WebhookSource, url: string): string {
  switch (source) {
    case "github":
      return [
        `GitHub: Settings > Webhooks > Add webhook. Payload URL ${url}`,
        "Content type: application/json (form encoding fails verification). Secret: the hook secret. Choose the events you want.",
        "GitHub sends a ping first; Kirie answers pong and marks the hook verified.",
      ].join("\n");
    case "sentry":
      return [
        `Sentry: Settings > Developer Settings > Internal Integration > Webhook URL ${url}`,
        "Sentry generates its own Client Secret. Write it to the import file named below (mode 0600),",
        "then send /webhook rotate-secret <id> from-file. Never paste it into a chat.",
      ].join("\n");
    case "alertmanager":
      return [
        "Alertmanager receiver:",
        "  webhook_configs:",
        `    - url: ${url}`,
        "      http_config:",
        "        authorization: { type: Bearer, credentials_file: /path/to/the/secret/file }",
        "Bearer hooks have no body signature: anyone holding the token can send any body.",
      ].join("\n");
    case "generic":
      return [
        `POST ${url} with Content-Type: application/json and headers:`,
        "  X-Kirie-Timestamp: <unix seconds>",
        "  X-Kirie-Signature: v1=<hex HMAC-SHA256(secret, \"v1:<timestamp>:<raw body>\")>",
        "  X-Kirie-Event: <optional event name>",
        "The timestamp must be within the configured tolerance (default 300 s).",
      ].join("\n");
    case "bearer":
      return [
        `POST ${url} with Content-Type: application/json and header Authorization: Bearer <secret> (or X-Kirie-Token).`,
        "Bearer hooks have no body signature: anyone holding the token can send any body.",
      ].join("\n");
  }
}
