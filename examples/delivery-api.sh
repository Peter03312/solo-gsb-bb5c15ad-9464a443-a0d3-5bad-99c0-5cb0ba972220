#!/usr/bin/env bash
# 多语批次交付完整调用示例（保存译文 → 交付批次 → 查询批次清单 → 经既有下载取得文件）。
# 依赖：bash + curl + python3（仅用于解析 JSON）。
#
# 用法：
#   bash examples/delivery-api.sh [BASE_URL]
# 例如：bash examples/delivery-api.sh http://localhost:3000
set -euo pipefail

BASE="${1:-http://localhost:3000}"

req() {
  local method="$1"; local path="$2"; local body="${3:-}"
  if [ -n "$body" ]; then
    curl -s -w '\n%{http_code}' -X "$method" "$BASE$path" \
      -H 'Content-Type: application/json' -d "$body"
  else
    curl -s -w '\n%{http_code}' -X "$method" "$BASE$path"
  fi
}
body_of() { sed '$d'; }
code_of() { tail -1; }
jget() { python3 -c 'import json,sys; d=json.load(sys.stdin);
ks=sys.argv[1].split("."); v=d
for k in ks: v=v[int(k)] if k.isdigit() else v[k]
print(v)' "$1"; }

echo "=== 0. 新建项目并排版（准备源字幕） ==="
WORDS='{"name":"批次交付 API 示例","words":[
  {"text":"你好","start_ms":0,"end_ms":500},
  {"text":"世界","start_ms":550,"end_ms":1000},
  {"text":"欢迎","start_ms":1500,"end_ms":2000},
  {"text":"光临","start_ms":2050,"end_ms":2500}
],"cuts":[1200]}'
out="$(req POST /api/projects "$WORDS")"
PID="$(echo "$out" | body_of | jget id)"
echo "项目 id=$PID"
out="$(req POST "/api/projects/$PID/layout" '{"sub_version":0}')"
SID1="$(echo "$out" | body_of | jget subtitles.0.id)"
SID2="$(echo "$out" | body_of | jget subtitles.1.id)"
echo "源字幕 id=$SID1 / $SID2"

echo
echo "=== 1. 保存两种语言译文（英语齐全，法语只译一行） ==="
req PUT "/api/projects/$PID/translations/en/subtitles/$SID1" '{"text":"Hello world","cue_version":1}' >/dev/null
req PUT "/api/projects/$PID/translations/en/subtitles/$SID2" '{"text":"Welcome","cue_version":1}' >/dev/null
req PUT "/api/projects/$PID/translations/fr/subtitles/$SID1" '{"text":"Bonjour le monde","cue_version":1}' >/dev/null
echo "en 两行已就绪；fr 第 2 行故意缺译"

echo
echo "=== 2. 缺译时交付 → 422 按语言与字幕行返回原因，整批不生成快照 ==="
SUBV="$(req GET "/api/projects/$PID" | body_of | jget sub_version)"
req POST "/api/projects/$PID/deliveries" "{
  \"sub_version\": $SUBV,
  \"rules_version\": 1,
  \"languages\": [\"en\", \"fr\"],
  \"versions\": {
    \"en\": {\"$SID1\": 1, \"$SID2\": 1},
    \"fr\": {\"$SID1\": 1}
  }
}" | body_of | python3 -c 'import json,sys; d=json.load(sys.stdin)
print("  错误:", d["error"])
for l in d["languages"]:
    print(" ", l["lang"], "缺译:", [m["subtitle_id"] for m in l["missing"]],
          "版本漂移:", [(s["subtitle_id"], s["submitted_version"], s["current_version"]) for s in l["stale"]])'
echo "批次数（应为 0）：$(req GET "/api/projects/$PID/deliveries" | body_of | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"

echo
echo "=== 3. 版本漂移示例：字幕集版本过期 → 409 带当前值 ==="
req POST "/api/projects/$PID/deliveries" "{
  \"sub_version\": 999,
  \"rules_version\": 1,
  \"languages\": [\"en\"],
  \"versions\": {\"en\": {\"$SID1\": 1, \"$SID2\": 1}}
}" | body_of

echo
echo "=== 4. 补齐法语译文，成功交付批次（一次事务冻结原文 + en + fr） ==="
req PUT "/api/projects/$PID/translations/fr/subtitles/$SID2" '{"text":"Bienvenue","cue_version":1}' >/dev/null
SUBV="$(req GET "/api/projects/$PID" | body_of | jget sub_version)"
out="$(req POST "/api/projects/$PID/deliveries" "{
  \"sub_version\": $SUBV,
  \"rules_version\": 1,
  \"languages\": [\"en\", \"fr\"],
  \"versions\": {
    \"en\": {\"$SID1\": 1, \"$SID2\": 1},
    \"fr\": {\"$SID1\": 1, \"$SID2\": 1}
  }
}")"
echo "HTTP $(echo "$out" | code_of)"
BID="$(echo "$out" | body_of | jget id)"
echo "$out" | body_of | python3 -c 'import json,sys; d=json.load(sys.stdin)
print("批次 #{} · 字幕集 v{} · 规则 v{} · {} 条".format(d["id"], d["sub_version"], d["rules_version"], d["cue_count"]))
for f in d["files"]:
    print("  {} {} v{} → {}".format(f["kind"], f["lang"] or "", f["version"], f["download_url"]))'

echo
echo "=== 5. 经既有下载能力取得批次文件（时间轴一致） ==="
for url in "/api/projects/$PID/exports/1" \
           "/api/projects/$PID/translations/en/exports/1" \
           "/api/projects/$PID/translations/fr/exports/1"; do
  echo "--- GET $url"
  curl -s "$BASE$url" | head -4
done

echo
echo "=== 6. 查询批次清单（列表 + 单个） ==="
req GET "/api/projects/$PID/deliveries" | body_of | python3 -m json.tool --no-ensure-ascii
echo "单个批次 #${BID}："
req GET "/api/projects/$PID/deliveries/$BID" | body_of | python3 -c 'import json,sys; d=json.load(sys.stdin)
print("  文件:", [(f["kind"], f["lang"], f["version"]) for f in d["files"]])'

echo
echo "=== 7. 后续编辑不改变旧批次：修改源字幕后旧文件内容不变 ==="
req PATCH "/api/projects/$PID/subtitles/$SID1" '{"version":1,"text":"你好世界呀"}' >/dev/null
echo "编辑后原文导出 v1 仍含旧文本："
curl -s "$BASE/api/projects/$PID/exports/1" | grep -c "你好世界" | sed 's/^/  匹配行数: /'
echo "（译文此时已转待复核；重新保存译文并携带新版本即可交付下一批次）"

echo
echo "完成。既有原文导出（POST /api/projects/$PID/exports）与单语言导出（POST …/translations/en/exports）不受影响。"
