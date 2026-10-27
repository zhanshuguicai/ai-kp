import { validateStory } from "./story.js";
import { randomInt } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { GamePackage } from "./contracts.js";
export class Fault extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function requireThat(
  ok: unknown,
  code = "INVALID_INPUT",
  message = "输入格式无效",
  status = 400,
): asserts ok {
  if (!ok) throw new Fault(code, message, status);
}
export function object(x: unknown): x is Record<string, any> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}
export function str(x: unknown, max = 2000): x is string {
  return typeof x === "string" && x.length > 0 && x.length <= max;
}
export function exact(x: Record<string, any>, keys: string[]) {
  requireThat(Object.keys(x).every((k) => keys.includes(k)));
}
export function validatePackage(x: unknown): GamePackage {
  try {
    return validatePackageInternal(x);
  } catch (e) {
    if (e instanceof Fault) throw new Fault("INVALID_PACKAGE", e.message);
    throw new Fault("INVALID_PACKAGE", "包定义或引用无效");
  }
}
function validatePackageInternal(x: unknown): GamePackage {
  requireThat(object(x), "INVALID_PACKAGE", "包必须为 JSON 对象");
  const p = x as any;
  requireThat(
    ["rules", "scenario"].includes(p.kind) &&
      str(p.id, 60) &&
      str(p.version, 30) &&
      /^[a-z0-9-]{1,60}$/.test(p.id) &&
      /^\d+\.\d+\.\d+$/.test(p.version) &&
      str(p.name, 100) &&
      str(p.description),
    "INVALID_PACKAGE",
    "包标识、版本或说明无效",
  );
  const arr = (a: any) =>
    Array.isArray(a) && a.length <= 100 && a.every((v: any) => str(v, 4000));
  if (p.kind === "rules") {
    requireThat(
      p.engine === "simple-d20-v1" &&
        arr(p.supported) &&
        arr(p.unsupported) &&
        object(p.parameters),
      "INVALID_PACKAGE",
      "不支持此规则执行器",
    );
    const a = p.parameters;
    requireThat(
      Number.isInteger(a.defaultDc) &&
        a.defaultDc >= 5 &&
        a.defaultDc <= 25 &&
        Number.isInteger(a.maxStamina) &&
        a.maxStamina >= 1 &&
        a.maxStamina <= 30 &&
        Number.isInteger(a.damageSides) &&
        a.damageSides >= 2 &&
        a.damageSides <= 20 &&
        Number.isInteger(a.damageBonus) &&
        a.damageBonus >= 0 &&
        a.damageBonus <= 10,
      "INVALID_PACKAGE",
      "执行参数无效",
    );
    exact(a, ["defaultDc", "maxStamina", "damageSides", "damageBonus"]);
    exact(p, [
      "kind",
      "id",
      "version",
      "name",
      "description",
      "engine",
      "parameters",
      "supported",
      "unsupported",
    ]);
  } else {
    requireThat(
      str(p.startLocation, 200) &&
        str(p.opening, 4000) &&
        arr(p.secrets) &&
        arr(p.personalSecrets) &&
        Array.isArray(p.scenes) &&
        p.scenes.length >= 1 &&
        p.scenes.length <= 30,
      "INVALID_PACKAGE",
      "剧本内容无效",
    );
    requireThat(
      p.scenes.every((s: any) => object(s)) && str(p.startSceneId, 60),
      "INVALID_PACKAGE",
      "场景标识无效",
    );
    const ids = new Set(p.scenes.map((s: any) => s.id));
    requireThat(
      ids.size === p.scenes.length && ids.has(p.startSceneId),
      "INVALID_PACKAGE",
      "场景引用无效",
    );
    for (const s of p.scenes) {
      requireThat(
        object(s) &&
          str(s.id, 60) &&
          /^[a-z0-9-]{1,60}$/.test(s.id) &&
          str(s.name, 100) &&
          str(s.description, 4000) &&
          Array.isArray(s.links) &&
          s.links.every((v: any) => ids.has(v)) &&
          Array.isArray(s.npcs) &&
          s.npcs.every(
            (n: any) =>
              object(n) && str(n.name, 100) && str(n.description, 1000),
          ) &&
          s.entryCondition?.type === "always" &&
          (s.revealCondition === null ||
            (s.revealCondition?.type === "planned" &&
              str(s.revealCondition.description))),
        "INVALID_PACKAGE",
        "场景结构无效",
      );
      exact(s, [
        "id",
        "name",
        "description",
        "links",
        "npcs",
        "entryCondition",
        "revealCondition",
      ]);
      for (const npc of s.npcs) exact(npc, ["name", "description"]);
      exact(s.entryCondition, ["type"]);
      if (s.revealCondition) exact(s.revealCondition, ["type", "description"]);
    }
    exact(p, [
      "kind",
      "id",
      "version",
      "name",
      "description",
      "startLocation",
      "startSceneId",
      "scenes",
      "opening",
      "secrets",
      "personalSecrets",
      "story",
    ]);
    validateStory(p);
  }
  return structuredClone(p);
}
export const builtinRules: GamePackage = {
  kind: "rules",
  id: "simple-d20",
  version: "1.0.0",
  name: "烛火 d20",
  description: "原创简化 d20；不是完整 D&D 规则。",
  engine: "simple-d20-v1",
  parameters: { defaultDc: 12, maxStamina: 6, damageSides: 6, damageBonus: 2 },
  supported: [
    "d20+固定加值检定",
    "护甲命中与 d6+2 伤害",
    "体力与生命",
    "顺序回合与敌人反击",
  ],
  unsupported: [
    "职业/法术/升级",
    "优势劣势与豁免",
    "完整 D&D 版权规则",
    "复杂距离、地图寻路",
  ],
};
export const builtinScenario: GamePackage = {
  kind: "scenario",
  id: "lantern-vault",
  version: "1.0.0",
  name: "雾灯地窖",
  description: "原创短篇：探索失去灯光的地窖，处理守卫与旧约。",
  startLocation: "雾灯镇 · 废弃灯塔入口",
  startSceneId: "entrance",
  scenes: [
    {
      id: "entrance",
      name: "灯塔入口",
      description: "湿石阶旁挂着熄灭的铁灯。",
      links: ["cellar"],
      npcs: [{ name: "码头信使", description: "请求找回灯光的年轻信使。" }],
      entryCondition: { type: "always" },
      revealCondition: null,
    },
    {
      id: "cellar",
      name: "潮湿地窖",
      description: "木架与齿轮守卫挡住长廊。",
      links: ["entrance", "beacon"],
      npcs: [{ name: "齿轮守卫", description: "循着声响转动的铜制守卫。" }],
      entryCondition: { type: "always" },
      revealCondition: {
        type: "planned",
        description: "剧本条件揭示系统尚未实现；自由检定不会自动揭密。",
      },
    },
    {
      id: "beacon",
      name: "蓝灯室",
      description: "裂窗后的灯芯仍有微光，墙上刻着旧约。",
      links: ["cellar"],
      npcs: [],
      entryCondition: { type: "always" },
      revealCondition: null,
    },
  ],
  opening:
    "潮水敲着石阶，最后一盏蓝灯在门后闪烁。你们来到废弃灯塔；地窖传来金属拖动的声音。你们准备如何接近？",
  secrets: ["守灯人藏在第二道门后，铜铃是停下守卫的钥匙。"],
  personalSecrets: [
    "你曾在镇史中读过：三声铜铃代表停战。",
    "你认得入口的旧商会标志。",
  ],
};
export interface Store {
  read<T>(key: string): Promise<T | undefined>;
  write(key: string, value: unknown): Promise<void>;
}
export class MemoryStore implements Store {
  private map = new Map<string, unknown>();
  async read<T>(k: string) {
    return structuredClone(this.map.get(k)) as T | undefined;
  }
  async write(k: string, v: unknown) {
    this.map.set(k, structuredClone(v));
  }
}
export class FileStore implements Store {
  constructor(public directory: string) {}
  private path(k: string) {
    requireThat(/^[a-z0-9-]+$/.test(k));
    return join(this.directory, k + ".json");
  }
  async read<T>(k: string) {
    try {
      return JSON.parse(await readFile(this.path(k), "utf8")) as T;
    } catch (e: any) {
      if (e.code === "ENOENT") return undefined;
      throw new Fault("STORE_FAILURE", "存档无法读取", 500);
    }
  }
  async write(k: string, v: unknown) {
    await mkdir(this.directory, { recursive: true });
    let p = this.path(k);
    await writeFile(p + ".tmp", JSON.stringify(v), { mode: 0o600 });
    await rename(p + ".tmp", p);
  }
}
export interface Dice {
  roll(sides: number): number;
}
export const secureDice: Dice = { roll: (s) => randomInt(1, s + 1) };
export interface DocumentImporter {
  id: string;
  mimeTypes: string[];
  import(content: string): Promise<{ text: string; source: string }>;
}
export interface Retriever {
  id: string;
  search(
    query: string,
    publicDocuments: { text: string; source: string }[],
  ): Promise<{ text: string; source: string }[]>;
}
export interface AssetProvider {
  id: string;
  list(location: string): Promise<{ id: string; label: string; url: string }[]>;
}
export interface ChannelAdapter {
  id: string;
  normalize(input: unknown): {
    externalUserId: string;
    eventId: string;
    text: string;
  };
}
export class ExtensionRegistry {
  importers = new Map<string, DocumentImporter>();
  retrievers = new Map<string, Retriever>();
  assets = new Map<string, AssetProvider>();
  channels = new Map<string, ChannelAdapter>();
  register<T extends { id: string }>(
    type: "importers" | "retrievers" | "assets" | "channels",
    extension: T,
  ) {
    requireThat(!this[type].has(extension.id));
    (this[type] as Map<string, any>).set(extension.id, extension);
  }
}
export const extensions = new ExtensionRegistry();
extensions.register("channels", {
  id: "qq-simulated",
  normalize(input: unknown) {
    requireThat(
      object(input) &&
        str(input.qqUserId, 100) &&
        str(input.eventId, 100) &&
        str(input.text),
    );
    return {
      externalUserId: input.qqUserId,
      eventId: input.eventId,
      text: input.text,
    };
  },
} satisfies ChannelAdapter);
extensions.register("importers", {
  id: "plain-text",
  mimeTypes: ["text/plain", "text/markdown"],
  async import(content: string) {
    requireThat(str(content, 100000));
    return { text: content, source: "inline" };
  },
} satisfies DocumentImporter);
extensions.register("retrievers", {
  id: "keyword",
  async search(q: string, docs: { text: string; source: string }[]) {
    return docs
      .filter((d) => d.text.toLowerCase().includes(q.toLowerCase()))
      .slice(0, 5);
  },
} satisfies Retriever);
extensions.register("assets", {
  id: "location-only",
  async list(location: string) {
    return [{ id: "location", label: location, url: "" }];
  },
} satisfies AssetProvider);
export const extensionStatus = [
  {
    id: "json-package",
    status: "ready",
    description: "版本化规则与原创剧本 JSON 导入",
  },
  {
    id: "plain-text",
    status: "extension-api",
    description: "纯文本/Markdown 导入接口；未提供 PDF/OCR",
  },
  {
    id: "keyword",
    status: "extension-api",
    description: "公开文档关键词检索接口；无向量数据库",
  },
  {
    id: "location-only",
    status: "ready",
    description: "位置文字；地图绘制与素材服务待注册",
  },
  {
    id: "qq",
    status: "simulated",
    description: "身份绑定与标准事件模拟；真实 QQ 网关待联调",
  },
];
