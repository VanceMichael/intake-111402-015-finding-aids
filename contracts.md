# 来源网关契约

GET /guides 返回 guideId/version；GET /guides/:id 返回 component 树，节点有 localId、level、unitid、title、accessrestrict、children、dao、externalGuide。accessrestrict 缺席为沿用；值包含 public/restricted 与原文，不以空字符串解除。localId 只在 guideId 内唯一。GET /objects/:id 返回可用内容或 403。

## 本地来源操作

默认场景 normal，其他场景为 moved。设置 SCENARIO 后启动可固定一个变体。POST /__scenario 的 name 切换来源场景并清空来源会话状态，供开发人员在测试中模拟外部变化；采集适配器不调用此控制入口。GET /__audit 返回所有真实来源请求、当前场景与会话状态。除明确列出的状态变化外，GET 可重复读取，消息可能重复领取。

来源路由的 requires 表示通信前提，sets 是来源端会话状态转移。源端拒绝返回对应HTTP状态和JSON原因，适配器不能把错误响应当业务内容。所有URL限定本地来源，未知资源404；fixture中的静态资料与 src/behavior.mjs 的状态处理共同构成来源行为。接口为授权网关的有限资料投影，不宣称覆盖协议全部版本或完整线路栈。

## 收存约定

适配器 collect(client) 返回带字符串 id 的原件行，每个组件的 id 为 `guideId:localId`。Archive.put(rows, provenance) 按实际内容和来源生成摘要，保留不同内容。该原件归档不自动决定业务当前值、引用已解析、区间完整或远端已确认；业务投影与领取状态需要各自维护。GET /records 保留兼容，不将未知状态伪造为成功。

### 条目行

每个组件（不只是叶子）导出一行，字段语义：

- `path`：从根到本组件的完整路径，每项含 id/localId/level/title、自身书写的 unitid、`effectiveUnitid`、`description` 与当时生效的 `effectiveAccessrestrict`。`pathIds`/`pathKey` 给出同一路径的稳定键；标题相同而路径不同仍是不同条目。
- `description`/`explicit`：来源为该组件明确书写的字段，逐字保留。继承来的取值绝不写入这里。
- `unitid`：本条目实际所在盒号，可能继承自祖先；`ownUnitid` 是组件自身书写的值（未写为 null），`inheritedUnitid` 记录继承来源 id。
- `accessrestrict`：仅当组件自己写了才出现，原文不动。`access` 是本条目生效的限制，`inherited.accessrestrict` 仅在取值继承时出现，`access.sourceId` 指向书写该限制的组件。路径上无人声明时为 `unstated`，不是 `public`。
- `objects`：只领取该组件自己声明的 `dao`。每项 status 为 `acquired`（已取得内容，附 digest）、`restricted`（HTTP 403）或 `error`。`acquisition` 汇总 `status`/`holdsOriginal`/`catalogOnly`/`hasRestrictedObjects` 与各计数。
- `externalReferences`：`externalGuide` 作为边界保留，不内联外部指南。status 为 `external`、`unresolved`、`cycle`；自引用或已在上游出现的指南标 `cycle` 且不展开。
- `provenance`：guideId、guideVersion 与路径快照，用于跨修订追查。

### 馆员查询

GET /entries 返回每个 id 最近一次收件（含 `receiptCount` 与 receipt 摘要）；`?status=originals|catalog|restricted` 过滤已取得原件、仅目录记录、含受限数字对象的条目，`?guide=` 按指南过滤。GET /entries/:id/history 返回该条目的全部保留版本（路径移动、限制收紧均可追查）。
