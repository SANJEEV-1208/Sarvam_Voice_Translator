# Live Speech Translator (Sarvam AI)

A small companion web app: speak into your mic in one Indian language, hear it
spoken back in another, in near real time.

## How it actually works (corrected from the earlier claims)

- **Speech → English text**: Sarvam's Speech-to-Text WebSocket
  (`wss://api.sarvam.ai/speech-to-text/ws`), model `saaras:v3`, `mode=translate`.
  This is the *only* live translation Sarvam exposes over WebSocket — it goes
  straight from speech in a supported Indic language to English text.
- **English → target language text**: a plain REST call to Sarvam's
  Translation API (`POST https://api.sarvam.ai/translate`). This step is
  skipped when the target language is English.
- **Text → speech**: Sarvam's Text-to-Speech WebSocket
  (`wss://api.sarvam.ai/text-to-speech/ws`), model `bulbul:v3`, streamed back
  as audio chunks.

There's no separate "Mayura WebSocket" for live translation, and Sarvam
doesn't publish the specific sub-200ms per-stage latency numbers quoted
earlier — real latency depends on your network, audio chunking, and load.

**Why a backend is required:** the Sarvam API key is sent as a request
header, so it must never reach the browser. This app runs a small Node
server that holds the key and relays audio/text/audio between your browser
and Sarvam's three endpoints above. A pure static site (e.g. plain HTML on
Vercel with no server) can't do this safely.

## Setup

```bash
cd sarvam-live-translator
npm install
cp .env.example .env
# edit .env and paste your key from https://dashboard.sarvam.ai/
npm start
```

Open http://localhost:3000, pick your source/target language, click **Start
speaking**, and talk. English captions and the translated text appear live;
translated audio plays automatically.

## Deploying it for real use

Because this needs a persistent Node process holding two live WebSocket
connections per user, it's a better fit for:

- **Render** or **Railway** (free/cheap tiers, trivial `npm start` deploy)
- **Fly.io**
- Any VPS

Set `SARVAM_API_KEY` as an environment variable on whichever platform you
pick — don't commit `.env`.

Vercel/Netlify's free static hosting won't work here since there's no place
to run the always-on Node server; their serverless functions have short
execution limits that don't suit long-lived voice sessions.

## Known limitations / things to tighten up before real use

- Audio is sent as small WAV chunks every ~0.5s rather than a continuous
  raw stream — simple and works, but adds a bit of latency versus a tighter
  streaming implementation using Sarvam's official JS/Python SDK.
- No reconnect/backoff logic on the STT/TTS sockets yet (see Sarvam's docs
  on handling `1006`/`1011` disconnects if you productionize this).
- No barge-in handling (interrupting playback when the user starts talking
  again) — the TTS docs describe a recipe for this if you want it.
- Default voice/speaker is fixed (`anushka`) — swap per-language voices to
  taste from Sarvam's voice list.
