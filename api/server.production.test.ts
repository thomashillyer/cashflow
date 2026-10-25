import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const args = ["--import", "tsx", "api/server.ts"];
function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  // The subprocess never loads .env or inherits connector credentials.
  return { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ...extra };
}

describe("server startup does not silently become a fixture demo", () => {
  it("fails closed with missing durable storage or auth configuration", () => {
    const result = spawnSync(process.execPath, args, { cwd: root, env: env({ NODE_ENV: "production" }), encoding: "utf8", timeout: 5000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Missing server configuration: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY");
    expect(result.stdout).not.toContain("Server listening");
  });

  it.each([{ NERI_STORE: "memory" }, { DEMO_MODE: "1" }])("rejects production fixture modes %j", (mode) => {
    const result = spawnSync(process.execPath, args, { cwd: root, env: env({ NODE_ENV: "production", ...mode }), encoding: "utf8", timeout: 5000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Production requires private Supabase storage");
  });

  it("still supports an explicitly requested local memory demo", async () => {
    const child = spawn(process.execPath, args, { cwd: root, env: env({ NODE_ENV: "development", NERI_STORE: "memory", DEMO_MODE: "1", HOST: "127.0.0.1", PORT: "0" }), stdio: ["ignore", "pipe", "pipe"] });
    try {
      const origin = await new Promise<string>((resolve, reject) => {
        let output = "";
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`Local demo exited before listening (${code}).`)));
        child.stdout.on("data", (chunk) => {
          output += String(chunk);
          const match = /Server listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
          if (match) resolve(match[1]!);
        });
      });
      const health = await (await fetch(`${origin}/health`)).json();
      expect(health).toMatchObject({ ok: true, demoMode: true });
      const context = await (await fetch(`${origin}/context`)).json();
      expect(context.business).toMatchObject({ synthetic: true, id: "cascade_trade" });
    } finally {
      child.kill("SIGTERM");
    }
  }, 10000);
});
