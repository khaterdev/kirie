/**
 * TwiML builder (https://www.twilio.com/docs/voice/twiml). Every text and
 * attribute value goes through escapeXml; callers never build TwiML strings.
 */

import type { SpeechOpts, VoiceMarkup } from "../provider.js";
import { el, xmlDocument } from "../xml.js";

function say(text: string, v: SpeechOpts): string {
  return el("Say", { voice: v.voice, language: v.language }, { text });
}

function redirect(url: string): string {
  return el("Redirect", { method: "POST" }, { text: url });
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}

export const twiml: VoiceMarkup = {
  contentType: "text/xml",

  reject(reason = "rejected") {
    return xmlDocument([el("Reject", { reason })]);
  },

  sayAndHangup(text, v) {
    return xmlDocument([say(text, v), el("Hangup")]);
  },

  gatherPin(o) {
    // DTMF only; an empty result still posts to the action, which counts it as a wrong attempt.
    const gather = el("Gather", {
      input: "dtmf",
      action: o.action,
      method: "POST",
      numDigits: clamp(o.digits, 1, 20),
      finishOnKey: "#",
      timeout: 10,
      actionOnEmptyResult: "true",
    }, { children: [say(o.prompt, o)] });
    return xmlDocument([gather, redirect(o.action)]);
  },

  gatherSpeech(o) {
    const children = (o.say ?? []).filter((t) => t.trim().length > 0).map((t) => say(t, o));
    const gather = el("Gather", {
      input: "speech",
      action: o.action,
      method: "POST",
      timeout: clamp(o.timeoutSeconds, 1, 60),
      speechTimeout: clamp(o.speechEndSeconds, 1, 10),
      language: o.language,
      hints: o.hints && o.hints.length > 0 ? o.hints.join(", ") : undefined,
      actionOnEmptyResult: "true",
    }, children.length > 0 ? { children } : undefined);
    return xmlDocument([gather, redirect(o.fallthroughRedirect)]);
  },

  holdAndRedirect(o) {
    const parts: string[] = [];
    if (o.say) parts.push(say(o.say, o));
    if (o.pauseSeconds && o.pauseSeconds > 0) parts.push(el("Pause", { length: clamp(o.pauseSeconds, 1, 10) }));
    parts.push(redirect(o.redirect));
    return xmlDocument(parts);
  },
};
