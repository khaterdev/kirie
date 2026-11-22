import { describe, it, expect } from "vitest";
import {
  describeMediaDownloadError,
  formatBytes,
  formatFailedMediaNote,
  toFailedMedia,
} from "./media-failure.js";

describe("describeMediaDownloadError", () => {
  it("classifies grammY's getFile 'file is too big' as too big with the Telegram 20 MB limit", () => {
    const err = new Error("Call to 'getFile' failed! (400: Bad Request: file is too big)");
    expect(describeMediaDownloadError(err, "telegram")).toEqual({
      reason: "file is too big (Telegram bot limit 20 MB)",
      tooBig: true,
    });
  });

  it("uses the limit stated by the adapter when present", () => {
    const err = new Error("file is too big (Telegram bot limit 2 GB, local Bot API server)");
    expect(describeMediaDownloadError(err, "telegram")).toEqual({
      reason: "file is too big (Telegram bot limit 2 GB, local Bot API server)",
      tooBig: true,
    });
  });

  it("uses a generic too-big reason for other channels", () => {
    const result = describeMediaDownloadError(new Error("HTTP 413 Payload Too Large"), "discord");
    expect(result.tooBig).toBe(true);
    expect(result.reason).toContain("too big");
  });

  it("reports generic failures with a trimmed error message", () => {
    const result = describeMediaDownloadError(new Error("fetch failed\n  ECONNRESET"), "telegram");
    expect(result).toEqual({ reason: "download failed: fetch failed ECONNRESET", tooBig: false });
  });

  it("handles non-Error throwables and empty messages", () => {
    expect(describeMediaDownloadError("boom").reason).toBe("download failed: boom");
    expect(describeMediaDownloadError(new Error("")).reason).toBe("download failed");
  });

  it("caps long error messages", () => {
    const result = describeMediaDownloadError(new Error("x".repeat(1000)));
    expect(result.reason.length).toBeLessThanOrEqual("download failed: ".length + 200);
  });
});

describe("formatBytes", () => {
  it("formats bytes, KB, MB and GB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(48.3 * 1024 * 1024)).toBe("48.3 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.0 GB");
  });
});

describe("formatFailedMediaNote", () => {
  it("includes type, reason, file name, size and resend advice for too-big files", () => {
    const failed = toFailedMedia(
      { type: "video", url: "file-id", filename: "clip.mp4", sizeBytes: 48.3 * 1024 * 1024 },
      "file is too big (Telegram bot limit 20 MB)",
      true,
    );
    const note = formatFailedMediaNote(failed);
    expect(note).toBe(
      "[📎 Video attached but could NOT be downloaded: file is too big (Telegram bot limit 20 MB). " +
        "File: clip.mp4, 48.3 MB. Tell the sender it didn't come through and ask them to send it " +
        "compressed or another way (e.g. AirDrop, a cloud link).]",
    );
  });

  it("omits missing details and includes the caption", () => {
    const failed = toFailedMedia(
      { type: "photo", url: "file-id", caption: "look at this" },
      "download failed: ECONNRESET",
      false,
    );
    const note = formatFailedMediaNote(failed);
    expect(note).toContain("[📎 Image attached but could NOT be downloaded: download failed: ECONNRESET.");
    expect(note).not.toContain("File:");
    expect(note).toContain('Caption: "look at this".');
    expect(note).toContain("ask them to resend it.");
  });
});
