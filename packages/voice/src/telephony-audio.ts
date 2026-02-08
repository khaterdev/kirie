/**
 * Audio format conversion for telephony (G.711 mu-law).
 * Used for Twilio WebSocket media streams.
 */

// mu-law encoding/decoding tables (ITU-T G.711)
const BIAS = 0x84;
const CLIP = 32635;

const encodeTable = [
  0,0,1,1,2,2,2,2,3,3,3,3,3,3,3,3,
  4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,
  5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,
  5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,
  6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
  6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
  6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
  6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
];

function encodeMulawSample(sample: number): number {
  const sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  const exponent = encodeTable[(sample >> 7) & 0xff];
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function decodeMulawSample(byte: number): number {
  byte = ~byte;
  const sign = byte & 0x80;
  const exponent = (byte >> 4) & 0x07;
  const mantissa = byte & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  return sign !== 0 ? -sample : sample;
}

/** Convert 16-bit PCM buffer to G.711 mu-law */
export function pcmToMulaw(pcm: Buffer): Buffer {
  const output = Buffer.alloc(pcm.length / 2);
  for (let i = 0; i < output.length; i++) {
    const sample = pcm.readInt16LE(i * 2);
    output[i] = encodeMulawSample(sample);
  }
  return output;
}

/** Convert G.711 mu-law buffer to 16-bit PCM */
export function mulawToPcm(mulaw: Buffer): Buffer {
  const output = Buffer.alloc(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) {
    output.writeInt16LE(decodeMulawSample(mulaw[i]), i * 2);
  }
  return output;
}

/** Chunk audio buffer into frames of specified size (default 160 bytes = 20ms at 8kHz mu-law) */
export function* chunkAudio(audio: Buffer, chunkSize: number = 160): Generator<Buffer> {
  for (let offset = 0; offset < audio.length; offset += chunkSize) {
    yield audio.subarray(offset, Math.min(offset + chunkSize, audio.length));
  }
}
