// One bar for everything: questions get answers; anything else is a thought to park.
// A question has a "?", opens with a question word or auxiliary, or asks for a status.
const OPENER = /^(what|whats|what's|how|when|where|why|which|who|can|could|should|will|would|shall|do|does|did|is|are|am|was|were|if|whom|whose)(?![\p{L}\p{N}])|^(tell me|show me|status)(?![\p{L}\p{N}])/iu;

export function isQuestion(text) {
  const t = String(text ?? "").replace(/[’‘]/g, "'");
  if (t.includes("?")) return true;
  return OPENER.test(t.replace(/^[^\p{L}\p{N}]+/u, "").trim());
}
