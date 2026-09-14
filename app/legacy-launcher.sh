#!/bin/sh
# Mixrouter 启动器:确保本地路由在跑(launchd 托管优先),再打开控制台 http://127.0.0.1:8788
DIR="${MIXROUTER_REPO:-$(CDPATH= cd "$(dirname "$0")/.." && pwd)}"
LABEL="${MIXROUTER_LAUNCH_LABEL:-com.$(id -un).mixrouter}"
UID_NUM="$(id -u)"
healthy() { curl -s --max-time 2 http://127.0.0.1:8787/healthz >/dev/null 2>&1; }

if ! healthy; then
  launchctl kickstart "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1 || true
  i=0
  while [ $i -lt 12 ] && ! healthy; do sleep 0.5; i=$((i + 1)); done
  if ! healthy; then
    # 没装 LaunchAgent(或它起不来)→ 退回直接跑脚本起服务
    [ -x "$DIR/scripts/launchd-run.sh" ] && nohup "$DIR/scripts/launchd-run.sh" >/dev/null 2>&1 &
    i=0
    while [ $i -lt 12 ] && ! healthy; do sleep 0.5; i=$((i + 1)); done
  fi
fi
open "http://127.0.0.1:8788"
