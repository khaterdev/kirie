/**
 * Audio/video format conversion using ffmpeg.
 * Only used when needed (video transcription, voice format conversion).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function extractAudioFromVideo(videoPath: string, outputPath: string): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-i", videoPath,
    "-vn", "-acodec", "libopus",
    "-y", outputPath,
  ]);
}

export async function convertAudioFormat(
  inputPath: string,
  outputPath: string,
  _format: string = "wav",
): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-i", inputPath,
    "-y", outputPath,
  ]);
}

export function isFfmpegAvailable(): boolean {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
