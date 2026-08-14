import "dotenv/config";
import express from "express";
import http from "http";
import fetch from "node-fetch";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 3000;
const SARVAM_API_KEY = process.env.SARVAM_API_KEY;

if (!SARVAM_API_KEY) {
  console.error("Missing SARVAM_API_KEY in .env");
  process.exit(1);
}

const STT_URL       = "wss://api.sarvam.ai/speech-to-text/ws";
const TTS_URL       = "https://api.sarvam.ai/text-to-speech";
const TRANSLATE_URL = "https://api.sarvam.ai/translate";
const DEFAULT_SPEAKER = "shubh";

const app = express();
app.use(express.static("public"));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/session" });

// ── rooms ─────────────────────────────────────────────────────────────────────
// rooms = { "roomCode": { rep: wsClient, client: wsClient } }
const rooms = {};

function getRoom(code) {
  if (!rooms[code]) rooms[code] = { rep: null, client: null };
  return rooms[code];
}

function getPartner(roomCode, myRole) {
  const room = rooms[roomCode];
  if (!room) return null;
  return myRole === "rep" ? room.client : room.rep;
}

function cleanRoom(roomCode, role) {
  if (!rooms[roomCode]) return;
  rooms[roomCode][role] = null;
  // Delete room if both left
  if (!rooms[roomCode].rep && !rooms[roomCode].client) {
    delete rooms[roomCode];
    console.log(`[room:${roomCode}] deleted`);
  }
}

