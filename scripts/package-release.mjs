// Assemble a ready-to-run release folder: compiled platform, web pages, launchers and docs.
// Needs `npm run build` first. Usage: node scripts/package-release.mjs [outDir]
// The folder needs only Node.js (22.13+) to run: no npm install, no build.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const name = `ai-kp-v${pkg.version}`;
const out = resolve(process.argv[2] ?? join(root, "release"), name);

if (!existsSync(join(root, "dist/src/platform/server.js"))) {
  console.error("找不到 dist/src/platform/server.js，请先运行 npm run build");
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const copy = (from, to = from) => cpSync(join(root, from), join(out, to), { recursive: true });
copy("dist/src/platform");
copy("web/platform");
copy("scripts/release/Start-AI-KP.bat", "Start-AI-KP.bat");
copy("scripts/release/start.sh", "start.sh");
copy("docs/使用说明.md", "使用说明.md");
copy("LICENSE");
copy(".env.example");

// Only what Node needs to run ES modules; there are no runtime dependencies.
writeFileSync(
  join(out, "package.json"),
  JSON.stringify({ name: "ai-kp", version: pkg.version, private: true, license: pkg.license, type: "module" }, null, 2) + "\n",
);
writeFileSync(join(out, "VERSION.txt"), `AI KP v${pkg.version}\n`);
console.log(out);
