# 字幕校时工作台（Subtitle Timing Workbench）

把**逐词转写**（带起止毫秒）与**镜头切点**排版成符合规则的字幕，在浏览器里校对、锁定、确认后导出 **WebVTT**。本地运行：Node.js + Express + SQLite（better-sqlite3）+ 原生前端，无外部服务依赖。

## 功能

- **导入**：逐词转写 `words: [{text, start_ms, end_ms}]` + 镜头切点 `cuts: [ms]`。
  时间无效（开始 ≥ 结束、负值、非整数）或**倒序/重叠**的词段一律**拒绝导入**并逐条说明。
- **排版规则**：单条最大字数、最短显示时长（ms）、每秒最多字数，可随时修改。
- **排版保证**：按原词序覆盖全部词（每词恰好一次）、字幕互不重叠、不跨镜头切点、不缩短任何词本身的时段（只在空闲间隙内向后/向前扩展）。
- **冲突报告**：规则无法同时满足时，列出**受影响词段 + 冲突条件**（如"切点落在词内部"、"可用空间 450ms 小于最短时长 1000ms"），**不输出貌似完整的结果**，也不改动现有字幕。
- **锁定**：已校对的字幕可锁定 🔒，重新排版只改未锁定部分，锁定条原样保留。
- **逐词时间修正**：校对者发现逐词转写的时间偏差时，可按**词序号**提交一组起止毫秒修正，携带读取时字幕集 `sub_version`；提交只存原值快照（不动词与字幕），预览并列**受影响字幕、逐词原值/当前值/建议值与候选整版**，确认在同一事务内再次核对并**原子**更新词时间、对受影响的未锁定区间重排、推进字幕集版本。词序与词文本永不变更；序号不重复、时间为非负整数且起点早于终点，修正后全部词仍按序不重叠。锁定字幕文本与时间原样保留；未受影响字幕保留 ID、行版本与人工文本，受影响行换用新 ID；满足词完整覆盖、切点隔离与现行字数/时长/字速规则。无法兼顾锁定或排版约束时返回定位到**词/字幕**的原因（词与字幕均不变），版本过期返回当前值；已确认提议重复提交不再生效，既有导出快照保持不变。
- **批量修订提议**：校对者可对**同一项目的一组未锁定字幕**提交待采纳修订（逐项给出字幕 ID、读取时行版本、替代文本、可选起止毫秒、附说明）；**提交只保存原值与当时规则版本，不动正式字幕**。预览并列原值/当前值/建议值，按当前规则核对整组候选（词区间、词时段、切点、相邻字幕、字数/时长/字速），逐处指出冲突；采纳时在**同一事务**内再次核对目标仍存在且未锁定、行版本与规则版本，通过后整版校验并原子写入全部修订、推进字幕集版本——**任一过期或违规则整组不生效**并返回当前值与原因；已采纳提议重复提交不再改字幕，提议历史可查。
- **乐观锁**：规则与每条字幕都带版本号，过期提交返回 `409` 与当前内容；字幕集整体有 `sub_version`，重排/导出携带以防并发覆盖。
- **导出**：确认后生成按时间升序的 WebVTT，存为**不可变版本快照**，可随时再次下载；后续修改不影响旧文件。导出前会完整校验（含锁定字幕），违规则拒绝并列出问题。
- **多语言译文字幕**：按原时间轴维护多语言译文。校对者以**非空目标语言代号、字幕 ID、读取时行版本 `cue_version` 与译文版本 `version`**（新建传 0/省略）保存译文；查询逐行并列原文、译文与状态（`current`/`review`/`missing`）。同一语言每条当前字幕最多一份译文。译文**沿用源字幕起止与词区间**，接口不接受任何时间/切点/原文字段，且须满足当前**最大字数与字速**规则（时长随源行）。源字幕**文本/时间/词区间**变化 → 译文自动转**待复核**；仅锁定或展示顺序变化不使译文失效；重排删除的原行译文**留作历史**，新行视为缺译，**不按序号自动挪用**。校对者可在当前源行上确认待复核译文，过期版本或无效译文返回当前值与原因且不改数据。按语言导出前须确认当前每行均有有效译文且整版符合时间与切点约束，否则分类列出缺漏/待复核/无效/冲突且**不生成快照**；成功导出的译文 WebVTT 快照**不可变**，与原文导出相互独立。
- **多语批次交付**：把**原文 + 选定语言**冻结为同一时间轴的一个批次。提交当前字幕集版本、规则版本、**非空且不重复**的目标语言列表与各语言**逐行译文版本**；服务端在**一次事务**内核对源字幕整版结构与现行规则、每行译文为 `current` 且满足字数/字速、提交版本仍有效。任一语言**缺译/待复核/无效/版本漂移** → 按语言与字幕行返回原因，**整批不生成快照、不消耗任何导出序列版本号**。成功时在**原文导出序列**与**各语言译文导出序列**中各生成一个不可变 WebVTT 版本，并以**批次清单**关联文件、字幕集版本与规则版本；各文件时间轴一致，后续编辑不改变旧批次，批次清单可查询，文件经既有下载地址取得。