// ── per-client handler ────────────────────────────────────────────────────────
wss.on("connection", (clientWs) => {
  console.log("[client] connected");

  let roomCode   = null;
  let myRole     = null;   // "rep" or "client"
  let sourceLang = "en-IN";
  let targetLang = "hi-IN";
  let sttWs      = null;
  let speakQueue = Promise.resolve();

  function openStt() {
    const params = new URLSearchParams({
      "language-code": sourceLang,
      model: "saaras:v3",
      mode: "translate",  // Sarvam auto-translates speech to English text
      sample_rate: "16000"
    });

    sttWs = new WebSocket(`${STT_URL}?${params}`, {
      headers: { "Api-Subscription-Key": SARVAM_API_KEY }
    });

    sttWs.on("open", () => console.log(`[stt:${myRole}] connected`));

    sttWs.on("message", async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === "data" && msg.data?.transcript) {
        const englishText = msg.data.transcript.trim();
        if (!englishText) return;

        // Send original caption back to SPEAKER (so they see what they said)
        safeSend(clientWs, { type: "caption", lang: "source", text: englishText });

        // Translate and send audio to PARTNER only
        await translateAndSpeak(englishText);
      } else if (msg.type === "error") {
        console.error(`[stt:${myRole}] error:`, msg);
        safeSend(clientWs, { type: "error", stage: "stt", detail: msg });
      }
    });

    sttWs.on("close", (code, reason) =>
      console.log(`[stt:${myRole}] closed`, code, reason.toString())
    );
    sttWs.on("error", (err) => {
      console.error(`[stt:${myRole}] error:`, err.message);
      safeSend(clientWs, { type: "error", stage: "stt", detail: err.message });
    });
  }

  async function translateAndSpeak(englishText) {
    // Find the partner — translation goes to THEM not to the speaker
    const partnerWs = getPartner(roomCode, myRole);

    if (!partnerWs || partnerWs.readyState !== WebSocket.OPEN) {
      // No partner connected yet — notify speaker
      safeSend(clientWs, {
        type: "error",
        stage: "room",
        detail: "Waiting for the other person to join the room…"
      });
      return;
    }

    let outText = englishText;

    // Translate to partner's language
    if (targetLang !== "en-IN") {
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
            target_language_code: targetLang,
            model: "mayura:v1",
            mode: "modern-colloquial"   // natural spoken register, not written/formal Tamil
          })
        });
        if (!res.ok) throw new Error(`Translate ${res.status}: ${await res.text()}`);
        const data = await res.json();
        outText = data.translated_text || englishText;

        // Send translated caption to PARTNER
        safeSend(partnerWs, { type: "caption", lang: "translated", text: outText });
      } catch (err) {
        console.error("[translate] error:", err.message);
        safeSend(clientWs, { type: "error", stage: "translate", detail: err.message });
      }
    } else {
      // Target is English — send caption directly to partner
      safeSend(partnerWs, { type: "caption", lang: "translated", text: outText });
    }

    // Synthesize and send audio to PARTNER
    speakQueue = speakQueue.then(() => synthesizeAndSend(outText, partnerWs, targetLang));
  }

  async function synthesizeAndSend(text, targetWs, langCode) {
    try {
      const res = await fetch(TTS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-subscription-key": SARVAM_API_KEY
        },
        body: JSON.stringify({
          text,
          language_code: langCode,
          speaker: DEFAULT_SPEAKER,
          model: "bulbul:v3",
          pace: 1.0,
          output_audio_codec: "wav"
        })
      });
      if (!res.ok) throw new Error(`TTS ${res.status}: ${await res.text()}`);
      const data = await res.json();
      const audio = data.audios?.[0];
      if (!audio) throw new Error("TTS returned no audio");

      // Send audio to PARTNER's device
      safeSend(targetWs, { type: "audio", audio, mime: "audio/wav" });
    } catch (err) {
      console.error("[tts] error:", err.message);
      safeSend(clientWs, { type: "error", stage: "tts", detail: err.message });
    }
  }

  clientWs.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "start") {
      roomCode   = msg.roomCode || "default";
      myRole     = msg.role || "rep";       // "rep" or "client"
      sourceLang = msg.sourceLang || "en-IN";
      targetLang = msg.targetLang || "hi-IN";

      // Join the room
      const room = getRoom(roomCode);
      room[myRole] = clientWs;
      console.log(`[room:${roomCode}] ${myRole} joined`);

      // Notify partner that the other person joined
      const partnerWs = getPartner(roomCode, myRole);
      if (partnerWs?.readyState === WebSocket.OPEN) {
        safeSend(partnerWs, { type: "partner_joined", role: myRole });
        safeSend(clientWs,  { type: "partner_joined", role: myRole === "rep" ? "client" : "rep" });
      }

      openStt();
      safeSend(clientWs, { type: "ready" });
      return;
    }

    if (msg.type === "audio_chunk" && msg.audio) {
      if (sttWs?.readyState === WebSocket.OPEN) {
        sttWs.send(JSON.stringify({
          audio: { data: msg.audio, sample_rate: "16000", encoding: "audio/wav" }
        }));
      }
      return;
    }

    // ── NEW: relay "I'm speaking / I stopped speaking" to the partner ──────────
    // Lets the UI show "X is speaking — please wait" so people don't talk
    // over each other.
    if (msg.type === "speaking") {
      const partnerWs = getPartner(roomCode, myRole);
      safeSend(partnerWs, { type: "partner_speaking", speaking: !!msg.value });
      return;
    }

    // ── NEW: relay "translated audio is about to play on my device" back to
    // the ORIGINAL SPEAKER so their mic pauses too. Without this, when two
    // people are in the same room without earphones, the listener's device
    // plays audio out loud, the speaker's still-open mic picks it back up,
    // and it gets mis-transcribed as new speech (the "only works with
    // earphones" symptom).
    if (msg.type === "audio_playing") {
      const partnerWs = getPartner(roomCode, myRole);
      safeSend(partnerWs, { type: "mute_request", ms: msg.ms || 1500 });
      return;
    }

    if (msg.type === "stop") closeUpstream();
  });

  clientWs.on("close", () => {
    console.log(`[room:${roomCode}] ${myRole} disconnected`);
    // Notify partner that other person left
    const partnerWs = getPartner(roomCode, myRole);
    if (partnerWs?.readyState === WebSocket.OPEN) {
      safeSend(partnerWs, { type: "partner_left" });
    }
    closeUpstream();
    if (roomCode && myRole) cleanRoom(roomCode, myRole);
  });

  function closeUpstream() {
    try { sttWs?.close(); } catch {}
  }
});

function safeSend(ws, obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

server.listen(PORT, () =>
  console.log(`Translator running at http://localhost:${PORT}`)
);