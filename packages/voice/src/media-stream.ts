/**
 * WebSocket media stream handler for Twilio bidirectional audio.
 *
 * Receives mu-law audio from Twilio → forwards to STT,
 * receives TTS output → converts to mu-law → sends back to Twilio.
 */
import { EventEmitter } from "node:events";
import { pcmToMulaw, mulawToPcm, chunkAudio } from "./telephony-audio.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Twilio WebSocket message types */
export type TwilioMediaMessageType = "connected" | "start" | "media" | "stop" | "mark";

export interface TwilioMediaMessage {
  event: TwilioMediaMessageType;
  sequenceNumber?: string;
  streamSid?: string;
  start?: {
    streamSid: string;
    accountSid: string;
    callSid: string;
    tracks: string[];
    mediaFormat: { encoding: string; sampleRate: number; channels: number };
  };
  media?: {
    track: string;
    chunk: string;
    timestamp: string;
    payload: string; // base64-encoded mu-law audio
  };
  stop?: {
    accountSid: string;
    callSid: string;
  };
  mark?: {
    name: string;
  };
}

export interface StreamSession {
  streamSid: string;
  callSid: string;
  startedAt: number;
}

export interface TtsQueueEntry {
  text: string;
  audioBuffer: Buffer; // PCM audio
}

// ---------------------------------------------------------------------------
// MediaStreamHandler
// ---------------------------------------------------------------------------

/**
 * Handles bidirectional audio between Twilio WebSocket and STT/TTS systems.
 *
 * Events:
 *   - "audio" (callSid: string, pcmBuffer: Buffer) — decoded PCM from caller
 *   - "connected" (session: StreamSession) — stream session established
 *   - "disconnected" (callSid: string) — stream ended
 */
export class MediaStreamHandler extends EventEmitter {
  private sessions = new Map<string, StreamSession>();
  private ttsQueues = new Map<string, TtsQueueEntry[]>();
  private ttsPlaying = new Map<string, boolean>();

  /**
   * Process a Twilio WebSocket message.
   * Call this from your WebSocket server's `message` handler.
   *
   * @param sendFn  Function to send a message back through the WebSocket
   * @param message Raw Twilio WebSocket message (parsed JSON)
   */
  handleMessage(
    sendFn: (data: string) => void,
    message: TwilioMediaMessage,
  ): void {
    switch (message.event) {
      case "connected":
        // Connection established, waiting for "start"
        break;

      case "start": {
        const start = message.start!;
        const session: StreamSession = {
          streamSid: start.streamSid,
          callSid: start.callSid,
          startedAt: Date.now(),
        };
        this.sessions.set(start.streamSid, session);
        this.ttsQueues.set(start.streamSid, []);
        this.ttsPlaying.set(start.streamSid, false);
        this.emit("connected", session);
        break;
      }

      case "media": {
        const media = message.media!;
        const payload = Buffer.from(media.payload, "base64");
        // Decode mu-law to 16-bit PCM
        const pcm = mulawToPcm(payload);
        const session = this.sessions.get(message.streamSid!);
        if (session) {
          this.emit("audio", session.callSid, pcm);
        }
        break;
      }

      case "stop": {
        const streamSid = message.streamSid;
        if (streamSid) {
          const session = this.sessions.get(streamSid);
          if (session) {
            this.emit("disconnected", session.callSid);
          }
          this.sessions.delete(streamSid);
          this.ttsQueues.delete(streamSid);
          this.ttsPlaying.delete(streamSid);
        }
        break;
      }

      case "mark": {
        // Mark event indicates a previously queued audio chunk has finished playing
        const streamSid = message.streamSid;
        if (streamSid) {
          this.ttsPlaying.set(streamSid, false);
          this.drainTtsQueue(streamSid, sendFn);
        }
        break;
      }
    }
  }

  /**
   * Queue TTS audio for playback to the caller.
   *
   * @param streamSid  The Twilio stream SID
   * @param pcmAudio   16-bit PCM audio buffer
   * @param sendFn     Function to send a message through the WebSocket
   */
  queueTts(
    streamSid: string,
    pcmAudio: Buffer,
    sendFn: (data: string) => void,
  ): void {
    const queue = this.ttsQueues.get(streamSid);
    if (!queue) return;

    // Convert PCM to mu-law and split into 20ms chunks
    const mulaw = pcmToMulaw(pcmAudio);
    for (const chunk of chunkAudio(mulaw, 160)) {
      queue.push({ text: "", audioBuffer: chunk });
    }

    this.drainTtsQueue(streamSid, sendFn);
  }

  /**
   * Send queued audio chunks to Twilio, one at a time.
   * After each chunk, we send a "mark" message. When Twilio
   * confirms playback with its own "mark" event, we send the next chunk.
   */
  private drainTtsQueue(
    streamSid: string,
    sendFn: (data: string) => void,
  ): void {
    if (this.ttsPlaying.get(streamSid)) return;

    const queue = this.ttsQueues.get(streamSid);
    if (!queue || queue.length === 0) return;

    const entry = queue.shift()!;
    this.ttsPlaying.set(streamSid, true);

    // Send media payload
    sendFn(JSON.stringify({
      event: "media",
      streamSid,
      media: {
        payload: entry.audioBuffer.toString("base64"),
      },
    }));

    // Send mark to get notified when playback completes
    sendFn(JSON.stringify({
      event: "mark",
      streamSid,
      mark: { name: `tts-${Date.now()}` },
    }));
  }

  /** Clear TTS queue for a stream (e.g., when caller interrupts) */
  clearTtsQueue(streamSid: string): void {
    const queue = this.ttsQueues.get(streamSid);
    if (queue) queue.length = 0;
  }

  /** Check if a stream session is active */
  hasSession(streamSid: string): boolean {
    return this.sessions.has(streamSid);
  }

  /** Get session info by stream SID */
  getSession(streamSid: string): StreamSession | undefined {
    return this.sessions.get(streamSid);
  }

  /** Get all active sessions */
  listSessions(): StreamSession[] {
    return [...this.sessions.values()];
  }
}
