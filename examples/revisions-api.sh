#!/usr/bin/env bash
# 校对者批量修订提议（提交 → 预览 → 采纳）完整调用示例。
# 依赖：bash + curl + python3（仅用于解析 JSON）。
#
# 用法：
#   bash examples/revisions-api.sh [BASE_URL]
# 例如：bash examples/revisions-api.sh http://localhost:3000
set -euo pipefail

BASE="${1:-http://localhost:3000}"

# ---- 小工具：POST/PUT JSON，输出 HTTP 状态码与响应体 ----
req() {
  local method="$1"; local path="$2"; local body="${3:-}"
  if [ -n "$body" ]; then
    curl -s -w '\n%{http_code}' -X "$method" "$BASE$path" \
      -H 'Content-Type: application/json' -d "$body"
  else
    curl -s -w '\n%{http_code}' -X "$method" "$BASE$path"
  fi
}
# 取响应体（去掉末尾状态码行）；取状态码
body_of() { sed '$d'; }
code_of() { tail -1; }
# 从 JSON 文本中提取标量字段（需要 python3）
jget() { python3 -c 'import json,sys; d=json.load(sys.stdin);
ks=sys.argv[1].split("."); v=d
for k in ks: v=v[int(k)] if k.isdigit() else v[k]
print(v)' "$1"; }

echo "=== 0. 新建项目并排版（演示数据准备，与提议功能无关） ==="
WORDS='{"words":[
  {"text":"你好","start_ms":0,"end_ms":500},
  {"text":"世界","start_ms":550,"end_ms":1000},
  {"text":"欢迎","start_ms":1500,"end_ms":2000},
  {"text":"光临","start_ms":2050,"end_ms":2500}
],"cuts":[1200]}'

out="$(req POST /api/projects "$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); d['name']='批量修订 API 示例'; print(json.dumps(d,ensure_ascii=False))" "$WORDS")")"
PID="$(echo "$out" | body_of | jget id)"
echo "项目 id=$PID"

out="$(req POST "/api/projects/$PID/layout" '{"sub_version":0}')"
SID1="$(echo "$out" | body_of | jget subtitles.0.id)"
SID2="$(echo "$out" | body_of | jget subtitles.1.id)"
echo "排版完成，字幕 id=$SID1 / $SID2"

echo
echo "=== 1. 提交一组修订（只保存，不改正式字幕） ==="
SUBMIT=$(cat <<JSON
{"note":"第一轮校对：改文本并微调第二条时间",
 "items":[
   {"subtitle_id":$SID1,"cue_version":1,"text":"你好呀，世界"},
   {"subtitle_id":$SID2,"cue_version":1,"text":"欢迎您光临","start_ms":1400}
 ]}
JSON
)
out="$(req POST "/api/projects/$PID/revisions" "$SUBMIT")"
code="$(echo "$out" | code_of)"
RID="$(echo "$out" | body_of | jget id)"
echo "HTTP $code，提议 id=$RID（201 表示已保存 pending；正式字幕未变）"

echo
echo "=== 2. 预览核对（并列原值/当前值/建议值，逐处列出冲突） ==="
out="$(req POST "/api/projects/$PID/revisions/$RID/preview" '{}')"
echo "$out" | body_of | python3 -m json.tool --no-ensure-ascii | sed -n '1,40p'
echo "...（evaluation.ok=true 表示整组可采纳）"

echo
echo "=== 3. 非法请求示例：空组 / 重复 ID / 空文本 / 非法时间 → 400 ==="
req POST "/api/projects/$PID/revisions" '{"items":[]}' | body_of
req POST "/api/projects/$PID/revisions" \
  "{\"items\":[{\"subtitle_id\":$SID1,\"cue_version\":1,\"text\":\"甲\"},
              {\"subtitle_id\":$SID1,\"cue_version\":1,\"text\":\"乙\"}]}" | body_of
req POST "/api/projects/$PID/revisions" \
  "{\"items\":[{\"subtitle_id\":$SID1,\"cue_version\":1,\"text\":\"\",\"start_ms\":900,\"end_ms\":800}]}" | body_of

echo
echo "=== 4. 含冲突的提议（跨切点 1200 / 与相邻重叠）→ 预览报冲突，采纳 422 整组不生效 ==="
BAD=$(cat <<JSON
{"items":[{"subtitle_id":$SID1,"cue_version":1,"text":"你好世界","end_ms":1600}]}
JSON
)
out="$(req POST "/api/projects/$PID/revisions" "$BAD")"
BAD_RID="$(echo "$out" | body_of | jget id)"
req POST "/api/projects/$PID/revisions/$BAD_RID/preview" '{}' | body_of \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print([c["type"] for c in d["evaluation"]["items"][0]["conflicts"]])'
echo "尝试采纳：HTTP $(req POST "/api/projects/$PID/revisions/$BAD_RID/accept" '{}' | code_of)"

echo
echo "=== 5. 采纳合法提议：同事务再核对 → 写入全部修订并推进字幕集版本 ==="
out="$(req POST "/api/projects/$PID/revisions/$RID/accept" '{}')"
echo "HTTP $(echo "$out" | code_of)"
echo "$out" | body_of | python3 -m json.tool --no-ensure-ascii | sed -n '1,25p'

echo
echo "=== 6. 已采纳提议重复提交 → 409，不再改字幕 ==="
req POST "/api/projects/$PID/revisions/$RID/accept" '{}' | body_of

echo
echo "=== 7. 提议历史 / 单提议详情（旧导出快照不受影响，可照常下载） ==="
req GET "/api/projects/$PID/revisions" | body_of | python3 -m json.tool --no-ensure-ascii
echo "单提议（含原值快照 orig 与建议值 proposed）："
req GET "/api/projects/$PID/revisions/$RID" | body_of | python3 -m json.tool --no-ensure-ascii | sed -n '1,30p'

echo
echo "完成。"
