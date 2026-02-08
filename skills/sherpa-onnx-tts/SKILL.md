---
name: sherpa-onnx-tts
description: Local offline text-to-speech using Sherpa ONNX with Piper voices
emoji: "\U0001F5E3"
version: "1.0.0"
requires:
  bins:
    - sherpa-onnx-offline-tts
invocation:
  userInvocable: true
---

# Sherpa ONNX TTS (Local Offline Text-to-Speech)

Convert text to speech audio entirely offline using the Sherpa ONNX runtime with Piper voice models. No cloud API or internet connection required.

## Usage
- "Say 'Hello, welcome to the meeting' and save as audio"
- "Convert this paragraph to speech"
- "Generate an audio file of these instructions using a female voice"
- "Read this text aloud at 1.2x speed"

## How it works
Runs the `sherpa-onnx-offline-tts` binary, which loads a Piper ONNX voice model and synthesizes speech from input text. Output is a WAV audio file.

### Key flags
- `--vits-model=<path>` -- path to the ONNX voice model file
- `--vits-tokens=<path>` -- path to the tokens file for the model
- `--vits-data-dir=<path>` -- path to the espeak-ng-data directory (for Piper models)
- `--output-filename=<path>` -- output WAV file path
- `--speed=<float>` -- speech speed multiplier (default 1.0; higher is faster)
- `--sid=<int>` -- speaker ID for multi-speaker models

### Example command
```bash
sherpa-onnx-offline-tts \
  --vits-model=./models/en_US-amy-medium.onnx \
  --vits-tokens=./models/tokens.txt \
  --vits-data-dir=./models/espeak-ng-data \
  --output-filename=output.wav \
  --speed=1.0 \
  "Hello, this is a test of local text to speech."
```

### Available voices
Piper provides dozens of voices across many languages. Popular English voices include:
- `en_US-amy-medium` (female, US English)
- `en_US-joe-medium` (male, US English)
- `en_GB-alan-medium` (male, British English)

Voice models can be downloaded from https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models

## Setup
1. Install sherpa-onnx: download pre-built binaries from https://github.com/k2-fsa/sherpa-onnx/releases or build from source.
2. Download at least one Piper voice model (ONNX file + tokens file + espeak-ng-data).
3. Ensure `sherpa-onnx-offline-tts` is on your PATH.
