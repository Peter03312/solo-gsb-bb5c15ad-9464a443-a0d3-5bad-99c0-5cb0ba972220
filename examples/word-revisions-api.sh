#!/usr/bin/env bash
# 校对者逐词时间修正（提交 → 预览 → 确认）完整调用示例。
# 依赖：bash + curl + python3（仅用于解析 JSON）。
#
# 用法：
#   bash examples/word-revisions-api.sh [BASE_URL]
# 例如：bash examples/word-revisions-api.sh http://localhost:3000
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

echo "=== 0. 新建项目并排版（准备数据） ==="
WORDS='{"words":[
  {"text":"你好","start_ms":0,"end_ms":500},
  {"text":"世界","start_ms":550,"end_ms":1000},
  {"text":"欢迎","start_ms":1500,"end_ms":2000},
  {"text":"光临","start_ms":2050,"end_ms":2500},
  {"text":"再见","start_ms":3000,"end_ms":3400},
  {"text":"朋友","start_ms":3450,"end_ms":3900}
],"cuts":[1200,2800]}'

out="$(req POST /api/projects "$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); d['name']='逐词修正 API 示例'; print(json.dumps(d,ensure_ascii=False))" "$WORDS")")"
PID="$(echo "$out" | body_of | jget id)"
echo "项目 id=$PID"
req POST "/api/projects/$PID/layout" '{"sub_version":0}' >/dev/null
echo "已排版（3 条字幕：词0-1 / 词2-3 / 词4-5），当前字幕集 v1"

echo
echo "=== 1. 提交逐词修正（必须携带读取时 sub_version；只保存快照，不改词与字幕） ==="
SUBMIT=$(cat <<JSON
{"note":"第二段整体提前100ms",
 "sub_version":1,
 "items":[
   {"word_idx":2,"start_ms":1400,"end_ms":1900},
   {"word_idx":3,"start_ms":1950,"end_ms":2400}
 ]}
JSON
)
out="$(req POST "/api/projects/$PID/word-revisions" "$SUBMIT")"
code="$(echo "$out" | code_of)"
WRID="$(echo "$out" | body_of | jget id)"
echo "HTTP $code，词修正提议 id=$WRID（201 = 已保存 pending；正式词/字幕未变）"

echo
echo "=== 2. 预览：受影响字幕 + 候选整版 + 逐处冲突（只读） ==="
req POST "/api/projects/$PID/word-revisions/$WRID/preview" '{}' | body_of | python3 -c '
import json,sys
ev=json.load(sys.stdin)["evaluation"]
print("ok =",ev["ok"])
print("将重排字幕:",[(s["id"],s["text"]) for s in ev["replaced"]])
print("含修正词的锁定字幕:",[s["id"] for s in ev["affected_locked"]])
for c in ev["subtitles"]:
    tag="保留 #%s v%s"%(c["id"],c["version"]) if c["origin"]=="kept" else "重排新行(新ID)"
    print("  候选: 词%d-%d [%d,%d] %s  <- %s"%(c["word_start"],c["word_end"],c["start_ms"],c["end_ms"],c["text"],tag))
'

echo
echo "=== 3. 非法请求示例：缺 sub_version / 空组 / 重复序号 / 非法时间 → 400 ==="
req POST "/api/projects/$PID/word-revisions" '{"items":[{"word_idx":2,"start_ms":1400,"end_ms":1900}]}' | body_of
req POST "/api/projects/$PID/word-revisions" '{"sub_version":1,"items":[]}' | body_of
req POST "/api/projects/$PID/word-revisions" \
  '{"sub_version":1,"items":[{"word_idx":2,"start_ms":1400,"end_ms":1900},{"word_idx":2,"start_ms":1,"end_ms":2}]}' | body_of

echo
echo "=== 4. sub_version 过期 → 409，返回当前词与字幕 ==="
req POST "/api/projects/$PID/word-revisions" \
  '{"sub_version":99,"items":[{"word_idx":2,"start_ms":1400,"end_ms":1900}]}' | body_of | head -c 200
echo

echo
echo "=== 5. 无法兼顾锁定：锁定第一条后，把词0/词1整体推过锁定结束（且跨过切点） ==="
SID1="$(req GET "/api/projects/$PID" | body_of | python3 -c 'import json,sys; print([s["id"] for s in json.load(sys.stdin)["subtitles"] if s["word_start"]==0][0])')"
req PATCH "/api/projects/$PID/subtitles/$SID1" '{"version":1,"locked":true,"text":"人工锁定文本"}' >/dev/null
# 词0结束 1100 超出锁定结束 1000（锁定行必须原样保留）；词1 [1100,1250] 还把切点 1200 包入词内
BAD=$(cat <<JSON
{"sub_version":2,"items":[
  {"word_idx":0,"start_ms":0,"end_ms":1100},
  {"word_idx":1,"start_ms":1100,"end_ms":1250}
]}
JSON
)
out="$(req POST "/api/projects/$PID/word-revisions" "$BAD")"
BAD_ID="$(echo "$out" | body_of | jget id)"
req POST "/api/projects/$PID/word-revisions/$BAD_ID/preview" '{}' | body_of \
  | python3 -c 'import json,sys; ev=json.load(sys.stdin)["evaluation"]; print("ok =",ev["ok"]); print(sorted({c["type"] for i in ev["items"] for c in i["conflicts"]}))'
echo "尝试确认：HTTP $(req POST "/api/projects/$PID/word-revisions/$BAD_ID/confirm" '{}' | code_of)（422，词与字幕均不变）"

echo
echo "=== 6. 确认合法提议（第 1 步的 wrid=$WRID 基于 v1；锁定后当前已 v2，先演示过期再重提） ==="
echo "旧提议确认：HTTP $(req POST "/api/projects/$PID/word-revisions/$WRID/confirm" '{}' | code_of)（409 = 版本过期，整组不生效）"
# 第二段落点仍在 2800 前；把提交载荷的 sub_version 改为当前 2 后重新提交
FIXED="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); d["sub_version"]=2; print(json.dumps(d,ensure_ascii=False))' "$SUBMIT")"
out="$(req POST "/api/projects/$PID/word-revisions" "$FIXED")"
WRID2="$(echo "$out" | body_of | jget id)"
echo "基于当前 v2 重新提交：wrid=$WRID2（HTTP $(echo "$out" | code_of)）"
req POST "/api/projects/$PID/word-revisions/$WRID2/confirm" '{}' | body_of | python3 -m json.tool --no-ensure-ascii | sed -n '1,14p'

echo
echo "=== 7. 重复确认 → 409，不再改词与字幕 ==="
req POST "/api/projects/$PID/word-revisions/$WRID2/confirm" '{}' | body_of

echo
echo "=== 8. 历史 / 详情 / 旧导出快照不受影响 ==="
req GET "/api/projects/$PID/word-revisions" | body_of | python3 -m json.tool --no-ensure-ascii
echo "单提议（含 orig 原值快照 / current 当前词 / proposed 建议值）："
req GET "/api/projects/$PID/word-revisions/$WRID2" | body_of | python3 -m json.tool --no-ensure-ascii | sed -n '1,28p'

echo
echo "完成。"
