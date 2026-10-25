// Serve app/ locally with no dependencies: `npm run app` (PORT=4300 by default).
// Point it at your API with http://localhost:4300/?api=http://localhost:8787 (localhost only),
// or set window.NERI_API_BASE in app/config.js.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../app/", import.meta.url)));
const port = Number(process.env.PORT ?? 4300);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    let file = normalize(join(root, path));
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    if ((await stat(file).catch(() => null))?.isDirectory()) file = join(file, "index.html");
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Neri Cash app: http://localhost:${port}`);
});