## 启动

### Docker（推荐，一条命令）

```bash
docker compose up --build
```

Dockerfile 负责安装依赖，启动时自动建表（`src/db.js`），数据库为空且 `SEED_DEMO=true` 时播种一个演示项目（含自动排版结果）。

### 本地开发

```bash
npm ci
npm start          # 或 PORT=8080 DB_PATH=./my.db node server.js
```

### 访问

打开 **http://localhost:3000**（本地 `npm start` 同理；`PORT` 环境变量可改端口）。

### 测试

```bash
npm test           # node:test，覆盖排版引擎与全部 API
```

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | HTTP 端口 |
| `DB_PATH` | `./data/subtitles.db`（容器内 `/data/subtitles.db`） | SQLite 文件路径，启动时自动初始化表结构 |
| `SEED_DEMO` | `true` | 数据库为空时播种"演示项目：江边茶馆"；设 `false` 关闭 |

Compose 默认把 SQLite 挂到命名卷 `subtitle-data` 持久化（含所有导出版本快照）。

## 使用流程

1. **导入**：粘贴 JSON（或点"载入示例"），填项目名则新建项目，留空则导入当前项目（已有字幕时需勾选确认覆盖）。`examples/sample.json` 是同款示例。
2. **设规则**：最大字数 / 最短时长 / 每秒字数 → 保存（版本号 +1）。
3. **排版**：点"重新排版（仅未锁定字幕）"。有冲突时红色面板逐条列出词段与原因，修正数据或放宽规则后重试。
4. **校对**：直接在列表里改文本/时间（保存时校验：不得缩短词时段、不得重叠、不得跨切点），校对好的点"锁定"。
5. **逐词时间修正（校对者流程）**：在左侧 ⑥ 面板按 JSON 提交一组词时间修正（或"填入所有词"后只保留要改的词），必须携带读取时的 `sub_version`；提交后自动打开预览，查看**受影响字幕**（将重排的未锁定行 / 含修正词的锁定行）、逐词原值/当前值/建议值与候选整版，全部通过时点"确认修正"（原子更新词时间+重排+推进版本；失败整组不变）。也可用 `examples/word-revisions-api.sh` 走纯 HTTP 流程。
6. **批量修订提议（校对者流程）**：在左侧 ⑤ 面板按 JSON 提交一组字幕修订（或"填入所有行"后删改；只针对未锁定字幕），提交后自动打开预览，逐项并列**原值 / 当前值 / 建议值**并标注每处冲突；全部通过时点"整组采纳"（原子写入，失败整组不生效）。也可用 `examples/revisions-api.sh` 走纯 HTTP 流程。
7. **导出**：点"确认当前字幕并导出 WebVTT"，生成 v1、v2…… 任意版本可随时重新下载。词修正确认与字幕修订采纳均不影响已生成的旧快照。
8. **多语言译文**：在左侧 ⑦ 面板填入语言代号（如 `en`）并"载入语言"，逐行对照原文保存译文；源行变更后状态变"待复核"，可"✓ 确认仍适用"或重新保存；全部有效后点"校验并导出该语言 WebVTT"，缺漏/冲突会分类列出且不生成快照。HTTP 流程见 `examples/translations-api.sh`。
9. **多语批次交付（本轮新增）**：在左侧 ⑧ 面板填目标语言列表（逗号分隔），点"填入模板"自动抓取各语言当前译文版本生成交付载荷，再点"校验并交付批次"：一次事务冻结原文 + 各语言为同一批次，右侧"交付批次清单"可查看并下载各文件。HTTP 流程见 `examples/delivery-api.sh`。

