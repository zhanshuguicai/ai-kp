#!/bin/sh
# AI KP launcher for macOS / Linux. Run: sh start.sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 Node.js。请先到 https://nodejs.org 安装 LTS 版（22.13 或更高）。"
  exit 1
fi
if ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"; then
  echo "Node.js 版本太旧，需要 22.13 或更高。请到 https://nodejs.org 安装最新的 LTS 版。"
  exit 1
fi
echo "AI KP 正在启动：打开浏览器访问 http://127.0.0.1:3100"
echo "管理令牌在本文件夹的 data/admin-token.txt 里。按 Ctrl+C 停止。"
exec node --env-file-if-exists=.env --disable-warning=ExperimentalWarning dist/src/platform/server.js
