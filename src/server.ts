import { createServer, type IncomingMessage } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { HostService } from "./host.js";
import { GameService } from "./game.js";
import {
  FileStore,
  Fault,
  requireThat,
  validatePackage,
  extensionStatus,
  object,
} from "./foundation.js";
export async function adminToken(data: string) {
  if (process.env.AIKP_ADMIN_TOKEN) return process.env.AIKP_ADMIN_TOKEN;
  await mkdir(data, { recursive: true });
  const path = join(data, "admin-token.txt");
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
    const t = randomBytes(32).toString("hex");
    await writeFile(path, t, { mode: 0o600, flag: "wx" });
    return t;
  }
}
async function rawBody(req: IncomingMessage) {
  requireThat(
    req.headers["content-type"]?.split(";")[0] === "application/json",
    "INVALID_INPUT",
    "需要 application/json",
    415,
  );
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    requireThat(size <= 1024 * 1024, "TOO_LARGE", "请求超过 1 MiB", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function body(req: IncomingMessage) {
  const raw = await rawBody(req);
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Fault("INVALID_JSON", "JSON 无法解析");
  }
}
export function httpServer(
  game: GameService,
  admin: string,
  web = resolve("web"),
  hostService?: HostService,
) {
  const checkAdmin = (req: IncomingMessage) => {
    const given = req.headers["x-admin-token"];
    requireThat(
      typeof given === "string" &&
        Buffer.byteLength(given) === Buffer.byteLength(admin) &&
        timingSafeEqual(Buffer.from(given), Buffer.from(admin)),
      "ADMIN_REQUIRED",
      "管理令牌无效",
      401,
    );
  };
  const bearer = (req: IncomingMessage) => {
    const h = req.headers.authorization;
    requireThat(h?.startsWith("Bearer "), "AUTH_REQUIRED", "需要会话令牌", 401);
    return h!.slice(7);
  };
  const providerInfo = () =>
    [...game.models.values()].map((p) => ({
      id: p.id,
      name: p.id === "mock" ? "模拟 KP" : p.id,
      ready: p.ready,
      status:
        p.id === "mock"
          ? "simulated"
          : p.ready
            ? "configured-unverified"
            : "missing-credentials",
      model: "model" in p ? p.model : null,
      configurationNames:
        p.id === "mock"
          ? []
          : ["API_KEY", "MODEL", "BASE_URL", "TIMEOUT_MS", "MAX_OUTPUT"].map(
              (n) => p.id.toUpperCase() + "_" + n,
            ),
      protocol:
        p.id === "openai"
          ? "responses"
          : p.id === "anthropic"
            ? "messages"
            : p.id === "gemini"
              ? "interactions"
              : "mock",
      timeoutMs: "timeoutMs" in p ? p.timeoutMs : null,
      maxOutput: "options" in p ? (p.options as any).maxOutput : null,
    }));
  return createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    );
    try {
      const host = req.headers.host ?? "";
      requireThat(
        /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host),
        "FORBIDDEN",
        "仅允许本机请求",
        403,
      );
      requireThat(
        !req.headers.origin || req.headers.origin === `http://${host}`,
        "FORBIDDEN",
        "不接受跨域请求",
        403,
      );
      requireThat(
        req.headers["sec-fetch-site"] !== "cross-site",
        "FORBIDDEN",
        "不接受跨站请求",
        403,
      );
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;
      let result: any;
      let status = 200;
      if (path.startsWith("/api/host")) {
        requireThat(hostService, "HOST_UNAVAILABLE", "自由主持服务未启动", 503);
        const host = hostService;
        if (path === "/api/host/qq/events" && req.method === "POST") {
          const raw = await rawBody(req);
          host.verifyCallback(raw, req.headers);
          let event;
          try {
            event = JSON.parse(raw.toString("utf8"));
          } catch {
            throw new Fault("INVALID_JSON", "JSON无法解析");
          }
          result = await host.acceptEvent(event);
        } else {
          checkAdmin(req);
          if (path === "/api/host/config" && req.method === "GET")
            result = host.config();
          else if (path === "/api/host/config" && req.method === "POST")
            result = await host.configure(await body(req));
          else if (path === "/api/host/test" && req.method === "POST")
            result = await host.testProvider(await body(req));
          else if (path === "/api/host/materials" && req.method === "GET")
            result = { materials: host.materials() };
          else if (path === "/api/host/materials" && req.method === "POST") {
            result = await host.addMaterial(await body(req));
            status = 201;
          } else if (path === "/api/host/rooms" && req.method === "POST") {
            result = await host.create(await body(req));
            status = 201;
          } else if (path === "/api/host/rooms" && req.method === "GET")
            result = {
              rooms: host.state.rooms.map((r) => ({
                id: r.id,
                name: r.name,
                provider: r.provider,
                usingBuiltin: r.usingBuiltin,
                updatedAt: r.updatedAt,
              })),
            };
          else if (path === "/api/host/qq/simulate" && req.method === "POST")
            result = await host.simulate(await body(req));
          else {
            const match =
              /^\/api\/host\/rooms\/([a-f0-9-]{36})(?:\/(messages|start|qq))?$/.exec(
                path,
              );
            requireThat(match, "NOT_FOUND", "接口不存在", 404);
            const [, id, sub] = match;
            if (req.method === "GET" && !sub)
              result = { room: host.view(host.room(id)) };
            else if (
              req.method === "POST" &&
              (sub === "messages" || sub === "start")
            )
              result = await host.message(id, await body(req), sub === "start");
            else if (req.method === "POST" && sub === "qq")
              result = await host.bind(id, await body(req));
            else throw new Fault("NOT_FOUND", "接口不存在", 404);
          }
        }
      } else if (req.method === "GET" && path === "/api/health")
        result = { status: "ok", version: "0.3.0-half" };
      else if (req.method === "GET" && path === "/api/catalog")
        result = {
          ...game.catalog(),
          providers: providerInfo(),
          extensions: extensionStatus,
        };
      else if (req.method === "GET" && path === "/api/config") {
        checkAdmin(req);
        result = {
          providers: providerInfo(),
          qq: { status: "simulated-only" },
          extensions: extensionStatus,
        };
      } else if (req.method === "POST" && path === "/api/sessions") {
        checkAdmin(req);
        result = await game.create(await body(req));
        status = 201;
      } else if (req.method === "POST" && path === "/api/sessions/restore") {
        checkAdmin(req);
        const b = await body(req);
        requireThat(object(b) && Object.keys(b).length === 1 && "save" in b);
        result = await game.restore(b.save);
        status = 201;
      } else if (
        req.method === "POST" &&
        ["/api/packages/validate", "/api/packages/import"].includes(path)
      ) {
        checkAdmin(req);
        const p = validatePackage(await body(req));
        result = path.endsWith("/validate")
          ? {
              valid: true,
              package: {
                id: p.id,
                version: p.version,
                kind: p.kind,
                name: p.name,
              },
            }
          : { package: await game.importPackage(p) };
        if (path.endsWith("/import")) status = 201;
      } else if (req.method === "POST" && path === "/api/qq/bind") {
        const b = await body(req);
        requireThat(object(b));
        result = await game.bind(b.sessionId, bearer(req), b);
      } else if (req.method === "POST" && path === "/api/qq/simulate") {
        checkAdmin(req);
        result = await game.qq(await body(req));
      } else if (path.startsWith("/api/sessions/")) {
        const m = path.match(
          /^\/api\/sessions\/([a-f0-9-]{36})(?:\/(join|events|actions|control|export))?$/,
        );
        requireThat(m, "NOT_FOUND", "接口不存在", 404);
        const [, id, sub] = m;
        if (sub === "join" && req.method === "POST") {
          result = await game.join(id, await body(req));
          status = 201;
        } else {
          const t = bearer(req);
          const s = game.get(id);
          const identity = game.identity(s, t);
          if (req.method === "GET" && !sub)
            result = { session: game.view(s, identity) };
          else if (req.method === "GET" && sub === "events")
            result = {
              events: game.view(s, identity).events,
              version: s.version,
            };
          else if (req.method === "GET" && sub === "export") {
            requireThat(
              identity.role === "owner",
              "OWNER_REQUIRED",
              "仅房主可导出秘密存档",
              403,
            );
            result = { save: game.exportSave(s) };
          } else if (
            req.method === "POST" &&
            (sub === "actions" || sub === "control")
          )
            result = await game.mutate(
              id,
              t,
              await body(req),
              sub === "control",
            );
          else throw new Fault("NOT_FOUND", "接口不存在", 404);
        }
      } else if (!path.startsWith("/api/") && req.method === "GET") {
        const names: Record<string, string> = {
          "/": "host.html",
          "/host.html": "host.html",
          "/host.js": "host.js",
          "/host.css": "host.css",
          "/legacy": "index.html",
          "/index.html": "index.html",
          "/app.js": "app.js",
          "/styles.css": "styles.css",
          "/style.css": "style.css",
        };
        const name = names[path];
        requireThat(name, "NOT_FOUND", "页面不存在", 404);
        let content: Buffer;
        try {
          content = await readFile(join(web, name));
        } catch {
          throw new Fault("NOT_FOUND", "页面尚未安装", 404);
        }
        res.writeHead(200, {
          "Content-Type": (
            {
              ".html": "text/html; charset=utf-8",
              ".js": "text/javascript; charset=utf-8",
              ".css": "text/css; charset=utf-8",
            } as any
          )[extname(name)],
        });
        res.end(content);
        return;
      } else throw new Fault("NOT_FOUND", "接口不存在", 404);
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(result));
    } catch (error) {
      const e =
        error instanceof Fault
          ? error
          : new Fault("INTERNAL_ERROR", "服务暂时无法完成请求", 500);
      res.writeHead(e.status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify({ error: { code: e.code, message: e.message } }));
    }
  });
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const data = resolve(process.env.AIKP_DATA_DIR ?? "data");
  const game = new GameService(new FileStore(data));
  await game.init();
  const hostService = new HostService(join(data, "free-host"));
  await hostService.init();
  const admin = await adminToken(data);
  const port = Number(process.env.PORT ?? 3000);
  httpServer(game, admin, resolve("web"), hostService).listen(
    port,
    "127.0.0.1",
    () =>
      console.log(
        `AI KP: http://127.0.0.1:${port} · 管理令牌见 ${join(data, "admin-token.txt")}（或 AIKP_ADMIN_TOKEN）`,
      ),
  );
}
