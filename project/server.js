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

// Fallback voices if the rep never picks one (shouldn't normally happen —
// the rep screen always sends a choice — but keep sane defaults just in case).
const DEFAULT_REP_VOICE    = "shubh"; // male
const DEFAULT_CLIENT_VOICE = "priya"; // female

const MEETING_EXPIRY_HOURS = 1; // Meeting expires after 1 hour
const WARNING_MINUTES = 5; // Warning 5 minutes before expiry

const app = express();
app.use(express.static("public"));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/session" });

// ── rooms ─────────────────────────────────────────────────────────────────────
// rooms = {
//   "roomCode": {
//     rep: wsClient,
//     client: wsClient,
//     clientName: null,       // Store client name
//     repVoice: "shubh",      // TTS voice used for REP's translated speech (client hears this)
//     clientVoice: "priya",   // TTS voice used for CLIENT's translated speech (rep hears this)
//     createdAt: timestamp,
//     expiryWarned: false
//   }
// }
const rooms = {};

function getRoom(code) {
  if (!rooms[code]) {
    rooms[code] = {
      rep: null,
      client: null,
      clientName: null,
      repVoice: DEFAULT_REP_VOICE,
      clientVoice: DEFAULT_CLIENT_VOICE,
      createdAt: Date.now(),
      expiryWarned: false
    };
  }
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

// ── Meeting expiry check ─────────────────────────────────────────────────────
function isMeetingExpired(roomCode) {
  const room = rooms[roomCode];
  if (!room) return true;

  const now = Date.now();
  const expiryTime = room.createdAt + (MEETING_EXPIRY_HOURS * 60 * 60 * 1000);
  return now > expiryTime;
}

function getTimeUntilExpiry(roomCode) {
  const room = rooms[roomCode];
  if (!room) return 0;

  const now = Date.now();
  const expiryTime = room.createdAt + (MEETING_EXPIRY_HOURS * 60 * 60 * 1000);
  return Math.max(0, expiryTime - now);
}

function getISTTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  });
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
  let expiryInterval = null;

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

    // Check if meeting expired
    if (isMeetingExpired(roomCode)) {
      safeSend(clientWs, {
        type: "error",
        stage: "room",
        detail: "This meeting has expired. Please ask the sales representative to generate a new link."
      });
      // Also notify partner
      safeSend(partnerWs, {
        type: "error",
        stage: "room",
        detail: "This meeting has expired. Please generate a new link."
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
            model: "sarvam-translate:v1"
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

    // Which voice speaks this? The voice a LISTENER hears is tied to who is
    // speaking, not who is listening: rep's words are read out in "repVoice",
    // client's words are read out in "clientVoice" — both configured by the rep.
    const room = rooms[roomCode];
    const speaker = myRole === "rep"
      ? (room?.repVoice || DEFAULT_REP_VOICE)
      : (room?.clientVoice || DEFAULT_CLIENT_VOICE);

    // Synthesize and send audio to PARTNER
    speakQueue = speakQueue.then(() => synthesizeAndSend(outText, partnerWs, targetLang, speaker));
  }

  async function synthesizeAndSend(text, targetWs, langCode, speaker) {
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
          speaker: speaker || DEFAULT_CLIENT_VOICE,
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

  // ── Meeting expiry monitoring ──────────────────────────────────────────────
  function startExpiryMonitoring() {
    // Clear any existing interval
    if (expiryInterval) {
      clearInterval(expiryInterval);
      expiryInterval = null;
    }

    // Check every minute
    expiryInterval = setInterval(() => {
      if (!roomCode || !rooms[roomCode]) {
        clearInterval(expiryInterval);
        expiryInterval = null;
        return;
      }

      const room = rooms[roomCode];
      const timeUntilExpiry = getTimeUntilExpiry(roomCode);

      // Check if meeting expired
      if (timeUntilExpiry <= 0) {
        // Meeting expired - notify both parties
        const expiryMsg = {
          type: "meeting_expired",
          message: "This meeting has expired. Please ask the sales representative to generate a new link.",
          time: getISTTime(Date.now())
        };

        safeSend(clientWs, expiryMsg);

        // Also notify partner if connected
        const partnerWs = getPartner(roomCode, myRole);
        if (partnerWs) {
          safeSend(partnerWs, expiryMsg);
        }

        // Close STT connection
        closeUpstream();

        // Clear interval
        clearInterval(expiryInterval);
        expiryInterval = null;
        return;
      }

      // Check if we should send warning (5 minutes before expiry)
      const minutesUntilExpiry = timeUntilExpiry / (60 * 1000);
      if (minutesUntilExpiry <= WARNING_MINUTES && !room.expiryWarned) {
        // Mark as warned to avoid multiple warnings
        room.expiryWarned = true;

        const warningMsg = {
          type: "meeting_expiring",
          message: `⚠️ This meeting link will expire in ${Math.ceil(minutesUntilExpiry)} minutes. Please generate a new link if you need more time.`,
          time: getISTTime(Date.now()),
          minutesRemaining: Math.ceil(minutesUntilExpiry)
        };

        // Only send warning to rep
        if (myRole === "rep") {
          safeSend(clientWs, warningMsg);
          console.log(`[room:${roomCode}] Warning sent to rep: meeting expires in ${Math.ceil(minutesUntilExpiry)} minutes`);
        }
      }
    }, 60000); // Check every minute
  }

  clientWs.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "start") {
      roomCode   = msg.roomCode || "default";
      myRole     = msg.role || "rep";       // "rep" or "client"
      sourceLang = msg.sourceLang || "en-IN";
      targetLang = msg.targetLang || "hi-IN";

      // Check if room exists and if it's expired
      const room = getRoom(roomCode);

      // If room is expired, don't allow joining
      if (isMeetingExpired(roomCode)) {
        safeSend(clientWs, {
          type: "error",
          stage: "room",
          detail: "This meeting link has expired. Please ask the sales representative to generate a new link.",
          expired: true
        });
        console.log(`[room:${roomCode}] Join attempt to expired meeting by ${myRole}`);
        return;
      }

      // Store client name if provided
      if (myRole === "client" && msg.clientName) {
        room.clientName = msg.clientName;
        console.log(`[room:${roomCode}] Client name: ${msg.clientName}`);
      }

      // Only the REP can set voice choices — client never sends these.
      if (myRole === "rep") {
        if (msg.repVoice)    room.repVoice    = msg.repVoice;
        if (msg.clientVoice) room.clientVoice = msg.clientVoice;
        console.log(`[room:${roomCode}] Voices set — rep: ${room.repVoice}, client: ${room.clientVoice}`);
      }

      // Join the room
      room[myRole] = clientWs;
      console.log(`[room:${roomCode}] ${myRole} joined at ${getISTTime(Date.now())}`);

      // Notify partner that the other person joined
      const partnerWs = getPartner(roomCode, myRole);
      if (partnerWs?.readyState === WebSocket.OPEN) {
        // Include client name in partner_joined message if available
        const joinMsg = {
          type: "partner_joined",
          role: myRole
        };
        // If the joining user is client, send their name to rep
        if (myRole === "client" && room.clientName) {
          joinMsg.clientName = room.clientName;
        }
        safeSend(partnerWs, joinMsg);
        safeSend(clientWs,  { type: "partner_joined", role: myRole === "rep" ? "client" : "rep" });
      }

      // Send meeting info to rep (creation time and expiry)
      if (myRole === "rep") {
        const expiryTime = room.createdAt + (MEETING_EXPIRY_HOURS * 60 * 60 * 1000);
        safeSend(clientWs, {
          type: "meeting_info",
          createdAt: getISTTime(room.createdAt),
          expiresAt: getISTTime(expiryTime),
          expiryMinutes: MEETING_EXPIRY_HOURS * 60
        });

        // Start expiry monitoring for this room
        startExpiryMonitoring();
      }

      openStt();
      safeSend(clientWs, { type: "ready" });
      return;
    }

    if (msg.type === "audio_chunk" && msg.audio) {
      if (sttWs?.readyState === WebSocket.OPEN) {
        // Check if meeting expired before processing audio
        if (isMeetingExpired(roomCode)) {
          safeSend(clientWs, {
            type: "error",
            stage: "room",
            detail: "This meeting has expired. Please ask the sales representative to generate a new link."
          });
          return;
        }
        sttWs.send(JSON.stringify({
          audio: { data: msg.audio, sample_rate: "16000", encoding: "audio/wav" }
        }));
      }
      return;
    }

    if (msg.type === "speaking") {
      const partnerWs = getPartner(roomCode, myRole);
      safeSend(partnerWs, { type: "partner_speaking", speaking: !!msg.value });
      return;
    }

    if (msg.type === "audio_playing") {
      const partnerWs = getPartner(roomCode, myRole);
      safeSend(partnerWs, { type: "mute_request", ms: msg.ms || 1500 });
      return;
    }

    if (msg.type === "stop") closeUpstream();
  });

  clientWs.on("close", () => {
    console.log(`[room:${roomCode}] ${myRole} disconnected at ${getISTTime(Date.now())}`);

    // Notify partner that other person left.
    // If the REP disconnects, the meeting is effectively over for the
    // client — tell them explicitly so they see a proper "meeting ended"
    // screen instead of just a generic "partner left" status.
    const partnerWs = getPartner(roomCode, myRole);
    if (partnerWs?.readyState === WebSocket.OPEN) {
      if (myRole === "rep") {
        safeSend(partnerWs, { type: "meeting_ended", reason: "host_left" });
      } else {
        safeSend(partnerWs, { type: "partner_left" });
      }
    }

    closeUpstream();

    // Clean up interval
    if (expiryInterval) {
      clearInterval(expiryInterval);
      expiryInterval = null;
    }

    if (roomCode && myRole) cleanRoom(roomCode, myRole);
  });

  function closeUpstream() {
    try { sttWs?.close(); } catch {}
    if (expiryInterval) {
      clearInterval(expiryInterval);
      expiryInterval = null;
    }
  }
});

function safeSend(ws, obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

server.listen(PORT, () =>
  console.log(`Translator running at http://localhost:${PORT}`)
);