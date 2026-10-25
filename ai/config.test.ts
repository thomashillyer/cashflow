import { afterEach, describe, expect, it } from "vitest";
import { anthropicOptions } from "./config";

describe("anthropicOptions", () => {
  const before = process.env.ANTHROPIC_WORKSPACE_ID;
  afterEach(() => {
    if (before === undefined) delete process.env.ANTHROPIC_WORKSPACE_ID;
    else process.env.ANTHROPIC_WORKSPACE_ID = before;
  });

  it("sends the workspace header only when ANTHROPIC_WORKSPACE_ID is set", () => {
    delete process.env.ANTHROPIC_WORKSPACE_ID;
    expect(anthropicOptions()).toEqual({});
    process.env.ANTHROPIC_WORKSPACE_ID = " wrkspc_123 ";
    expect(anthropicOptions()).toEqual({ defaultHeaders: { "anthropic-workspace-id": "wrkspc_123" } });
  });
});
