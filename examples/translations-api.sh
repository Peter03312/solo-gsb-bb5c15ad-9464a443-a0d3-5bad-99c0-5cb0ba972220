#!/usr/bin/env bash
# 多语言译文字幕完整调用示例（保存 → 查询并列 → 失效/待复核 → 确认 → 按语言导出）。
# 依赖：bash + curl + python3（仅用于解析 JSON）。
#
# 用法：
#   bash examples/translations-api.sh [BASE_URL]
# 例如：bash examples/translations-api.sh http://localhost:3000
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
WORDS='{"name":"译文 API 示例","words":[
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
echo "=== 1. 保存英语译文（新建 201；须带 cue_version 读取时行版本） ==="
out="$(req PUT "/api/projects/$PID/translations/en/subtitles/$SID1" \
  '{"text":"Hello world","cue_version":1}')"
echo "HTTP $(echo "$out" | code_of)：$(echo "$out" | body_of | jget translation.status) v$(echo "$out" | body_of | jget translation.version)"
out="$(req PUT "/api/projects/$PID/translations/en/subtitles/$SID2" \
  '{"text":"Welcome","cue_version":1}')"
echo "HTTP $(echo "$out" | code_of)"

echo
echo "=== 2. 更新译文必须带译文版本（乐观锁） ==="
echo "不带 version（按新建提交已存在行）→ 409："
req PUT "/api/projects/$PID/translations/en/subtitles/$SID1" \
  '{"text":"Hi world","cue_version":1}' | body_of
echo "带旧 version=99 → 409："
req PUT "/api/projects/$PID/translations/en/subtitles/$SID1" \
  '{"text":"Hi world","cue_version":1,"version":99}' | body_of
echo "带当前 version=1 → 200，版本推进到 2："
req PUT "/api/projects/$PID/translations/en/subtitles/$SID1" \
  '{"text":"Hello, world","cue_version":1,"version":1}' | body_of \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("now:", d["translation"]["text"], "v"+str(d["translation"]["version"]))'

echo
echo "=== 3. 非法请求示例 → 400/404/422 ==="
echo "语言代号非法（含空格）："
req PUT "/api/projects/$PID/translations/zh%20CN/subtitles/$SID1" \
  '{"text":"你好","cue_version":1}' | body_of
echo "空译文："
req PUT "/api/projects/$PID/translations/en/subtitles/$SID1" \
  '{"text":"   ","cue_version":1}' | body_of
echo "字幕不存在："
req PUT "/api/projects/$PID/translations/en/subtitles/99999" \
  '{"text":"Ghost","cue_version":1}' | body_of
echo "译文超 max_chars（默认 30 字，给 31 字）→ 422 不改数据："
req PUT "/api/projects/$PID/translations/en/subtitles/$SID2" \
  "$(python3 -c 'import json; print(json.dumps({"text":"x"*31,"cue_version":1}))')" | body_of

echo
echo "=== 4. 并列查询：原文/译文/状态（missing/current/review + 现行规则原因） ==="
req GET "/api/projects/$PID/translations/en" | body_of \
  | python3 -c 'import json,sys
d=json.load(sys.stdin)
for e in d["entries"]:
    t = e["translation"]["text"] if e["translation"] else None
    print("  字幕#{} 原文={!r} 译文={!r} 状态={} 有效={}".format(
        e["cue"]["id"], e["cue"]["text"], t, e["state"], e["valid"]))
print("统计:", d["counts"])'

echo
echo "=== 5. 仅锁定不使译文失效；源文本/时间变化才转待复核 ==="
req PATCH "/api/projects/$PID/subtitles/$SID1" '{"version":1,"locked":true}' >/dev/null
state="$(req GET "/api/projects/$PID/translations/en" | body_of | jget entries.0.state)"
echo "锁定后状态=$state（仍 current）"
req PATCH "/api/projects/$PID/subtitles/$SID1" '{"version":2,"text":"你好呀世界"}' >/dev/null
state="$(req GET "/api/projects/$PID/translations/en" | body_of | jget entries.0.state)"
echo "源文本修改后状态=$state（review，译文与数据均保留）"

