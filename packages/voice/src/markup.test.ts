import { describe, it, expect } from "vitest";
import { twiml } from "./twilio/twiml.js";
import { plivoXml } from "./plivo/xml.js";
import type { VoiceMarkup } from "./provider.js";
import { findAll, parseXml } from "./test-helpers/xml.js";

const NASTY = `Tom & "Jerry" <script>'x'</script> ]]>`;
const V = { voice: "Polly.Joanna-Neural", language: "en-US" };

interface Dialect {
  name: string;
  markup: VoiceMarkup;
  say: string;
  gather: string;
  pause: string;
}

const dialects: Dialect[] = [
  { name: "TwiML", markup: twiml, say: "Say", gather: "Gather", pause: "Pause" },
  { name: "Plivo XML", markup: plivoXml, say: "Speak", gather: "GetInput", pause: "Wait" },
];

describe.each(dialects)("$name builder", (d) => {
  const m = d.markup;

  it("content type is text/xml", () => {
    expect(m.contentType).toBe("text/xml");
  });

  it("escapes & < > \" ' in every text field and still parses", () => {
    const docs = [
      m.sayAndHangup(NASTY, V),
      m.gatherPin({ action: `https://k.example/pin/t?a=1&b="2"`, digits: 4, prompt: NASTY, ...V }),
      m.gatherSpeech({ action: "https://k.example/turn/t?x=<1>", say: [NASTY, NASTY], timeoutSeconds: 5, speechEndSeconds: 3, hints: [NASTY], fallthroughRedirect: "https://k.example/turn/t?&'", ...V }),
      m.holdAndRedirect({ say: NASTY, pauseSeconds: 1, redirect: "https://k.example/wait/t?&", ...V }),
      m.reject("busy"),
    ];
    for (const doc of docs) {
      expect(doc.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
      expect(doc).not.toContain("<script>");
      expect(doc).not.toMatch(/&(?!(amp|lt|gt|quot|apos);)/);
      const root = parseXml(doc);
      expect(root.name).toBe("Response");
    }
    const say = findAll(parseXml(m.sayAndHangup(NASTY, V)), d.say)[0]!;
    expect(say.text).toBe(NASTY);
  });

  it("drops characters that are invalid in XML", () => {
    const doc = m.sayAndHangup("a\u0000b\u0007c", V);
    expect(findAll(parseXml(doc), d.say)[0]!.text).toBe("abc");
  });

  it("sayAndHangup speaks then hangs up", () => {
    const root = parseXml(m.sayAndHangup("Goodbye.", V));
    expect(root.children.map((c) => c.name)).toEqual([d.say, "Hangup"]);
    expect(root.children[0]!.attrs.voice).toBe(V.voice);
    expect(root.children[0]!.attrs.language).toBe(V.language);
  });

  it("speech gather carries the action, timeouts, nested say elements and the fall-through redirect", () => {
    const root = parseXml(m.gatherSpeech({
      action: "https://k.example/turn/tok", say: ["One.", "Two."], timeoutSeconds: 6, speechEndSeconds: 3,
      hints: ["calendar", "reminder"], fallthroughRedirect: "https://k.example/turn/tok", ...V,
    }));
    expect(root.children.map((c) => c.name)).toEqual([d.gather, "Redirect"]);
    const g = root.children[0]!;
    expect(g.attrs.action).toBe("https://k.example/turn/tok");
    expect(g.attrs.method).toBe("POST");
    expect(g.children.map((c) => c.name)).toEqual([d.say, d.say]);
    expect(g.children.map((c) => c.text)).toEqual(["One.", "Two."]);
    expect(root.children[1]!.text).toBe("https://k.example/turn/tok");
    expect(root.children[1]!.attrs.method).toBe("POST");
  });

  it("PIN gather is DTMF only", () => {
    const root = parseXml(m.gatherPin({ action: "https://k.example/pin/tok", digits: 6, prompt: "Enter your PIN.", ...V }));
    const g = root.children[0]!;
    expect(g.name).toBe(d.gather);
    const input = g.attrs.input ?? g.attrs.inputType;
    expect(input).toBe("dtmf");
    expect(g.attrs.numDigits).toBe("6");
    expect(g.children[0]!.text).toBe("Enter your PIN.");
  });

  it("hold and redirect", () => {
    const root = parseXml(m.holdAndRedirect({ say: "One moment.", pauseSeconds: 1, redirect: "https://k.example/wait/tok", ...V }));
    expect(root.children.map((c) => c.name)).toEqual([d.say, d.pause, "Redirect"]);
    const noSay = parseXml(m.holdAndRedirect({ redirect: "https://k.example/wait/tok", ...V }));
    expect(noSay.children.map((c) => c.name)).toEqual(["Redirect"]);
  });
});

describe("TwiML specifics", () => {
  it("speech gather uses input=speech, integer speechTimeout and actionOnEmptyResult", () => {
    const g = parseXml(twiml.gatherSpeech({ action: "a", timeoutSeconds: 5, speechEndSeconds: 3.4, fallthroughRedirect: "a", ...V })).children[0]!;
    expect(g.attrs.input).toBe("speech");
    expect(g.attrs.speechTimeout).toBe("3");
    expect(g.attrs.timeout).toBe("5");
    expect(g.attrs.actionOnEmptyResult).toBe("true");
    expect(g.attrs.language).toBe("en-US");
  });

  it("reject variants", () => {
    expect(parseXml(twiml.reject()).children[0]).toMatchObject({ name: "Reject", attrs: { reason: "rejected" } });
    expect(parseXml(twiml.reject("busy")).children[0]).toMatchObject({ name: "Reject", attrs: { reason: "busy" } });
  });
});

describe("Plivo XML specifics", () => {
  it("speech GetInput attributes within Plivo's documented ranges", () => {
    const g = parseXml(plivoXml.gatherSpeech({ action: "a", timeoutSeconds: 1, speechEndSeconds: 1, hints: ["a,b", "c"], fallthroughRedirect: "a", voice: "WOMAN", language: "en-US" })).children[0]!;
    expect(g.attrs.inputType).toBe("speech");
    expect(g.attrs.executionTimeout).toBe("5");
    expect(g.attrs.speechEndTimeout).toBe("2");
    expect(g.attrs.hints).toBe("a b,c");
    expect(g.attrs.redirect).toBe("true");
  });

  it("PIN GetInput has log=false", () => {
    const g = parseXml(plivoXml.gatherPin({ action: "a", digits: 4, prompt: "PIN", voice: "WOMAN", language: "en-US" })).children[0]!;
    expect(g.attrs.log).toBe("false");
    expect(g.attrs.inputType).toBe("dtmf");
  });

  it("reject variants are Hangup with a reason", () => {
    expect(parseXml(plivoXml.reject()).children[0]).toMatchObject({ name: "Hangup", attrs: { reason: "rejected" } });
    expect(parseXml(plivoXml.reject("busy")).children[0]).toMatchObject({ name: "Hangup", attrs: { reason: "busy" } });
  });

  it("Wait is silent", () => {
    const w = findAll(parseXml(plivoXml.holdAndRedirect({ pauseSeconds: 2, redirect: "r", voice: "WOMAN", language: "en-US" })), "Wait")[0]!;
    expect(w.attrs).toEqual({ length: "2", silence: "true" });
  });
});
