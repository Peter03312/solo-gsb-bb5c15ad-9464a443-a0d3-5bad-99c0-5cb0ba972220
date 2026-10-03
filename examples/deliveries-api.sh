#!/usr/bin/env bash
# 片方多语字幕交付完整调用示例（原文 + 多语言冻结为同一时间轴的一个批次）。
# 依赖：bash + curl + python3（仅用于解析 JSON）。
#
# 用法：
#   bash examples/deliveries-api.sh [BASE_URL]
# 例如：bash examples/deliveries-api.sh http://localhost:3000
#
# 流程：新建项目并排版 → 保存两种语言译文 → 各类失败示例（非法/版本漂移/缺译/待复核）
#       → 成功交付批次（各序列生成不可变 WebVTT）→ 批次清单查询 → 经既有接口下载
#       → 后续编辑不改旧批次 → 再次交付在各序列取新版本。
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
WORDS='{"name":"片方交付 API 示例","words":[
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

# 用 python 生成完整请求体：携带 字幕集版本、规则版本、语言列表、各语言逐行译文版本
build_body() {
  local subv="$1"; local rv="$2"; shift 2
  python3 - "$PID" "$SID1" "$SID2" "$subv" "$rv" "$@" <<'PY'
import json, sys
pid, sid1, sid2, subv, rv = sys.argv[1:6]
langs = sys.argv[6:]
print(json.dumps({
  "note": "片方交付批次",
  "sub_version": int(subv),
  "rules_version": int(rv),
  "languages": langs,
  "translations": {
    lang: [
      {"subtitle_id": int(sid1), "version": 1},
      {"subtitle_id": int(sid2), "version": 1},
    ] for lang in langs
  },
}))
PY
}

echo
echo "=== 1. 保存英语、法语译文（各两行，均为 v1） ==="
req PUT "/api/projects/$PID/translations/en/subtitles/$SID1" '{"text":"Hello world","cue_version":1}' >/dev/null
req PUT "/api/projects/$PID/translations/en/subtitles/$SID2" '{"text":"Welcome","cue_version":1}' >/dev/null
req PUT "/api/projects/$PID/translations/fr/subtitles/$SID1" '{"text":"Bonjour le monde","cue_version":1}' >/dev/null
req PUT "/api/projects/$PID/translations/fr/subtitles/$SID2" '{"text":"Bienvenue","cue_version":1}' >/dev/null
echo "两种语言各 2 行 current 译文已保存"

echo
echo "=== 2. 非法请求示例 → 400（不生成批次） ==="
echo "语言列表重复："
req POST "/api/projects/$PID/deliveries" "$(build_body 1 1 en en)" | body_of \
  | python3 -c 'import json,sys; print(" ", json.load(sys.stdin)["errors"][0])'
echo "逐行清单与字幕行数不一致（法语只给 1 行）："
BAD='{"sub_version":1,"rules_version":1,"languages":["en","fr"],
"translations":{"en":[{"subtitle_id":'$SID1',"version":1},{"subtitle_id":'$SID2',"version":1}],
"fr":[{"subtitle_id":'$SID1',"version":1}]}}'
req POST "/api/projects/$PID/deliveries" "$BAD" | body_of \
  | python3 -c 'import json,sys; print(" ", json.load(sys.stdin)["errors"][0])'

echo
echo "=== 3. 版本漂移 → 409（整批不生效，带当前值） ==="
req POST "/api/projects/$PID/deliveries" "$(build_body 999 1 en fr)" | body_of \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(" ", d["error"])'

echo
echo "=== 4. 缺译 → 422 按语言和字幕行返回原因（不生成快照、不消耗版本） ==="
req POST "/api/projects/$PID/deliveries" "$(build_body 1 1 en fr ja-JP)" | body_of \
  | python3 -c 'import json,sys
d=json.load(sys.stdin)
print(" ", d["error"])
ja = next(l for l in d["languages"] if l["lang"] == "ja-JP")
print("  ja-JP 缺译行:", [m["subtitle_id"] for m in ja["missing"]])'

echo
echo "=== 5. 译文待复核 → 422（源行已改，刷新 sub_version 后提交） ==="
SUBV="$(req PATCH "/api/projects/$PID/subtitles/$SID1" '{"version":1,"text":"你好呀世界"}' | body_of | jget sub_version)"
req POST "/api/projects/$PID/deliveries" "$(build_body "$SUBV" 1 en fr)" | body_of \
  | python3 -c 'import json,sys
d=json.load(sys.stdin)
for l in d["languages"]:
    print(" ", l["lang"], "review 行:", [(m["subtitle_id"], m["reasons"][0]) for m in l["review"]])'
# 恢复原文（演示干净交付）
req PATCH "/api/projects/$PID/subtitles/$SID1" '{"version":2,"text":"你好世界"}' >/dev/null
# 译文因此再次 review → 确认恢复 current（版本推进到 2）
req POST "/api/projects/$PID/translations/en/subtitles/$SID1/confirm" '{"version":1}' >/dev/null
req POST "/api/projects/$PID/translations/fr/subtitles/$SID1/confirm" '{"version":1}' >/dev/null
SUBV="$(req GET "/api/projects/$PID" | body_of | jget sub_version)"

