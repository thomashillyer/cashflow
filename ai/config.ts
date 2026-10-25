// Claude layer settings, in one place (docs/design/08-claude-layer.md: "keep model IDs in one config file").

// Document classification and field extraction (ai/extract/document.ts).
export const EXTRACTION_MODEL = "claude-opus-5-5";

// Bump whenever ai/prompts/extract_document.md or the ExtractionOutput schema changes.
// It is part of the response-cache key, so a bump invalidates every cached extraction.
export const PROMPT_VERSION = "extract_document@1";
