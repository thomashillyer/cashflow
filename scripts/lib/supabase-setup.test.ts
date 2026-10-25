import { describe, expect, it } from "vitest";
import {
  buildEnvValues,
  mergeEnv,
  parseApiKeysOutput,
  parseArgs,
  parseEnv,
  pickKeys,
  validateEnv,
} from "./supabase-setup.mjs";

const REF = "iiqzllefkoyjisqnwpyh";
const vals = { projectRef: REF, anonKey: "anon-key", serviceRoleKey: "svc-key" };

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.c2lnbmF0dXJl`;
}

describe("parseApiKeysOutput", () => {
  it("skips a leading non-JSON line", () => {
    const out = 'Selected project\n[{"name":"anon","api_key":"a"}]\n';
    expect(parseApiKeysOutput(out)).toEqual([{ name: "anon", api_key: "a" }]);
  });
  it("throws without JSON", () => {
    expect(() => parseApiKeysOutput("nope")).toThrow();
  });
});

describe("pickKeys", () => {
  it("picks by name", () => {
    const k = pickKeys([
      { name: "service_role", api_key: "s" },
      { name: "anon", api_key: "a" },
    ]);
    expect(k).toEqual({ anon: "a", serviceRole: "s" });
  });
  it("falls back to type", () => {
    const k = pickKeys([
      { name: "default", type: "publishable", api_key: "p" },
      { name: "default", type: "secret", api_key: "s" },
    ]);
    expect(k).toEqual({ anon: "p", serviceRole: "s" });
  });
  it("returns undefined when missing", () => {
    expect(pickKeys([])).toEqual({ anon: undefined, serviceRole: undefined });
  });
});

describe("buildEnvValues + mergeEnv", () => {
  it("omits the service role key without the flag", () => {
    const v = buildEnvValues({ ...vals, withServiceRole: false });
    expect(Object.keys(v)).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    const { text } = mergeEnv("", v);
    expect(text).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(text).toContain(`SUPABASE_URL=https://${REF}.supabase.co`);
  });
  it("includes the service role key with the flag", () => {
    const { text } = mergeEnv("", buildEnvValues({ ...vals, withServiceRole: true }));
    expect(text).toContain("SUPABASE_SERVICE_ROLE_KEY=svc-key");
  });
  it("preserves other lines and fills empty values", () => {
    const existing = "# note\nANTHROPIC_API_KEY=sk-x\nSUPABASE_URL=\nSUPABASE_DB_PASSWORD=pw\n";
    const { text, set } = mergeEnv(existing, buildEnvValues({ ...vals, withServiceRole: false }));
    expect(text.split("\n")).toEqual(
      expect.arrayContaining(["# note", "ANTHROPIC_API_KEY=sk-x", "SUPABASE_DB_PASSWORD=pw", "SUPABASE_ANON_KEY=anon-key"]),
    );
    expect(text).toContain(`SUPABASE_URL=https://${REF}.supabase.co`);
    expect(set.find((s) => s.name === "SUPABASE_ANON_KEY")?.length).toBe("anon-key".length);
  });
  it("does not overwrite non-empty values without force", () => {
    const r = mergeEnv("SUPABASE_ANON_KEY=old\n", buildEnvValues({ ...vals, withServiceRole: false }));
    expect(r.text).toContain("SUPABASE_ANON_KEY=old");
    expect(r.text).not.toContain("anon-key");
    expect(r.kept).toEqual(["SUPABASE_ANON_KEY"]);
  });
  it("overwrites with force", () => {
    const r = mergeEnv("SUPABASE_ANON_KEY=old\n", buildEnvValues({ ...vals, withServiceRole: false }), { force: true });
    expect(r.text).toContain("SUPABASE_ANON_KEY=anon-key");
    expect(r.text).not.toContain("old");
    expect(r.kept).toEqual([]);
  });
});