## API 摘要

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/projects` | 项目列表 |
| `POST` | `/api/projects` | 新建项目（可同时带 `words`/`cuts`/`rules`） |
| `GET` | `/api/projects/:id` | 项目完整数据（词、切点、规则、字幕、导出列表） |
| `POST` | `/api/projects/:id/import` | 替换转写与切点；已有字幕时需 `{"force": true}`（会清空字幕） |
| `PUT` | `/api/projects/:id/rules` | 改规则，需带当前 `version`，过期返回 `409` + 当前规则 |
| `POST` | `/api/projects/:id/layout` | 重排未锁定字幕，需带 `sub_version`；冲突返回 `422` + `conflicts` |
| `PATCH` | `/api/projects/:id/subtitles/:sid` | 编辑/锁定单条，需带行 `version`，过期返回 `409` + 当前行 |
| `POST` | `/api/projects/:id/exports` | 校验并确认导出（可带 `sub_version` 防呆），生成新版本快照 |
| `GET` | `/api/projects/:id/exports` | 导出版本列表 |
| `GET` | `/api/projects/:id/exports/:version` | 下载某版本 `.vtt`（内容创建后不变） |
| `POST` | `/api/projects/:id/revisions` | 提交一组待采纳修订：`{note?, items:[{subtitle_id, cue_version, text, start_ms?, end_ms?}]}`，保存原值/规则版本快照，**不改正式字幕** |
| `GET` | `/api/projects/:id/revisions` | 提议历史（pending/accepted、项数、快照版本） |
| `GET` | `/api/projects/:id/revisions/:rid` | 单个提议：逐项 `orig`（提交时原值）与 `proposed`（建议值，时间为 `null` 表示沿用原值） |
| `POST` | `/api/projects/:id/revisions/:rid/preview` | 只读预览核对：并列原值/当前值/建议值，按整版候选逐处列冲突（`evaluation.items[].conflicts`） |
| `POST` | `/api/projects/:id/revisions/:rid/accept` | 事务内再次核对并原子采纳；过期类（行版本/规则版本/已锁定/已消失/重复采纳）→ `409`，规则/结构违规 → `422`，均带 `current` 与每项 `reasons` |
| `POST` | `/api/projects/:id/word-revisions` | 提交一组逐词时间修正：`{note?, sub_version, items:[{word_idx, start_ms, end_ms}]}`，保存原值快照，**不改词与字幕** |
| `GET` | `/api/projects/:id/word-revisions` | 词修正提议历史（pending/confirmed、词数、快照版本） |
| `GET` | `/api/projects/:id/word-revisions/:wrid` | 单个提议：逐项 `orig`（读取时原值）/`current`（当前词，含文本）/`proposed`（建议值） |
| `POST` | `/api/projects/:id/word-revisions/:wrid/preview` | 只读预览：受影响字幕（`replaced`/`affected_locked`）、候选整版 `subtitles`（`origin=kept/new`）、逐项与整版冲突 |
| `POST` | `/api/projects/:id/word-revisions/:wrid/confirm` | 事务内再次核对并原子确认；过期类（字幕集版本/词漂移/词缺失/重复确认）→ `409`，锁定或排版不可兼顾 → `422`，均带 `current` 与每项 `reasons` |
| `GET` | `/api/projects/:id/translations` | 译文语言总览（各语言 current/review/历史条数与导出数） |
| `GET` | `/api/projects/:id/translations/:lang` | 单语言并列查询：逐行原文/译文/状态（`missing`/`current`/`review`）、现行规则 `invalid_reasons`、导出列表与历史译文 |
| `PUT` | `/api/projects/:id/translations/:lang/subtitles/:sid` | 保存/更新译文：`{text, cue_version, version?}`；新建 201 / 更新 200，行版本或译文版本过期 → `409`，译文超字数/字速 → `422` |
| `POST` | `/api/projects/:id/translations/:lang/subtitles/:sid/confirm` | 确认待复核译文：`{version}`；非 review → `422`、版本过期 → `409`、规则不通过 → `422`（均返回当前值且不改数据） |
| `POST` | `/api/projects/:id/translations/:lang/exports` | 校验并按语言导出译文 WebVTT；缺译/待复核/无效/整版冲突 → `422` 分类列出不生成快照（可带 `sub_version` 防呆，过期 → `409`） |
| `GET` | `/api/projects/:id/translations/:lang/exports` | 某语言译文导出快照列表 |
| `GET` | `/api/projects/:id/translations/:lang/exports/:version` | 下载某语言某版本译文 `.vtt`（内容创建后不变） |
| `POST` | `/api/projects/:id/deliveries` | 多语批次交付：`{sub_version, rules_version, languages[], versions:{lang:{字幕ID:译文版本}}}`；一次事务核对后在原文与各语言导出序列中各生成一个不可变版本并生成批次清单 |
| `GET` | `/api/projects/:id/deliveries` | 交付批次清单列表（含各文件版本号与既有下载地址） |
| `GET` | `/api/projects/:id/deliveries/:bid` | 单个交付批次清单 |

修订请求与核对说明：

- **提交拒绝（`400`）**：`items` 空组/缺字段、`subtitle_id` 重复、`text` 空、`start_ms/end_ms` 非非负整数或 `start ≥ end`（双侧给出时）。
- **提交状态校验（`422`）**：目标字幕不存在或已锁定；只给单侧时间时与原值合并后仍要求 `start < end`。
- **预览/采纳核对维度**：建议时间合法、不得缩短词区间对应词时段（开始 ≤ 首词开始、结束 ≥ 末词结束）、不与整组应用后的相邻字幕重叠、不跨镜头切点；以及当前规则的字数、最短时长、字速。还会核对行版本（`cue_version`）与规则版本（提交时快照 vs 当前）。
- **采纳原子性**：全部项通过才写入（每行 `version +1`、字幕集 `sub_version +1`、提议标记 `accepted`）；任一项失败整组回滚，响应里只含出问题的项及其 `current` 当前行与中文 `reasons`。
- **重复采纳**：已 `accepted` 的提议再次调用返回 `409 {already_accepted:true}`，不会再改字幕；历史与旧导出快照均可随时回看。
- 完整 curl 调用示例：`examples/revisions-api.sh`（新建项目→提交→预览→非法示例→冲突示例→采纳→重复采纳→历史）。

错误格式统一：`400` 请求非法（修订提交的空组/重复 ID/空文本/非法时间、批次交付的空语言列表/重复语言/缺版本表等，带 `errors`）；`404` 不存在；`409` 版本过期或重复采纳（带 `current` 与每项 `reasons`）；`422` 校验/冲突失败（带 `errors` 或 `conflicts`，每项含 `word_start`/`word_end` 与中文说明；批次交付按 `languages[]` 逐语言逐行分类）。

## 排版约束与冲突处理

对每条字幕强制满足：文本 ≤ `max_chars` 字、时长 ≥ `min_duration_ms`、字数/秒 ≤ `max_cps`；
对整版强制满足：词全覆盖且顺序不变、字幕不重叠、不跨切点、词时段不被缩短。
词是不可拆分的最小单元，因此会出现规则确实无法同时满足的情况，例如：

- 切点落在某个词的时段内部（跨切点 ↔ 缩短词时段，二者必违其一）→ 报 `cut_inside_word`；
- 单个词超过最大字数 → 报 `max_chars`；
- 词段太密，最短时长/每秒字数在相邻字幕与切点夹出的空间内放不下 → 报 `duration`（含所需毫秒数与可用空间）。

此时接口返回 `422` 与完整冲突列表，**不写入任何字幕**；调整切点、规则或转写后重新排版即可。

## 批量修订提议（校对 → 预览 → 采纳）

面向校对者的**组级、乐观锁、原子采纳**流程，与既有单条编辑接口并存、互不影响：

1. **提交** `POST /api/projects/:id/revisions`
   `{note?, items:[{subtitle_id, cue_version, text, start_ms?, end_ms?}, ...]}`
   - 仅针对**未锁定**字幕；`start_ms`/`end_ms` 可省略（表示沿用该行当前起止，单侧给出时另一侧也按原值）。
   - 空组、重复 `subtitle_id`、空 `text`、非法时间（非整数、负值、`start ≥ end`）→ `400`，逐项中文说明；目标不存在/已锁定 → `422`。
   - 服务端保存每项的**原值快照**（文本/起止）、行版本 `cue_version` 与当时**规则版本**、字幕集版本；此步**绝不修改正式字幕**。
2. **预览** `POST /api/projects/:id/revisions/:rid/preview`（只读）
   把整组建议应用到当前字幕形成"候选整版"，逐项并列 `orig`（提交时原值）/`cue`（当前行）/`proposed`（建议值），并核对：
   建议时间合法、**词区间**不被缩短（开始 ≤ 首词开始、结束 ≥ 末词结束）、不与候选整版的**相邻字幕**重叠、不跨**镜头切点**、文本字数 ≤ `max_chars`、时长 ≥ `min_duration_ms`、字速 ≤ `max_cps`；
   同时标注行版本过期（`stale`）、规则版本过期、目标已锁定（`locked`）、目标已消失（`missing`）。每处冲突都带中文说明。
3. **采纳** `POST /api/projects/:id/revisions/:rid/accept`
   在**同一个 SQLite 事务**里重新读取权威当前状态并再次执行第 2 步的全部核对，外加写入后的整版结构/规则自检：
   - 全部通过 → 写入全部修订、每行 `version +1`、字幕集 `sub_version +1`、提议置为 `accepted`；
   - 任一过期/失效（行版本、规则版本、已锁定、已消失、重复采纳）→ `409`，带 `current` 当前整版与每项当前值、原因；
   - 任一规则/结构违规 → `422`，同样逐项给出原因；两种失败都**整组不生效（事务回滚）**。
4. **历史** `GET …/revisions`、`GET …/revisions/:rid`：提议与原值快照长期可查；已采纳提议重复 accept 返回 `409 {already_accepted:true}`，不会再改字幕；此前的导出快照内容不变。

前端在左侧 ⑤ 面板可直接提交（"填入所有行"会把未锁定行连同当前行版本生成模板），右侧查看历史、预览差异并一键整组采纳；纯 HTTP 流程见 `examples/revisions-api.sh`。

## 逐词时间修正（校对 → 预览 → 确认）

面向校对者修正**逐词转写本身**的时间偏差（与字幕文本无关，词序、词文本永不变更），同样是组级、乐观锁、原子流程：

1. **提交** `POST /api/projects/:id/word-revisions`
   `{note?, sub_version, items:[{word_idx, start_ms, end_ms}, ...]}`
   - `sub_version` 为校对者读取字幕集时的版本；`word_idx` 是词序号（从 0 开始），同组不得重复；
     `start_ms/end_ms` 必须是非负整数且 `start < end`；应用到当前词序列后全部词仍须按序、互不重叠。
   - 形状非法 → `400`（逐项中文说明）；`sub_version` 过期 → `409`（返回当前词与字幕）；
     词序号越界 / 修正后词序重叠 → `422`。三类拒绝都**不保存提议**。
   - 服务端保存每词的**原值快照**与字幕集版本；此步**绝不修改正式词与字幕**。
2. **预览** `POST /api/projects/:id/word-revisions/:wrid/preview`（只读）
   - 逐项并列 `orig`（读取时原值）/`current`（当前词文本与时间）/`proposed`（建议值），标注 `ok`/`drifted`（词在读取后被改过）/`missing`（重新导入后词序号不存在）；
   - 给出**受影响字幕**：`replaced`（词区间含修正词、将被删除重排的未锁定行）与 `affected_locked`（含修正词、须原样保留的锁定行）；
   - `subtitles` 为应用后的**候选整版**：`origin=kept` 的行保留 ID/行版本/人工文本/时间（锁定行与未受影响行），`origin=new` 的行为受影响区间按当前规则重排出的新行（新 ID）。
   - 逐处冲突定位到词：`locked_word_span`（修正把词推出锁定字幕边界）、`locked_cut_inside_word`（修正把镜头切点包入锁定字幕覆盖的词内）、`cut_inside_word`、`duration`、`max_chars`、`max_cps`、`word_overlap` 等。
3. **确认** `POST /api/projects/:id/word-revisions/:wrid/confirm`
   在**同一 SQLite 事务**里重新读取权威当前状态并再次执行第 2 步全部核对，外加写入后的整版结构/规则自检：
   - 全部通过 → 更新修正词时间、删除受影响未锁定字幕并按候选重排（新行新 ID/新版本）、保留行仅更新 `idx`（ID/行版本不变）、`sub_version +1`、提议置为 `confirmed`；
   - 过期/失效（字幕集版本、词漂移、词缺失、重复确认）→ `409`，带当前词与字幕及每项原因；
   - 锁定或排版规则不可兼顾 → `422`，原因定位到词/字幕。两种失败都**整组回滚，词与字幕均不变**。
4. **历史** `GET …/word-revisions`、`GET …/word-revisions/:wrid`：提议与原值快照长期可查；已确认提议重复 confirm 返回 `409 {already_confirmed:true}`；此前的导出快照内容不变。

前端在左侧 ⑥ 面板提交（"填入所有词"会带当前 `sub_version` 与全部词的当前时间，删掉不改的词即可），右侧查看历史、受影响字幕与候选整版差异后一键确认；纯 HTTP 流程见 `examples/word-revisions-api.sh`。

## 多语言译文字幕（保存 → 复核 → 按语言导出）

译文**按原时间轴**维护：不复制/编辑时间，不携带词、切点、原文，只锚定"当前源字幕行"。同一项目可维护任意多种语言（代号如 `en`、`ja-JP`、`pt_BR`），同一语言每条当前字幕最多一份非历史译文。

### 状态机

| 状态 | 含义 | 可否导出 |
|---|---|---|
| `current` | 已保存且源文本/时间/词区间与保存快照一致 | 还须满足现行字数/字速规则才可导出 |
| `review` | 保存后源字幕**文本/时间/词区间**发生变化（单条编辑、修订采纳、词修正确认、重排更新） | 否，须校对者确认或重新保存 |
| `history` | 源行被重排删除或项目重新导入（`subtitle_id` 置空） | 否，仅留档；新排版的行是**缺译**，绝不按序号挪用 |

仅**锁定切换**（`locked`）或**展示顺序**（`idx`）变化不会使译文失效；重排时词区间相同且文本/时间一致的未锁定行会保留 ID 与行版本（身份保持），词区间相同但内容被重排改变的行版本 +1 并令译文转 `review`。规则本身收紧不会立即改写状态，但查询/导出会按现行规则动态把译文标记为无效（`invalid_reasons`），此时导出同样被拒绝。

### API 流程

1. **保存/更新** `PUT /api/projects/:id/translations/:lang/subtitles/:sid`
   `{"text":"Hello world","cue_version":1,"version":0}`
   - `cue_version` 为读取时源字幕行版本；`version` 为译文版本，新建省略或传 `0`，更新必须传当前值。
   - 成功：新建 `201`、更新 `200`，译文状态为 `current` 并记录源快照（原文/起止/词区间/行版本）。
   - `400` 语言代号非法/空译文/缺行版本；`404` 字幕不存在；`409` 行版本或译文版本过期（带 `current`）；
     `422` 译文超 `max_chars` 或沿用源行时间算出超 `max_cps`（不改任何数据）。
2. **并列查询** `GET …/translations/:lang`（只读）
   返回 `entries[]`：`cue`（原文/起止/词区间/行版本）、`translation`（无则 `null`）、`state`、`valid`、
   `invalid_reasons`（现行字数/字速中文原因），以及 `counts`、该语言 `exports` 与 `history` 历史译文。
3. **源变更联动**：单条编辑、重新排版、批量修订采纳、逐词修正确认、重新导入都会在事务内统一对账：
   变化行译文转 `review`、删除行译文留 `history`。
4. **确认待复核** `POST …/translations/:lang/subtitles/:sid/confirm`，`{"version":1}`
   校对者对照当前原文核对后确认：刷新源快照、转回 `current`、译文版本 +1；
   非 `review` → `422`；译文版本过期 → `409`；译文按现行规则无效 → `422`（返回当前值与原因，不改数据）。
   也可不确认、直接重新 `PUT` 一版新译文（带行版本与当前译文版本）。
5. **按语言导出** `POST …/translations/:lang/exports`（可带 `sub_version` 防呆）
   - 先做源整版结构（词覆盖/不重叠/不跨切点/不缩短词时段）与现行规则校验，再核对每行均有 `current` 且合规的译文；
   - 不通过 → `422` 分类返回 `missing`（缺译）、`review`（待复核）、`invalid`（译文超规则）、`conflicts`（整版冲突），**不生成快照**；
   - 通过 → 译文沿用源行起止生成按时间升序的 WebVTT，存为该语言独立递增的不可变快照；
     `GET …/translations/:lang/exports` 列版本、`GET …/translations/:lang/exports/:version` 下载，
     后续修订不影响旧文件。各语言版本号独立；原文导出 `POST /api/projects/:id/exports` 流程保持不变。
6. **语言总览** `GET …/translations`：每种语言的 current/review/历史条数与导出数。

纯 HTTP 完整示例：`examples/translations-api.sh`（新建项目→保存→乐观锁与非法示例→并列查询→锁定/源变更失效→确认→重排历史与缺译→导出拒绝→双语言导出与快照下载）。浏览器内使用左侧 ⑦ 面板：填语言代号「载入语言」后逐行保存/确认，右上按钮校验并导出。

## 多语批次交付（冻结原文 + 多语 → 批次清单）

面向交付环节：当各语言译文都已就绪，把**原文与选定语言冻结为同一时间轴的一个批次**，一次事务生成全部文件，避免逐语言导出时源字幕被改动导致各文件时间轴不一致。

### 交付请求

`POST /api/projects/:id/deliveries`

```json
{
  "sub_version": 3,
  "rules_version": 1,
  "languages": ["en", "fr"],
  "versions": {
    "en": { "12": 2, "13": 1 },
    "fr": { "12": 1, "13": 3 }
  }
}
```

- `sub_version` / `rules_version`：读取时的字幕集版本与规则版本（乐观锁）；
- `languages`：**非空且不重复**的目标语言列表；
- `versions`：**每种语言每行**的译文版本（`versions.<lang>.<字幕ID> = 译文版本`），即校对者逐行核对过的版本。

### 服务端核对（一次事务内）

1. 源字幕整版结构（词覆盖/不重叠/不跨切点/不缩短词时段）与**现行规则**；
2. 每种语言当前每行译文为 `current` 且满足现行**字数/字速**；
3. 提交的 `sub_version`、`rules_version` 与**逐行译文版本**仍有效（未漂移）。

失败响应：

- `400` 请求形状非法：空语言列表、重复语言、非法语言代号、缺某语言的版本表、版本非正整数等（带 `errors`）；
- `409` 字幕集版本或规则版本漂移（带 `current` 当前值）；
- `422` 逐语言逐行问题：`languages[]` 按语言给出 `missing`（缺译）、`review`（待复核）、`invalid`（译文超规则，带原因）、`stale`（译文版本漂移，带提交值与当前值）、`unknown`（版本表引用了当前整版不存在的行），`conflicts` 给出源整版结构/规则冲突。

**任何失败都整批不生成快照、不消耗任何导出序列的版本号。**

### 成功结果（`201`）

- 在**原文导出序列**（`exports`）生成一个版本，在**每种语言译文导出序列**（`translation_exports`）各生成一个版本——全部沿用同一源时间轴，内容创建后不可变；
- 生成**批次清单**（`delivery_batches` + `delivery_batch_files`），关联各文件、冻结时的字幕集版本与规则版本；
- 响应即清单：`files[]` 给出 `kind`（`source`/`translation`）、`lang`、`version` 与 `download_url`；文件经**既有下载接口**取得（`GET /api/projects/:id/exports/:version`、`GET /api/projects/:id/translations/:lang/exports/:version`），下载约定不变；
- 批次清单可查询：`GET /api/projects/:id/deliveries`（列表）、`GET /api/projects/:id/deliveries/:bid`（单个）；项目载荷 `GET /api/projects/:id` 也携带 `deliveries`；
- 后续编辑/重排/新交付都**不改变旧批次**；既有原文导出与单语言导出照常使用，版本号在各自序列上继续递增（批次生成的版本也出现在既有导出列表中）。

纯 HTTP 完整示例：`examples/delivery-api.sh`（缺译拒绝→版本漂移→成功交付→清单查询→下载核对时间轴→编辑后旧批次不变）。浏览器内使用左侧 ⑧ 面板：填语言列表后「填入模板」自动抓取各语言当前译文版本，再「校验并交付批次」。

## 目录结构

```
server.js            入口：初始化 SQLite、播种演示数据、启动 HTTP
src/db.js            连接与建表（projects/words/shots/rules/subtitles/exports/revisions/revision_items/word_revisions/word_revision_items/translations/translation_exports/delivery_batches/delivery_batch_files）
src/layout.js        排版引擎（纯函数）：切点分析 → 分段 → 定时 → 结构自检
src/validate.js      导入与编辑校验
src/revision.js      批量字幕修订提议：请求解析 + 整组候选核对（词区间/时间/切点/相邻/规则/版本）
src/word-revision.js 逐词时间修正：请求解析 + 候选整版核对（词序重叠/锁定边界/受影响区间重排/规则/版本）
src/translation.js   多语言译文字幕：解析/规则校验/并列视图/失效对账（current→review/history）/导出核对
src/delivery.js      多语批次交付：请求解析 + 一次事务核对（源整版/逐行译文/版本漂移）与批次清单生成
src/vtt.js           WebVTT 序列化（原文与译文导出共用）
src/routes.js        Express API
public/              前端（原生 HTML/CSS/JS 单页，含字幕修订、逐词修正、多语言译文与批次交付面板）
examples/sample.json 示例转写与切点
examples/revisions-api.sh 批量字幕修订提议的完整 curl 调用示例
examples/word-revisions-api.sh 逐词时间修正（提交→预览→确认）的完整 curl 调用示例
examples/translations-api.sh 多语言译文字幕（保存→查询→失效/复核→确认→按语言导出）的完整 curl 调用示例
examples/delivery-api.sh 多语批次交付（保存译文→交付→清单查询→下载核对→旧批次不变）的完整 curl 调用示例
test/                node:test 单元 + API 集成测试（revision / word-revision / translation / delivery 覆盖四类流程）
Dockerfile / docker-compose.yml
```
