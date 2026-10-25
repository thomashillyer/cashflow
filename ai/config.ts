// Claude layer settings, in one place (docs/design/08-claude-layer.md: "keep model IDs in one config file").

// Document classification and field extraction (ai/extract/document.ts).
export const EXTRACTION_MODEL = "claude-opus-5-5";

// Bump whenever ai/prompts/extract_document.md or the ExtractionOutput schema changes.
// It is part of the response-cache key, so a bump invalidates every cached extraction.
export const PROMPT_VERSION = "extract_document@1";

// Brief writing and message drafting (ai/brief.ts). Larger tier per docs/design/08-claude-layer.md.
export const BRIEF_MODEL = "claude-opus-5-5";
export const DRAFT_MODEL = "claude-opus-5-5";

// Bump whenever ai/prompts/write_brief.md / draft_message.md or their output schemas change; part of the cache key.
export const BRIEF_PROMPT_VERSION = "write_brief@2";
export const DRAFT_PROMPT_VERSION = "draft_message@2";

// Bump whenever ai/prompts/extract_signal.md or the SignalExtraction schema changes (part of the cache key).
export const SIGNAL_PROMPT_VERSION = "extract_signal@1";

// Ask Neri intent reading (ai/ask/intent.ts). Reading a question is a small task, but it shares the one tier
// every other call here uses; change it here if a cheaper model reads questions as well.
export const INTENT_MODEL = "claude-opus-5-5";

// Bump whenever ai/prompts/read_intent.md or the AskIntentRaw schema in ai/ask/intent.ts changes (part of the cache key).
export const INTENT_PROMPT_VERSION = "read_intent@1";

// Ask Neri's CFO voice (ai/ask/voice.ts). Bump CFO_VOICE_PROMPT_VERSION whenever ai/prompts/cfo_voice.md or the
// CfoVoice output schema changes; it is part of the cache key.
export const CFO_VOICE_MODEL = "claude-opus-5-5";
export const CFO_VOICE_PROMPT_VERSION = "cfo_voice@2";

// Live ask calls on a cache miss; the cache lookup keeps the recorded model (INTENT_MODEL / CFO_VOICE_MODEL).
export const ASK_LIVE_MODEL = "claude-sonnet-5-5";

// Anthropic client options shared by every call. A user-level key (sk-ant-usr-...) is not scoped to a workspace,
// so the API requires the workspace in a header: set ANTHROPIC_WORKSPACE_ID (wrkspc_...) for those keys.
export function anthropicOptions(): { defaultHeaders?: Record<string, string> } {
  const workspace = process.env.ANTHROPIC_WORKSPACE_ID?.trim();
  return workspace ? { defaultHeaders: { "anthropic-workspace-id": workspace } } : {};
}
