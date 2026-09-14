# sewfit-api — 家用缝纫机配件防撞试配 API

面向家用机械缝纫机修补旧衣的场景：压脚、针板、转换柄多年混放、标签脱落，
本服务提供**纯后端防撞试配**能力——在真正装机之前，用尺寸数据判定
“这套压脚 + 针板 + 转换柄，跑这条针路，会不会撞”。

技术栈：Node.js · TypeScript · Fastify · Zod · SQLite（sql.js，纯 WASM，无原生编译依赖）。

## 快速开始

```bash
npm install
npm run dev        # tsx watch，默认监听 0.0.0.0:3000
```

其它脚本：`npm run typecheck`（类型检查）、`npm run build`（编译到 dist/）、`npm start`（运行编译产物）。
数据文件默认在 `data/sewfit.sqlite`，可用环境变量 `DB_PATH` 覆盖（`:memory:` 表示纯内存）。
端口用 `PORT` 覆盖。

## 领域模型

### 机器（Machine）
| 字段 | 含义 |
|---|---|
| `presserBarStandard` | 压脚杆制式：`low_shank` / `high_shank` / `slant_shank` / `snap_on` |
| `needleRangeMm` | 针位范围 `{min, max}`（mm，相对针板中心，横向） |
| `maxSwingMm` | 最大摆幅（mm） |
| `feedMode` | 送料方式（字符串，由调用方约定，如 `drop_feed`） |

各制式的名义安装高度内置（低柄 12.7 / 高柄 25.4 / 斜柄 16.5 / 卡扣 12.7 mm），
机器侧接口固有公差 0.2 mm；针板座名义高度为 0。

### 配件（Accessory）
三类：`foot`（压脚）、`plate`（针板）、`adapter`（转换柄）。

- 压脚 / 针板：`openingContour`（开口轮廓多边形顶点，mm）、`mountingHeightMm`（安装高度）、
  `toleranceMm`（尺寸误差 ±，同时作用于轮廓与高度）、`needleTypes`（适用针型）、
  `allowedStitches`（允许线迹）、`feedModes`（适用送料方式，可空=不限）；
  压脚另有 `mountStandard`（安装柄制式）。
- 转换柄：`fromStandard` → `toStandard`、`heightOffsetMm`（高度修正）、`toleranceMm`。

`code`（配件编号）可不填，服务自动生成 `F-0001` 之类；编号用于候选定解的终极次序。

### 防撞试配（POST /trial-fits）

提交 `machineId`、`stitch`、`needleType`（如 `"90/14"`，自动解析针径；解析不了需传
`needleDiameterMm`）与本次线迹的**连续针路** `needlePath`（落针点序列，mm）。

判定流程：

1. **针路须落在机器能力内**：针位范围与最大摆幅，超出返回 422。
2. **枚举全部“压脚 × 针板”组合**，在配件库中搜索机器制式→压脚制式的转换链
   （0~2 节）：链不存在 → `mount_chain_missing`；链不唯一 → `mount_chain_ambiguous`。
3. **安装高度相容**：按尺寸区间的最不利端判定——
   `|压脚高度 − (制式高度 + Σ转换柄偏移)| ≤ 压脚公差 + Σ转换柄公差 + 机器接口公差`，
   针板同理（相对针板座 0）。
4. **扫掠包络**：针路折线按针半径膨胀后，须同时落在压脚与针板开口内
   （开口按各自公差向内收缩，即区间最不利组合）。
   等价为：针路到开口边界的最小有符号距离 ≥ 针半径 + 公差。

可行候选按以下次序定解：**转换件更少 → 最大高度偏差更小 → 最小净距更大 →
配件编号序列字典序**。

碰撞组合在 `failures` 中返回：`reason` 及（对 `envelope_collision`）
**最早针位** `earliestNeedleIndex` / `needlePosition`、**责任边界**
`responsibleBoundary`（哪个配件的哪条轮廓边）、**余量** `marginMm`（负值=侵入量）。

### 试装会话（Session）

`POST /sessions` 用一组可行方案（机器 + 压脚 + 针板 + 转换柄序列 + 针路）创建会话；
创建时重新校验：安装链唯一且与所给转换柄序列一致、组合可行。
同一机器若已有未完成会话，新会话创建时旧会话即过期（针路/方案已变更）。

会话步骤顺序固定，必须依次确认：

```
power_off（断电）→ needle_up（抬针）→ swap_parts（换件）
→ handwheel_full_turn（手轮完整转一周）→ low_speed_sew（低速试缝，通电步骤）
```

- `POST /sessions/:id/confirmations` `{step}`：确认下一步；乱序返回 409。
  **未完成手轮检查不得进入通电步骤**（顺序约束 + 显式兜底双重保证）。
- `POST /sessions/:id/undo`：撤回最近一次确认（已完成会话不可撤回）。
- **过期**：配件或机器被修改（版本变化）后，引用它们的未完成会话过期
  （修改时主动过期 + 访问时惰性复核）。
- **完成**：确认最后一步后，会话冻结——保存完整输入快照（机器、配件、针路、
  方案指标）与方案哈希 `solutionHash`（SHA-256，对规范化后的输入与指标计算），
  之后不可再确认或撤回。

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/machines` | 登记机器 |
| GET | `/machines` / `/machines/:id` | 查询机器 |
| PUT | `/machines/:id` | 修改机器（版本 +1，使相关未完成会话过期） |
| POST | `/accessories` | 录入配件 |
| GET | `/accessories?kind=foot` / `/accessories/:id` | 查询配件 |
| PUT | `/accessories/:id` | 修改配件（版本 +1，使相关未完成会话过期） |
| POST | `/trial-fits` | 防撞试配：返回定解候选与碰撞明细 |
| POST | `/sessions` | 创建试装会话 |
| GET | `/sessions?status=&machineId=` / `/sessions/:id` | 查询会话 |
| POST | `/sessions/:id/confirmations` | 确认下一步骤 |
| POST | `/sessions/:id/undo` | 撤回最近确认 |

错误统一为 `{ "error": { "code", "message", "details?" } }`。

## 示例

```bash
# 登记机器
curl -X POST localhost:3000/machines -H 'Content-Type: application/json' -d '{
  "presserBarStandard": "low_shank",
  "needleRangeMm": {"min": -4.5, "max": 4.5},
  "maxSwingMm": 7, "feedMode": "drop_feed"}'

# 录入压脚（开口 ±3 × ±6 mm，低柄直装）
curl -X POST localhost:3000/accessories -H 'Content-Type: application/json' -d '{
  "kind": "foot", "code": "F-A", "mountStandard": "low_shank",
  "openingContour": [{"x":-3,"y":-6},{"x":3,"y":-6},{"x":3,"y":6},{"x":-3,"y":6}],
  "mountingHeightMm": 12.7, "toleranceMm": 0.15,
  "needleTypes": ["90/14"], "allowedStitches": ["straight","zigzag"]}'

# 试配一条之字针路
curl -X POST localhost:3000/trial-fits -H 'Content-Type: application/json' -d '{
  "machineId": "<机器id>", "stitch": "zigzag", "needleType": "90/14",
  "needlePath": [{"x":-2,"y":0},{"x":2,"y":2},{"x":-2,"y":4}]}'
```