echo
echo "=== 6. 确认待复核译文（校对者核对当前源行） ==="
echo "过期译文版本 → 409 不改数据："
req POST "/api/projects/$PID/translations/en/subtitles/$SID1/confirm" '{"version":99}' | body_of
echo "带当前版本 → 200 恢复 current 并刷新快照："
req POST "/api/projects/$PID/translations/en/subtitles/$SID1/confirm" '{"version":2}' | body_of \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); t=d["translation"]; print("状态:", t["status"], "v"+str(t["version"]), "源快照:", t["src_text"])'

echo
echo "=== 7. 重排：消失的原行译文留作历史，新行视为缺译（不按序号挪用） ==="
# 解锁 SID1，收紧 max_chars=2 且缩短最短时长，使两条原行拆成四条单字词行
req PATCH "/api/projects/$PID/subtitles/$SID1" '{"version":3,"locked":false}' >/dev/null
SUBV="$(req GET "/api/projects/$PID" | body_of | jget sub_version)"
req PUT "/api/projects/$PID/rules" \
  '{"version":1,"max_chars":2,"min_duration_ms":300,"max_cps":20}' >/dev/null
req POST "/api/projects/$PID/layout" "{\"sub_version\":$SUBV}" >/dev/null
echo "重排后该语言视图："
req GET "/api/projects/$PID/translations/en" | body_of \
  | python3 -c 'import json,sys; d=json.load(sys.stdin)
print("  当前行状态:", [e["state"] for e in d["entries"]])
print("  历史译文数:", len(d["history"]))'
# 恢复规则并重建两条字幕，便于后续演示
req PUT "/api/projects/$PID/rules" \
  '{"version":2,"max_chars":30,"min_duration_ms":800,"max_cps":20}' >/dev/null
SUBV="$(req GET "/api/projects/$PID" | body_of | jget sub_version)"
req POST "/api/projects/$PID/layout" "{\"sub_version\":$SUBV}" >/dev/null

echo
echo "=== 8. 按语言导出：缺漏/待复核/无效 → 422 分类列出，不生成快照 ==="
# 新行全部缺译（历史不挪用）→ missing
req POST "/api/projects/$PID/translations/en/exports" '{}' | body_of \
  | python3 -c 'import json,sys; d=json.load(sys.stdin)
print("  错误:", d["error"])
print("  缺译行:", [m["subtitle_id"] for m in d["missing"]])'

echo
echo "=== 9. 补齐两种语言并导出不可变 WebVTT ==="
NEW_SID1="$(req GET "/api/projects/$PID" | body_of | jget subtitles.0.id)"
NEW_SID2="$(req GET "/api/projects/$PID" | body_of | jget subtitles.1.id)"
req PUT "/api/projects/$PID/translations/en/subtitles/$NEW_SID1" '{"text":"Hello world","cue_version":1}' >/dev/null
req PUT "/api/projects/$PID/translations/en/subtitles/$NEW_SID2" '{"text":"Welcome","cue_version":1}' >/dev/null
req PUT "/api/projects/$PID/translations/fr/subtitles/$NEW_SID1" '{"text":"Bonjour le monde","cue_version":1}' >/dev/null
req PUT "/api/projects/$PID/translations/fr/subtitles/$NEW_SID2" '{"text":"Bienvenue","cue_version":1}' >/dev/null
out="$(req POST "/api/projects/$PID/translations/en/exports" '{}')"
echo "英语导出 HTTP $(echo "$out" | code_of)："
echo "$out" | body_of | python3 -c 'import json,sys; print(json.load(sys.stdin)["content"])'

echo "--- 英语快照列表 / 下载 v1（不可变） ---"
req GET "/api/projects/$PID/translations/en/exports" | body_of | python3 -m json.tool --no-ensure-ascii
echo "下载：$BASE/api/projects/$PID/translations/en/exports/1"

echo
echo "=== 10. 语言总览 + 历史译文 ==="
req GET "/api/projects/$PID/translations" | body_of | python3 -m json.tool --no-ensure-ascii
echo "英语历史译文（被重排删除的原行，留档不挪用）："
req GET "/api/projects/$PID/translations/en" | body_of \
  | python3 -c 'import json,sys; d=json.load(sys.stdin)
for h in d["history"]: print(" ", h["id"], h["text"], h["status"], "subtitle_id=", h["subtitle_id"])'

echo
echo "完成。原文导出仍可用：POST $BASE/api/projects/$PID/exports"
