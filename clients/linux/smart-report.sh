#!/usr/bin/env bash
# SMART 上报脚本 (Linux): 枚举所有盘, 取 smartctl JSON, 原样打包 POST 给 Worker
# 依赖: smartmontools jq curl    (Debian/Ubuntu: apt install smartmontools jq curl)
# 客户端不做任何判断, 判断全在 Worker 端, 改阈值不用动各台机器
set -u

WORKER_URL="https://smart.example.com/report"
TOKEN="改成你的REPORT_TOKEN"                                    # ← 与 Worker 的 REPORT_TOKEN 一致
HOST="$(cat /proc/sys/kernel/hostname 2>/dev/null || echo unknown-host)"   # 不用 hostname 命令: 精简系统/OpenWrt 可能没装

reports='[]'
while read -r name type; do
  [ -n "$name" ] || continue
  args=(-a -j --nocheck standby)          # --nocheck standby: 盘在休眠就不唤醒, 本次跳过
  [ -n "$type" ] && args+=(-d "$type")
  out="$(smartctl "${args[@]}" "$name" 2>/dev/null || true)"
  [ -n "$out" ] || continue
  # 读不到 SMART 数据的盘 (休眠/不支持) 不上报
  echo "$out" | jq -e '.smart_status or .nvme_smart_health_information_log or .ata_smart_attributes' >/dev/null 2>&1 || continue
  reports="$(jq -c --argjson r "$out" '. + [$r]' <<<"$reports")"
done < <(smartctl --scan-open -j 2>/dev/null | jq -r '.devices[] | "\(.name) \(.type // "")"')

payload="$(jq -n --arg host "$HOST" --argjson reports "$reports" '{host:$host, reports:$reports}')"
curl -s -m 30 -X POST "$WORKER_URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$payload" >/dev/null

# ---------------- OpenWrt 提示 ----------------
# OpenWrt 默认是 ash 没有数组: opkg install smartmontools jq curl 后,
# 把上面 args 两行换成:
#   extra=""; [ -n "$type" ] && extra="-d $type"
#   out="$(smartctl -a -j --nocheck standby $extra "$name" 2>/dev/null || true)"
# (这里 $extra 不加引号是有意的, 让它拆成两个参数)
# 定时: crontab -e 加一行  */10 * * * * /usr/bin/smart-report.sh
