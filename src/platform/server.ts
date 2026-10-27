// HTTP API for the platform (/api/v1) and its web console. Local machine only.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { PlatformError, ensure } from "./errors.js";
import { Platform } from "./engine.js";
import { Store } from "./storage/store.js";
import { RuleError } from "./rules/util.js";

export async function loadAdminToken(dataDir: string, env = process.env) {
  if (env.AIKP_ADMIN_TOKEN) return env.AIKP_ADMIN_TOKEN;
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, "admin-token.txt");
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
    const token = randomBytes(32).toString("hex");
    await writeFile(path, token, { mode: 0o600, flag: "wx" });
    return token;
  }
}

const MAX_BODY = 4 * 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<unknown> {
  ensure(req.headers["content-type"]?.split(";")[0] === "application/json", "INVALID_INPUT", "需要 application/json", 415);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    ensure(size <= MAX_BODY, "TOO_LARGE", "请求超过 4 MiB", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new PlatformError("INVALID_JSON", "JSON 无法解析");
  }
}

const STATIC: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/play": ["play.html", "text/html; charset=utf-8"],
  "/play.js": ["play.js", "text/javascript; charset=utf-8"],
};

export function platformServer(platform: Platform, adminToken: string, webDir = resolve("web/platform")): Server {
  const checkAdmin = (req: IncomingMessage) => {
    const given = req.headers["x-admin-token"];
    ensure(
      typeof given === "string" &&
        Buffer.byteLength(given) === Buffer.byteLength(adminToken) &&
        timingSafeEqual(Buffer.from(given), Buffer.from(adminToken)),
      "ADMIN_REQUIRED",
      "管理令牌无效",
      401,
    );
  };

  return createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    );
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    try {
      // Block DNS rebinding and cross-site requests: only same-origin calls to localhost.
      const host = req.headers.host ?? "";
      ensure(/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host), "FORBIDDEN", "仅允许本机访问", 403);
      ensure(!req.headers.origin || req.headers.origin === `http://${host}`, "FORBIDDEN", "不接受跨域请求", 403);
      ensure(req.headers["sec-fetch-site"] !== "cross-site", "FORBIDDEN", "不接受跨站请求", 403);

      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";

      if (!path.startsWith("/api/")) {
        const file = STATIC[path];
        ensure(file && method === "GET", "NOT_FOUND", "页面不存在", 404);
        const content = await readFile(join(webDir, file[0])).catch(() => {
          throw new PlatformError("NOT_FOUND", "页面文件缺失", 404);
        });
        res.writeHead(200, { "Content-Type": file[1] });
        res.end(content);
        return;
      }
      if (path === "/api/v1/health" && method === "GET") return send(200, { status: "ok" });

      // Player API: authenticated by the invite token, never by the admin token.
      if (path === "/api/v1/play" || path.startsWith("/api/v1/play/")) {
        const { campaignId, playerId } = platform.authPlayer(req.headers["x-player-token"]);
        const playRoute = `${method} ${path.slice("/api/v1/play".length) || "/"}`;
        switch (playRoute) {
          case "GET /":
            return send(200, platform.playerView(campaignId, playerId));
          case "POST /messages":
            return send(200, await platform.playerMessage(campaignId, playerId, await readBody(req)));
          case "PUT /sheet":
            platform.setOwnSheet(campaignId, playerId, await readBody(req));
            return send(200, { me: platform.playerView(campaignId, playerId).me });
          default:
            throw new PlatformError("NOT_FOUND", "接口不存在", 404);
        }
      }

      checkAdmin(req);

      const parts = path.split("/").filter(Boolean).slice(2); // after api/v1
      const [a, id, b, sub] = parts;
      const route = `${method} ${[a, id ? ":id" : "", b ?? "", sub ? ":sub" : ""].filter(Boolean).join("/")}`;

      switch (route) {
        case "GET systems":
          return send(200, { systems: platform.systems() });
        case "GET providers":
          return send(200, { providers: platform.providers() });
        case "POST providers/:id":
          return send(200, { provider: platform.configureProvider(id, await readBody(req)) });
        case "GET scenarios":
          return send(200, { scenarios: platform.store.listScenarios() });
        case "POST scenarios":
          return send(201, { scenario: platform.addScenario(await readBody(req)) });
        case "GET scenarios/:id":
          return send(200, { scenario: platform.scenarioSummary(id) });
        case "POST scenarios/:id/compile":
          return send(202, { scenario: platform.compileScenario(id, await readBody(req)) });
        case "GET campaigns":
          return send(200, { campaigns: platform.store.listCampaigns() });
        case "POST campaigns": {
          const campaign = platform.createCampaign(await readBody(req));
          // Invite tokens are shown once; only their hashes are stored.
          return send(201, { campaign, invites: platform.issueInvites(campaign.id) });
        }
        case "GET campaigns/:id":
          return send(200, platform.organizerView(id));
        case "GET campaigns/:id/public":
          return send(200, platform.publicView(id));
        case "GET campaigns/:id/kp":
          return send(200, platform.kpView(id));
        case "POST campaigns/:id/reveal":
          return send(200, platform.reveal(id, await readBody(req)));
        case "POST campaigns/:id/invites": {
          const b = (await readBody(req)) as { playerId?: unknown };
          return send(200, { invites: platform.issueInvites(id, typeof b?.playerId === "string" ? b.playerId : undefined) });
        }
        case "POST campaigns/:id/players":
          return send(201, { invite: platform.addPlayer(id, await readBody(req)) });
        case "PUT campaigns/:id/compression":
          return send(200, { compression: platform.setCompression(id, await readBody(req)) });
        case "PUT campaigns/:id/models":
          return send(200, { models: platform.setModels(id, await readBody(req)) });
        case "PUT campaigns/:id/characters/:sub":
          platform.setCharacter(id, decodeURIComponent(sub), await readBody(req));
          return send(200, { players: platform.organizerView(id).players });
        case "POST campaigns/:id/messages":
          return send(200, await platform.message(id, await readBody(req)));
        case "POST campaigns/:id/start":
          return send(200, await platform.start(id, await readBody(req)));
        case "POST campaigns/:id/compress":
          return send(200, await platform.compressNow(id));
        default:
          throw new PlatformError("NOT_FOUND", "接口不存在", 404);
      }
    } catch (error) {
      const e =
        error instanceof PlatformError
          ? error
          : error instanceof RuleError
            ? new PlatformError(error.code, error.message, 400)
            : (console.error(error), new PlatformError("INTERNAL_ERROR", "服务暂时无法完成请求", 500));
      send(e.status, { error: { code: e.code, message: e.message } });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = resolve(process.env.AIKP_DATA_DIR ?? "data");
  await mkdir(dataDir, { recursive: true });
  const store = new Store(join(dataDir, "platform.db"));
  const platform = new Platform(store);
  const { interruptedTurns } = platform.init();
  const token = await loadAdminToken(dataDir);
  const port = Number(process.env.PLATFORM_PORT ?? 3100);
  platformServer(platform, token).listen(port, "127.0.0.1", () => {
    console.log(`AI KP 平台：http://127.0.0.1:${port}`);
    console.log(`管理令牌：${join(dataDir, "admin-token.txt")}（或环境变量 AIKP_ADMIN_TOKEN）`);
    if (interruptedTurns) console.log(`已将 ${interruptedTurns} 个被中断的回合标记为失败`);
  });
}
