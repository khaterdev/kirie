/**
 * Zero-quota login verification for an account (experiment E1).
 *
 * Opens a query with a prompt that never yields, asks the CLI for
 * `accountInfo()` (a control request: no model turn, no cost), then closes it.
 * An email means the CLI actually read the credential; no email (or
 * `tokenSource: "none"`) means not logged in; a timeout means the login is not
 * readable from the daemon's context. The token never leaves the CLI.
 */

import { query as sdkQuery, type Options, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { buildAccountEnv, type AccountEnvSource } from "./account-env.js";
import { maskEmail } from "./config-dir.js";
import type { SdkOptionsPipeline } from "../engine/sdk-options.js";

export const ACCOUNT_VERIFY_TIMEOUT_MS = 20_000;

export interface AccountVerifyResult {
  ok: boolean;
  /** Masked email */
  label?: string;
  /** Display string, e.g. "Claude Max" */
  subscription?: string;
  reason?: "not_logged_in" | "timeout" | "error";
}

export type AccountVerifier = (account: AccountEnvSource) => Promise<AccountVerifyResult>;

type QueryFn = (args: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;

/** A prompt stream that yields nothing until `end()`. */
function neverYielding(): { iterable: AsyncIterable<SDKUserMessage>; end: () => void } {
  let release: (() => void) | null = null;
  let ended = false;
  const iterable: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          ended
            ? Promise.resolve({ value: undefined, done: true as const })
            : new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
                release = () => resolve({ value: undefined, done: true });
              }),
        return: () => {
          ended = true;
          return Promise.resolve({ value: undefined, done: true as const });
        },
      };
    },
  };
  return {
    iterable,
    end: () => {
      ended = true;
      release?.();
    },
  };
}

export function createAccountVerifier(deps: {
  cwd: string;
  sdkOptions?: SdkOptionsPipeline;
  timeoutMs?: number;
  baseEnv?: () => NodeJS.ProcessEnv;
  query?: QueryFn;
}): AccountVerifier {
  const run = deps.query ?? (sdkQuery as unknown as QueryFn);
  const timeoutMs = deps.timeoutMs ?? ACCOUNT_VERIFY_TIMEOUT_MS;

  return async (account) => {
    const input = neverYielding();
    const options: Options = {
      env: buildAccountEnv(account, deps.baseEnv?.() ?? process.env),
      settingSources: [],
      persistSession: false,
      cwd: deps.cwd,
    };
    deps.sdkOptions?.apply(options, {
      kind: "utility",
      ownerDm: false,
      interactive: false,
      label: "account verify",
      cwd: deps.cwd,
    });

    let q: Query | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      q = run({ prompt: input.iterable, options });
      const stream = q;
      void (async () => {
        try {
          for await (const _ of stream) {
            // control requests produce no turn; drain whatever the CLI emits
          }
        } catch {
          // closing the query ends the stream with an error; nothing to do
        }
      })();
      const info = await Promise.race([
        stream.accountInfo(),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), timeoutMs);
        }),
      ]);
      if (info === "timeout") return { ok: false, reason: "timeout" };
      if (!info.email || info.tokenSource === "none") return { ok: false, reason: "not_logged_in" };
      return {
        ok: true,
        label: maskEmail(info.email),
        ...(info.subscriptionType ? { subscription: info.subscriptionType } : {}),
      };
    } catch {
      return { ok: false, reason: "error" };
    } finally {
      if (timer) clearTimeout(timer);
      input.end();
      try {
        q?.close();
      } catch {
        // already closed
      }
    }
  };
}