describe("validateEnv", () => {
  const good = {
    SUPABASE_URL: `https://${REF}.supabase.co`,
    SUPABASE_ANON_KEY: jwt({ role: "anon", ref: REF }),
    SUPABASE_SERVICE_ROLE_KEY: jwt({ role: "service_role", ref: REF }),
  };
  it("accepts a correct env and reports lengths only", () => {
    const r = validateEnv(good);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.lengths.SUPABASE_ANON_KEY).toBe(good.SUPABASE_ANON_KEY.length);
  });
  it("flags missing values", () => {
    const r = validateEnv({});
    expect(r.errors).toHaveLength(2);
  });
  it("warns on a missing service role key unless required", () => {
    const { SUPABASE_SERVICE_ROLE_KEY: _omit, ...rest } = good;
    expect(validateEnv(rest).errors).toEqual([]);
    expect(validateEnv(rest).warnings).toHaveLength(1);
    expect(validateEnv(rest, { requireServiceRole: true }).errors).toHaveLength(1);
  });
  it("detects swapped keys without echoing them", () => {
    const r = validateEnv({ ...good, SUPABASE_ANON_KEY: good.SUPABASE_SERVICE_ROLE_KEY });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).not.toContain(good.SUPABASE_SERVICE_ROLE_KEY);
  });
  it("detects a bad URL, garbage keys and project mismatch", () => {
    expect(validateEnv({ ...good, SUPABASE_URL: "https://example.com" }).errors).toHaveLength(1);
    expect(validateEnv({ ...good, SUPABASE_ANON_KEY: "not-a-key" }).errors).toHaveLength(1);
    expect(validateEnv({ ...good, SUPABASE_ANON_KEY: jwt({ role: "anon", ref: "otherprojectref12345" }) }).errors).toHaveLength(1);
    expect(validateEnv(good, { projectRef: "otherprojectref12345" }).errors).toHaveLength(1);
  });
  it("rejects masked new-style keys", () => {
    const r = validateEnv({ ...good, SUPABASE_SERVICE_ROLE_KEY: "sb_secret_ab••••••" });
    expect(r.errors).toHaveLength(1);
  });
  it("ignores unquoted inline comments in .env", () => {
    const env = parseEnv(`SUPABASE_URL=https://${REF}.supabase.co # team\nSUPABASE_ANON_KEY="a # b"\n`);
    expect(env.SUPABASE_URL).toBe(`https://${REF}.supabase.co`);
    expect(env.SUPABASE_ANON_KEY).toBe("a # b");
  });
  it("updates every duplicate line when merging with force", () => {
    const r = mergeEnv("SUPABASE_ANON_KEY=a\nSUPABASE_ANON_KEY=b\n", { SUPABASE_ANON_KEY: "new" }, { force: true });
    expect(r.text).toBe("SUPABASE_ANON_KEY=new\nSUPABASE_ANON_KEY=new\n");
  });
  it("accepts new-style keys and local URLs", () => {
    const r = validateEnv({
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_ANON_KEY: "sb_publishable_abc",
      SUPABASE_SERVICE_ROLE_KEY: "sb_secret_abc",
    });
    expect(r.errors).toEqual([]);
  });
});

describe("parseArgs", () => {
  it("defaults, env override, flag override", () => {
    expect(parseArgs([]).projectRef).toBeUndefined();
    expect(parseArgs([], { SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst" }).projectRef).toBe("abcdefghijklmnopqrst");
    const o = parseArgs(["--from-cli", "--project-ref=abcdefghijklmnopqrst", "--with-service-role", "--force"], {});
    expect(o).toMatchObject({ fromCli: true, projectRef: "abcdefghijklmnopqrst", withServiceRole: true, force: true });
  });
  it("rejects bad refs and unknown args", () => {
    expect(() => parseArgs(["--project-ref", "x; rm"])).toThrow();
    expect(() => parseArgs(["--nope"])).toThrow();
  });
});
