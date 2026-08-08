// server.js
// Companion server for live speech translation using Sarvam AI.
//
// Pipeline per spoken utterance:
//   Browser mic audio
//     -> this server
//       -> Sarvam Speech-to-Text WebSocket (mode=translate, saaras:v3) => English text
//       -> if targetLang !== English: Sarvam Translation REST API => target-language text
//       -> Sarvam Text-to-Speech REST API (bulbul:v3) => one complete WAV clip
//     -> back to browser for playback
//
// Note: an earlier version of this used the TTS *WebSocket* to stream audio
// chunks progressively. Those chunks are fragments of one continuous stream
// and aren't independently playable - relaying each one as its own audio
// clip (as the first version of this file did) is what caused the
// stuttering/broken audio. The REST endpoint returns one complete, clean
// WAV file per call instead, which is far more reliable for this use case
// at the cost of a small amount of latency.
//
// The Sarvam API key NEVER goes to the browser - it only lives here on the server.

import "dotenv/config";
import express from "express";
import http from "http";
import fetch from "node-fetch";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 3000;
const SARVAM_API_KEY = process.env.SARVAM_API_KEY;

if (!SARVAM_API_KEY) {
  console.error(
    "Missing SARVAM_API_KEY. Copy .env.example to .env and add your key from https://dashboard.sarvam.ai/"
  );
  process.exit(1);
}

const STT_URL = "wss://api.sarvam.ai/speech-to-text/ws";
const TTS_URL = "https://api.sarvam.ai/text-to-speech"; // REST, not WebSocket
const TRANSLATE_URL = "https://api.sarvam.ai/translate";

// Valid bulbul:v3 speakers (confirmed via a live 422 error from the API):
// aditya, ritu, ashutosh, priya, neha, rahul, pooja, rohan, simran, kavya,
// amit, dev, ishita, shreya, ratan, varun, manan, sumit, roopa, kabir, aayan,
// shubh, advait, anand, tanya, tarun, sunny, mani, gokul, vijay, shruti,
// suhani, mohit, kavitha, rehan, soham, rupali, niharika
// (Note: this list is specific to bulbul:v3 - older bulbul versions used
// different speaker names like "anushka", which is why that failed.)
const DEFAULT_SPEAKER = "shubh";

const app = express();
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/session" });

wss.on("connection", (clientWs) => {
  console.log("[client] connected");

  let sourceLangCode = "unknown"; // BCP-47, e.g. "ta-IN"; "unknown" = auto-detect
  let targetLangCode = "hi-IN"; // where we want the spoken output
  let sttWs = null;
  // Utterances can finish out of order relative to how long TTS takes, so
  // queue outgoing audio and play it in the order it was spoken.
  let speakQueue = Promise.resolve();

  function openStt() {
    const params = new URLSearchParams({
      "language-code": sourceLangCode,
      model: "saaras:v3",
      mode: "translate", // Sarvam translates speech -> English text for us
      sample_rate: "16000"
    });

    sttWs = new WebSocket(`${STT_URL}?${params.toString()}`, {
      headers: { "Api-Subscription-Key": SARVAM_API_KEY }
    });

    sttWs.on("open", () => console.log("[stt] connected"));

    sttWs.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "data" && msg.data && msg.data.transcript) {
        const englishText = msg.data.transcript.trim();
        if (!englishText) return;
        safeSend(clientWs, { type: "caption", lang: "en", text: englishText });
        await translateAndSpeak(englishText);
      } else if (msg.type === "error") {
        console.error("[stt] error message:", msg);
        safeSend(clientWs, { type: "error", stage: "stt", detail: msg });
      }
    });

    sttWs.on("close", (code, reason) =>
      console.log("[stt] closed", code, reason.toString())
    );
    sttWs.on("error", (err) => {
      console.error("[stt] socket error:", err.message);
      safeSend(clientWs, { type: "error", stage: "stt", detail: err.message });
    });
  }

  // Fetches one complete WAV clip for `text` and sends it to the browser.
  // Queued so clips are sent (and therefore played) in speaking order even
  // if two TTS requests happen to resolve out of order.
  function speak(text) {
    speakQueue = speakQueue.then(() => synthesizeAndSend(text));
    return speakQueue;
  }

  async function synthesizeAndSend(text) {
    try {
      const res = await fetch(TTS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-subscription-key": SARVAM_API_KEY
        },
        body: JSON.stringify({
          text,
          language_code: targetLangCode,
          speaker: DEFAULT_SPEAKER,
          model: "bulbul:v3",
          pace: 1.0,
          output_audio_codec: "wav"
        })
      });
      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`TTS API ${res.status}: ${errBody}`);
      }
      const data = await res.json();
      const audioBase64 = data.audios && data.audios[0];
      if (!audioBase64) throw new Error("TTS response had no audio");
      safeSend(clientWs, { type: "audio", audio: audioBase64, mime: "audio/wav" });
    } catch (err) {
      console.error("[tts] error:", err.message);
      safeSend(clientWs, { type: "error", stage: "tts", detail: err.message });
    }
  }

  async function translateAndSpeak(englishText) {
    let outText = englishText;

    if (targetLangCode !== "en-IN") {
      try {
        const res = await fetch(TRANSLATE_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "api-subscription-key": SARVAM_API_KEY
          },
          body: JSON.stringify({
            input: englishText,
            source_language_code: "en-IN",
            target_language_code: targetLangCode,
            model: "sarvam-translate:v1"
          })
        });
        if (!res.ok) {
          const errBody = await res.text();
          throw new Error(`Translate API ${res.status}: ${errBody}`);
        }
        const data = await res.json();
        outText = data.translated_text || englishText;
        safeSend(clientWs, {
          type: "caption",
          lang: targetLangCode,
          text: outText
        });
      } catch (err) {
        console.error("[translate] error:", err.message);
        safeSend(clientWs, { type: "error", stage: "translate", detail: err.message });
        // Fall back to speaking the English text rather than dropping the turn.
      }
    }

    speak(outText);
  }

  clientWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "start") {
      sourceLangCode = msg.sourceLang || "unknown";
      targetLangCode = msg.targetLang || "hi-IN";
      openStt();
      safeSend(clientWs, { type: "ready" });
      return;
    }

    if (msg.type === "audio_chunk" && msg.audio) {
      // msg.audio is a base64-encoded mono 16kHz 16-bit PCM WAV chunk
      if (sttWs && sttWs.readyState === WebSocket.OPEN) {
        sttWs.send(
          JSON.stringify({
            audio: {
              data: msg.audio,
              sample_rate: "16000",
              encoding: "audio/wav"
            }
          })
        );
      }
      return;
    }

    if (msg.type === "stop") {
      closeUpstream();
    }
  });

  clientWs.on("close", () => {
    console.log("[client] disconnected");
    closeUpstream();
  });

  function closeUpstream() {
    try { sttWs && sttWs.close(); } catch {}
  }
});

function safeSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

server.listen(PORT, () => {
  console.log(`Live translator server running at http://localhost:${PORT}`);
});