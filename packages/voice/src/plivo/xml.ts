/**
 * Plivo XML builder (https://www.plivo.com/docs/voice/xml/): Speak, GetInput,
 * Redirect, Wait, Hangup. Every text and attribute value goes through
 * escapeXml; callers never build XML strings.
 *
 * Not verified against a live account (docs/voice-setup.md first-call checks):
 * that GetInput continues to the next element when there is no input (the
 * fall-through Redirect relies on it), and Polly voice names on Plivo.
 */

import type { SpeechOpts, VoiceMarkup } from "../provider.js";
import { el, xmlDocument } from "../xml.js";

function speak(text: string, v: SpeechOpts): string {
  return el("Speak", { voice: v.voice, language: v.language }, { text });
}

function redirect(url: string): string {
  return el("Redirect", { method: "POST" }, { text: url });
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Plivo hints: comma-separated phrases, at most 100 characters each. */
function hintsAttr(hints: string[] | undefined): string | undefined {
  if (!hints || hints.length === 0) return undefined;
  const cleaned = hints
    .map((h) => h.replace(/,/g, " ").trim().slice(0, 100))
    .filter((h) => h.length > 0)
    .slice(0, 500);
  return cleaned.length > 0 ? cleaned.join(",") : undefined;
}

export const plivoXml: VoiceMarkup = {
  contentType: "text/xml",

  reject(reason = "rejected") {
    return xmlDocument([el("Hangup", { reason })]);
  },

  sayAndHangup(text, v) {
    return xmlDocument([speak(text, v), el("Hangup")]);
  },

  gatherPin(o) {
    // DTMF only and log="false", so Plivo does not keep the digits in its logs.
    const input = el("GetInput", {
      action: o.action,
      method: "POST",
      inputType: "dtmf",
      numDigits: clamp(o.digits, 1, 32),
      finishOnKey: "#",
      executionTimeout: 15,
      digitEndTimeout: 5,
      redirect: "true",
      log: "false",
    }, { children: [speak(o.prompt, o)] });
    return xmlDocument([input, redirect(o.action)]);
  },

  gatherSpeech(o) {
    const children = (o.say ?? []).filter((t) => t.trim().length > 0).map((t) => speak(t, o));
    const input = el("GetInput", {
      action: o.action,
      method: "POST",
      inputType: "speech",
      executionTimeout: clamp(o.timeoutSeconds, 5, 60),
      speechEndTimeout: clamp(o.speechEndSeconds, 2, 10),
      language: o.language,
      hints: hintsAttr(o.hints),
      redirect: "true",
      log: "true",
    }, children.length > 0 ? { children } : undefined);
    return xmlDocument([input, redirect(o.fallthroughRedirect)]);
  },

  holdAndRedirect(o) {
    const parts: string[] = [];
    if (o.say) parts.push(speak(o.say, o));
    if (o.pauseSeconds && o.pauseSeconds > 0) parts.push(el("Wait", { length: clamp(o.pauseSeconds, 1, 10), silence: "true" }));
    parts.push(redirect(o.redirect));
    return xmlDocument(parts);
  },
};