echo
echo "=== 6. 译文版本漂移 → 422 version_stale（提交 v1，当前已是 v2） ==="
req POST "/api/projects/$PID/deliveries" "$(build_body "$SUBV" 1 en fr)" | body_of \
  | python3 -c 'import json,sys
d=json.load(sys.stdin)
for l in d["languages"]:
    for m in l["version_stale"]:
        print(" ", l["lang"], "字幕", m["subtitle_id"], "提交 v%s 当前 v%s" % (m["submitted_version"], m["current"]["version"]))'

echo
echo "=== 7. 成功交付：一个批次冻结原文 + 英语 + 法语（同一时间轴） ==="
BODY="$(python3 - "$SID1" "$SID2" "$SUBV" <<'PY'
import json, sys
sid1, sid2, subv = map(int, sys.argv[1:4])
print(json.dumps({
  "note": "片方交付第一批",
  "sub_version": subv,
  "rules_version": 1,
  "languages": ["en", "fr"],
  "translations": {
    "en": [{"subtitle_id": sid1, "version": 2}, {"subtitle_id": sid2, "version": 1}],
    "fr": [{"subtitle_id": sid1, "version": 2}, {"subtitle_id": sid2, "version": 1}],
  },
}))
PY
)"
out="$(req POST "/api/projects/$PID/deliveries" "$BODY")"
echo "HTTP $(echo "$out" | code_of)"
BID="$(echo "$out" | body_of | jget id)"
echo "$out" | body_of | python3 -c 'import json,sys
d=json.load(sys.stdin)
print(" 批次 id=%s 冻结 sub_version=%s rules_version=%s 语言=%s" % (
  d["id"], d["sub_version"], d["rules_version"], d["languages"]))
for f in d["files"]:
    print("  文件 ord=%s kind=%s lang=%s 序列版本=v%s -> %s" % (
      f["ord"], f["kind"], f["lang"], f["version"], f["download_url"]))'

echo
echo "=== 8. 查询批次清单 ==="
req GET "/api/projects/$PID/deliveries" | body_of | python3 -m json.tool --no-ensure-ascii
echo "--- 单个批次 ---"
req GET "/api/projects/$PID/deliveries/$BID" | body_of \
  | python3 -c 'import json,sys; d=json.load(sys.stdin)
print(" 批次", d["id"], d["note"], d["created_at"])
for f in d["files"]: print(" ", f["kind"], f["lang"], "v"+str(f["version"]), f["download_url"])'

echo
echo "=== 9. 文件经既有下载能力取得（内容不可变） ==="
SRC_URL="$BASE/api/projects/$PID/exports/1"
EN_URL="$BASE/api/projects/$PID/translations/en/exports/1"
echo "原文：curl -s $SRC_URL"
echo "英语：curl -s $EN_URL"
echo "--- 原文 v1 ---"
curl -s "$SRC_URL"
echo "--- 英语 v1 ---"
curl -s "$EN_URL"

echo
echo "=== 10. 后续编辑不改变旧批次；再次交付在各序列取新版本 ==="
# 修改原文与译文（英语确认恢复 current，法语重新保存）
NEW_SUBV="$(req PATCH "/api/projects/$PID/subtitles/$SID1" '{"version":3,"text":"你好世界呀"}' | body_of | jget sub_version)"
req POST "/api/projects/$PID/translations/en/subtitles/$SID1/confirm" '{"version":2}' >/dev/null
req PUT "/api/projects/$PID/translations/fr/subtitles/$SID1" '{"text":"Bonjour !","cue_version":4,"version":2}' >/dev/null
# 取各语言当前译文版本
BODY2="$(python3 - "$PID" "$SID1" "$SID2" "$NEW_SUBV" "$BASE" <<'PY'
import json, sys, urllib.request
pid, sid1, sid2, subv = map(int, sys.argv[1:5])
base = sys.argv[5].rstrip("/")
langs = ["en", "fr"]
trans = {}
for lang in langs:
    with urllib.request.urlopen(f"{base}/api/projects/{pid}/translations/{lang}") as r:
        view = json.load(r)
    trans[lang] = [
      {"subtitle_id": e["cue"]["id"], "version": e["translation"]["version"]}
      for e in view["entries"] if e["state"] == "current" and e["valid"]
    ]
print(json.dumps({"note": "片方交付第二批", "sub_version": subv, "rules_version": 1,
                  "languages": langs, "translations": trans}))
PY
)"
out="$(req POST "/api/projects/$PID/deliveries" "$BODY2")"
echo "第二批 HTTP $(echo "$out" | code_of)："
echo "$out" | body_of | python3 -c 'import json,sys
d=json.load(sys.stdin)
for f in d["files"]: print(" ", f["kind"], f["lang"], "v"+str(f["version"]))'
echo "旧批次原文 v1 仍为旧内容："
curl -s "$SRC_URL" | grep -q '你好世界$' && echo "  ✓ 旧快照不含后来的修改" || true

echo
echo "完成。既有原文/单语言导出与下载保持兼容："
echo "  POST $BASE/api/projects/$PID/exports"
echo "  POST $BASE/api/projects/$PID/translations/en/exports"
