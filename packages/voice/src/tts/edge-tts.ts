import type { TTSProvider, TTSOptions, Voice } from "./types.js";
import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Edge TTS uses Microsoft's free TTS service via the edge-tts CLI.
 * Falls back gracefully if edge-tts is not installed.
 */
export class EdgeTTS implements TTSProvider {
  readonly name = "edge-tts";

  async synthesize(text: string, options?: TTSOptions): Promise<Buffer> {
    const voice = options?.voice ?? "en-US-AriaNeural";
    const format = options?.format ?? "mp3";

    const tmpDir = mkdtempSync(join(tmpdir(), "kirie-tts-"));
    const outFile = join(tmpDir, `output.${format}`);

    try {
      execFileSync(
        "edge-tts",
        ["--voice", voice, "--text", text, "--write-media", outFile],
        { timeout: 30000 },
      );

      return readFileSync(outFile);
    } catch (err) {
      throw new Error(
        `Edge TTS failed: ${err instanceof Error ? err.message : String(err)}. Is edge-tts installed? (pip install edge-tts)`,
      );
    } finally {
      try {
        unlinkSync(outFile);
      } catch {
        /* ignore */
      }
    }
  }

  async voices(): Promise<Voice[]> {
    try {
      const output = execFileSync("edge-tts", ["--list-voices"], {
        timeout: 10000,
        encoding: "utf-8",
      });
      const lines = output.split("\n").filter((l) => l.startsWith("Name:"));
      return lines.map((l) => {
        const name = l.replace("Name: ", "").trim();
        return { id: name, name };
      });
    } catch {
      return [];
    }
  }
}
