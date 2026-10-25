// Listen and talk back, with the browser's own speech engines (no server, works offline on most phones).
// The words spoken are built by code from engine numbers, same as the screen.

const synth = window.speechSynthesis;
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export const canSpeak = Boolean(synth);
export const canListen = Boolean(Recognition);

let voice = null;
function pickVoice() {
  if (!synth) return null;
  const voices = synth.getVoices();
  const prefs = [/Ava|Samantha|Allison|Zoe/i, /Google US English/i, /Microsoft (Aria|Jenny|Guy).*Online/i, /en-US/i, /^en/i];
  for (const p of prefs) {
    const v = voices.find((x) => p.test(x.name) || p.test(x.lang));
    if (v) return v;
  }
  return voices[0] ?? null;
}
if (synth) {
  voice = pickVoice();
  synth.onvoiceschanged = () => (voice = pickVoice());
}

/** Speak parts one after another. onPart(i) fires as each starts; onEnd when all finish or stop. */
export function speak(parts, { onPart, onEnd } = {}) {
  if (!synth) {
    onEnd?.();
    return () => {};
  }
  synth.cancel();
  let stopped = false;
  let i = 0;
  const next = () => {
    if (stopped || i >= parts.length) {
      onEnd?.();
      return;
    }
    const u = new SpeechSynthesisUtterance(parts[i]);
    if (voice) u.voice = voice;
    u.rate = 1.02;
    u.pitch = 1;
    const idx = i;
    u.onstart = () => onPart?.(idx);
    u.onend = () => {
      i++;
      setTimeout(next, 260);
    };
    u.onerror = () => {
      i++;
      next();
    };
    synth.speak(u);
  };
  next();
  return () => {
    stopped = true;
    synth.cancel();
  };
}

/** Capture one spoken thought. Returns a stop function. */
export function listen({ onText, onEnd, onError }) {
  if (!Recognition) {
    onError?.("Voice input isn't available in this browser. Type it instead.");
    return () => {};
  }
  const r = new Recognition();
  r.lang = "en-US";
  r.interimResults = true;
  r.continuous = false;
  let finalText = "";
  r.onresult = (e) => {
    let interim = "";
    for (let k = e.resultIndex; k < e.results.length; k++) {
      const t = e.results[k][0].transcript;
      if (e.results[k].isFinal) finalText += t;
      else interim += t;
    }
    onText?.(finalText + interim, false);
  };
  r.onerror = (e) => onError?.(e.error === "not-allowed" ? "Allow microphone access to park a thought by voice." : "Didn't catch that. Try again.");
  r.onend = () => onEnd?.(finalText.trim());
  r.start();
  return () => r.stop();
}

/** "$41,800" → "about 42 thousand dollars" so the brief sounds natural. */
export function spokenMoney(cents) {
  const v = Math.abs(cents) / 100;
  const neg = cents < 0 ? "minus " : "";
  if (v >= 1e6) return `${neg}about ${(v / 1e6).toFixed(1).replace(/\.0$/, "")} million dollars`;
  if (v >= 1e4) return `${neg}about ${Math.round(v / 1e3)} thousand dollars`;
  if (v >= 1e3) return `${neg}about ${(v / 1e3).toFixed(1).replace(/\.0$/, "")} thousand dollars`;
  return `${neg}${Math.round(v)} dollars`;
}

/** Make on-screen text speakable: amounts in words, reference codes and parentheses dropped. */
export function speakable(text) {
  return text
    .replace(/−?\$[\d,]+/g, (m) => spokenMoney(Number(m.replace(/[^\d]/g, "")) * 100 * (m.startsWith("−") ? -1 : 1)))
    .replace(/\s*\([A-Z]+-[\dA-Z-]+\)/g, "")
    .replace(/\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/g, (m) => ({ Jan: "January", Feb: "February", Mar: "March", Apr: "April", Jun: "June", Jul: "July", Aug: "August", Sep: "September", Oct: "October", Nov: "November", Dec: "December" }[m]));
}
