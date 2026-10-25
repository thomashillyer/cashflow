// Shared shape for live connectors (Zoho Books, Outlook, ...). A connector only reads. It never runs
// the OAuth handshake: the API lane supplies a TokenProvider, so refresh tokens stay server-side and
// the same connector works with a token from .env in tests. Every failure is a ConnectorError with a
// plain-words next step and the no-setup fallback the owner can use instead (file export or paste).

export type TokenProvider = (source: string) => Promise<string>;

export type ConnectorError = {
  kind: "auth" | "rate_limit" | "network" | "config" | "unsupported";
  message: string;      // what happened, in plain words
  nextStep: string;     // what the owner can do now
  fallback: "file" | "paste";
};

export type PullResult<T> = { ok: true; data: T } | { ok: false; error: ConnectorError };

export class ConnectorFailure extends Error {
  constructor(readonly error: ConnectorError) {
    super(error.message);
  }
}

export type Fetch = (url: string, init: { method: "GET"; headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

// Plain-words error for a non-2xx answer, shared by connectors that talk to one provider.
export function httpFailure(provider: string, status: number, fallback: ConnectorError["fallback"]): ConnectorError {
  const alt = fallback === "paste" ? "paste the message instead" : "upload an export instead";
  if (status === 401) return { kind: "auth", message: `${provider} access has expired or was removed.`, nextStep: `Reconnect ${provider}, or ${alt}.`, fallback };
  if (status === 403) return { kind: "auth", message: `The ${provider} connection is not allowed to read this.`, nextStep: `Reconnect ${provider} and allow read access, or ${alt}.`, fallback };
  if (status === 429) return { kind: "rate_limit", message: `${provider} asked us to slow down.`, nextStep: `Wait a few minutes and import again, or ${alt}.`, fallback };
  return { kind: "network", message: `${provider} returned an error (${status}).`, nextStep: `Try again later, or ${alt}.`, fallback };
}
