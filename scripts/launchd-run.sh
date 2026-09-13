#!/bin/sh
# LaunchAgent 入口(plist 名形如 com.<用户名>.mixrouter,装法见 README「常驻(可选)」)。
# 先把 pid 写进 .run/mixrouter.pid 再 exec:exec 不换 PID,所以这个 pid 就是 node 的 pid,
# mixctl status / stop 照样认得(launchd 起和 mixctl 起不是两套状态)。
# 退出码 0 = 正常停止;plist 里 KeepAlive.SuccessfulExit=false,只有非正常退出才会被拉起。
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node 2>/dev/null || true)"
if [ ! -x "${NODE:-}" ]; then
  NODE="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1)"
fi
if [ ! -x "${NODE:-}" ]; then echo "找不到 node,无法启动 mixrouter" >&2; exit 1; fi
mkdir -p "$DIR/.run" "$DIR/logs"
echo $$ > "$DIR/.run/mixrouter.pid"
exec "$NODE" "$DIR/mixrouter.js"
