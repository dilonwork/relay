# Agent 工單系統設計文件

> 文件版本：v1.1（已鎖定四項決定，其餘章節為在此基礎上的設計展開）
> 日期：2026 年 11 月 11 日
> v1.1 新增：第 11 章帳號、認證與管理（2026 年 11 月 11 日鎖定並實作）
> v1.2 新增：第 15 章自訂 Workflow：狀態機編輯器（2026 年 11 月 12 日）
> 適用範圍：Project 需求開發流程為主線；值班（On-Call）告警為工單來源之一，共用同一條流水線

以工單流水線串起專案開發流程：PM 建立需求，Leader 拆解，工程師開發，依序經過 Review、測試與部署，最後交付。每個 Agent 只接自己職責內的工單，每次狀態轉換都可回溯。

## 已鎖定的決定

| 決定 | 內容 | 展開章節 |
| --- | --- | --- |
| 開發鏈狀態 | 需求 → 拆解（待澄清來回）→ 開發 → Review → 測試（待驗收澄清來回）→ 部署 → 已交付，另設已取消終點 | 第 5 章 |
| 誰能切狀態 | PM、Leader、工程師、Reviewer、Tester、Deployer 各認自己的轉換；不得審自己的 code | 第 6 章 |
| 工單存放 | PostgreSQL 獨立資料庫，與 WebTracker 資料庫分開、同台 PostgreSQL | 第 8 章 |
| 帳號與認證 | 帳號持有多個角色；密碼 scrypt 雜湊；7 天 Bearer 會話；首次啟用建第一位管理者；管理者可管帳號與看全系統概覽，但不繞過流程角色檢查 | 第 11 章 |
| Agent 接入 | Agent 以 API 金鑰登入，繼承帳號角色；試行階段的接單佇列限拆解與開發兩段；兩段交接必填交接說明 | 第 12 章 |

## 目錄

1. 目的與設計原則
2. 系統定位與工單來源
3. 已鎖定決定總覽
4. 角色與職責
5. 開發鏈狀態機
6. 狀態轉換權限
7. 回溯與稽核
8. 資料模型與儲存
9. Agent 接單與交接規則
10. 實作分期與未決事項
11. 帳號、認證與管理
12. Agent 接入（第二期）
13. PM 監控（防卡住）
14. 自訂 Workflow
15. 自訂 Workflow：狀態機編輯器
- 附錄 A 狀態代碼對照
- 附錄 B 工單生命週期範例

---

## 1. 目的與設計原則

本系統要解決的問題很單純：工作在人與 Agent 之間流轉時，常常靠口頭或訊息交接，誰接了、做到哪、為什麼退回，事後無從查起。本系統借用 Jira 式的工單概念，把每一件工作做成一張工單，交接一律透過工單的狀態轉換完成，轉換本身即是紀錄。

### 五項原則

- **各守其分。**每個 Agent 與每個角色都有明確職責，只接取與自己工作相關、且處於自己負責狀態的工單；不屬於自己領域的單不碰、不代切。
- **狀態即交接。**工作往下走的唯一方式是切換工單狀態。狀態一變，負責人隨之而變，佇列也隨之而變，不另設私下交接管道。
- **每次轉換可回溯。**每一次狀態轉換都寫入稽核紀錄：誰、何時、從哪個狀態、切到哪個狀態、為什麼。整條歷史隨時可完整重播。
- **只補缺、不重做。**Agent 拉取資料與處理工單採增量：已有資料不重複處理，只補缺少的部分，除非使用者明確要求強制更新。
- **退回有路、取消有終點。**看不懂、審不過、測不過、部署失敗，都有定義好的退回路徑；需求作廢或重複開單時，以「已取消」收尾，不讓工單懸空。

## 2. 系統定位與工單來源

本系統的主線是 Project 的開發流程，不是值班系統。值班只是工單來源之一，與 Project 需求共用同一條開發鏈、同一套狀態與權限規則。

| 來源 | 進入方式 | 後續路徑 |
| --- | --- | --- |
| **Project（主來源）** | PM 建立需求工單，內容包含目標、範圍與驗收條件 | 進入完整開發鏈：拆解 → 開發 → Review → 測試 → 部署 → 交付 |
| **值班 On-Call** | 告警觸發或值班人員開立工單，附告警內容與初步證據 | 同樣進入開發鏈；若只需處置不需開發，仍以工單狀態記錄處置過程（細節見第 10 章未決事項） |
| **其他來源（預留）** | 未來新增來源時，只需定義「如何開單」與「初始狀態」 | 不另建流程，一律匯入同一條開發鏈 |

> **定位結論：**來源只決定工單怎麼出生，不決定工單怎麼流轉。流轉規則只有一套，就是第 5 章的狀態機與第 6 章的權限矩陣。

## 3. 已鎖定決定總覽

以下三項已於 2026 年 11 月 11 日逐項確認鎖定，第四項（帳號與認證）與第五項（Agent 接入）同日鎖定並實作，是本文件的地基。後續章節是這五項決定的展開與實作定義；若實作中需要改動任一項，應回到本章修訂版本，而不是在程式裡悄悄偏離。

| 決定 | 內容 | 展開章節 |
| --- | --- | --- |
| 開發鏈狀態 | 需求 → 拆解（待澄清來回）→ 開發（待開發 → 開發中）→ Review（待 Review → Review 中）→ 測試（待測試 → 測試中，驗收標準不清楚 → 待驗收澄清，PM 補充後回測試中）→ 部署（待部署 → 部署中）→ 已交付；另設已取消為終點。每個階段拆成「待接取 → 進行中」。 | 第 5 章 |
| 誰能切狀態 | 六個角色各認自己的轉換（詳見權限矩陣）。Reviewer、Tester、Deployer 可由工程師兼任，但不能審自己的 code；待澄清由 PM 補充後切回拆解中。 | 第 4、6 章 |
| 工單存放 | PostgreSQL 獨立資料庫：與 WebTracker 的資料庫分開，部署在同一台 PostgreSQL 上另開一個 database。不採用 Jira，也不寄存在 WebTracker 資料庫內。 | 第 8 章 |
| 帳號與認證 | 一個帳號持有一個或多個角色（含管理者角色）；密碼以 scrypt 加每人隨機鹽雜湊儲存；登入發 7 天有效的 Bearer 會話；首次啟用時由第一位管理者自行建帳號，建好後設定流程永久關閉；管理者可管理帳號與查看全系統概覽，但不能繞過第 6 章的流程角色檢查。 | 第 11 章 |
| Agent 接入 | Agent 以長期 API 金鑰登入（`rl_…`，`X-API-Key` 標頭），繼承帳號角色；接單佇列與交接必填先在拆解與開發兩段試行，交接是否足夠由下一手判斷。 | 第 12 章 |

---

## 4. 角色與職責

角色是權限的單位。人與 Agent 都以角色身分操作工單；同一個人或 Agent 可以擁有多個角色，但受第 6 章的兼任限制約束。角色附著在帳號上（第 11 章）：一個帳號持有一個或多個角色，轉換時系統檢查該帳號是否持有該轉換要求的角色。

| 角色 | 職責 | 主要佇列（只看這些狀態） |
| --- | --- | --- |
| **PM** | 建立需求、補充澄清、決定取消；在交付前掌握需求的最終去留 | 待澄清、自己開立的全部工單 |
| **Leader** | 把需求拆解為可執行的開發工作；不理解時退回待澄清；拆解完成後放行開發 | 需求、拆解中 |
| **工程師** | 接取開發工作並實作；完成後送 Review；開發單看不懂時可退回待澄清 | 待開發、開發中（自己負責的） |
| **Reviewer** | 審查程式變更，通過送測試，不過退回開發 | 待 Review、Review 中 |
| **Tester** | 執行測試，通過送部署，不過退回開發；驗收標準不清楚發回 PM 澄清 | 待測試、測試中、待驗收澄清 |
| **Deployer** | 執行部署，成功即交付，失敗退回測試 | 待部署、部署中 |

> **兼任規則（已鎖定）：**Reviewer、Tester、Deployer 可由工程師兼任，但任何人或 Agent 都不能審查、測試或部署自己開發的工單。此規則由系統在轉換時強制檢查，不能靠自律。

## 5. 開發鏈狀態機

開發鏈是一條單向主幹加三條退回路徑。每個執行階段都拆成「待接取」與「進行中」兩個狀態，讓佇列的接單點明確：工單停在待接取狀態，就是在等對應角色來接；進入進行中，就表示已有人或 Agent 認領。

```
需求 → 拆解中 ⇄ 待澄清 → 待開發 → 開發中 → 待 Review → Review 中
  → 待測試 → 測試中 ⇄ 待驗收澄清 → 待部署 → 部署中 → 已交付
```

退回路徑：Review 不過 → 回開發中；測試不過 → 回開發中；測試中驗收標準不清楚 → 待驗收澄清，PM 補充後回測試中；部署失敗 → 回測試中；拆解或開發看不懂 → 待澄清。任一非終點狀態，PM 可切至已取消。已交付與已取消為終點，不再轉出。

> **自訂 Workflow（第 14 章）：**各狀態的負責角色不一定是上表寫死的角色——專案的 active workflow 可以改寫每個狀態的負責角色（例如把待開發改成由 Tester 接取）。狀態機本身不變，只換「誰能切」；轉換角色改走 active workflow，cancel 維持 PM-only。

| 狀態 | 代碼 | 含義與進入條件 |
| --- | --- | --- |
| 需求 | `requirement` | PM 已開立，等待 Leader 開始拆解 |
| 拆解中 | `decomposing` | Leader 正在把需求拆成可執行的開發工作 |
| 待澄清 | `needs_clarification` | 需求或開發單資訊不足，等待 PM 補充；補充後回拆解中 |
| 待開發 | `pending_dev` | 拆解完成，等待工程師接取 |
| 開發中 | `in_dev` | 工程師已接取，正在實作 |
| 待 Review | `pending_review` | 開發完成，等待 Reviewer 接取 |
| Review 中 | `in_review` | Reviewer 正在審查 |
| 待測試 | `pending_test` | Review 通過，等待 Tester 接取 |
| 測試中 | `in_test` | Tester 正在測試 |
| 待驗收澄清 | `needs_acceptance_clarification` | 測試中驗收標準不清楚，等待 PM 補充；補充後回測試中，發回給原 Tester |
| 待部署 | `pending_deploy` | 測試通過，等待 Deployer 接取 |
| 部署中 | `deploying` | Deployer 正在部署 |
| 已交付 | `delivered` | 終點：部署成功，工作交付完成 |
| 已取消 | `cancelled` | 終點：需求作廢或重複開單，由 PM 切入 |

## 6. 狀態轉換權限

下表是完整的合法轉換清單。表上沒有的轉換一律禁止：系統收到未列出的轉換請求時直接拒絕，不寫入狀態，但要把這次被拒的嘗試記入稽核（見第 7 章）。每次轉換都必須附理由或產出說明，退回類轉換尤其不可省略。

| 執行角色 | 從 → 到 | 條件與必附內容 |
| --- | --- | --- |
| PM | （開立）→ 需求 | 附目標、範圍、驗收條件 |
| PM | 待澄清 → 拆解中 | 補充澄清內容後切回 |
| PM | 任一非終點狀態 → 已取消 | 限交付前；附取消原因（作廢或重複） |
| Leader | 需求 → 拆解中 | 開始拆解即切入 |
| Leader | 拆解中 → 待澄清 | 附不理解的具體問題 |
| Leader | 拆解中 → 待開發 | 拆解完成；附拆解出的開發工作清單 |
| 工程師 | 待開發 → 開發中 | 接取即切入，工單記錄負責人 |
| 工程師 | 開發中 → 待 Review | 附變更說明與自測結果 |
| 工程師 | 開發中 → 待澄清 | 開發單看不懂時使用；附疑問點 |
| Reviewer | 待 Review → Review 中 | 接取即切入；不得為該單的開發者 |
| Reviewer | Review 中 → 待測試 | 審查通過 |
| Reviewer | Review 中 → 開發中 | 審查不過；附退回理由與待改事項 |
| Tester | 待測試 → 測試中 | 接取即切入；不得為該單的開發者 |
| Tester | 測試中 → 待部署 | 測試通過；附測試結果 |
| Tester | 測試中 → 開發中 | 測試不過；附失敗項目與重現方式 |
| Tester | 測試中 → 待驗收澄清 | 驗收標準不清楚；附具體疑問，理由必填 |
| PM | 待驗收澄清 → 測試中 | 補充驗收標準，發回給原 Tester；理由必填 |
| Deployer | 待部署 → 部署中 | 接取即切入；不得為該單的開發者 |
| Deployer | 部署中 → 已交付 | 部署成功；附部署版本與驗證結果 |
| Deployer | 部署中 → 測試中 | 部署失敗；附失敗原因，退回測試重驗 |

> **強制檢查：**系統在執行每一筆轉換前，依序檢查四件事——專案範圍（已指派的帳號只能碰自己專案的工單，見第 12 章）、目前狀態是否允許這條轉換、執行者角色是否在上表內、是否違反「不得處理自己開發的工單」。任一項不過，轉換不成立。

> **自訂 Workflow（第 14 章）：**「執行者角色是否在上表內」這一項改走專案的 active workflow：轉換要求的角色是 active workflow 為該狀態指定的角色，不是上表寫死的角色；沒有 active workflow 時退回預設 workflow，再沒有則退回內建對照（與上表一致）。Cancel 維持 PM-only，不接受 workflow 改寫。

---

## 7. 回溯與稽核

回溯不是附加功能，而是本系統存在的理由之一。工單的目前狀態只是最新一筆轉換的結果；真正的歷史在轉換紀錄裡，必須完整、依序、不可竄改。

### 每一筆轉換紀錄包含

- **誰：**執行者識別（人員或 Agent 的 ID）與其當時使用的角色。
- **何時：**伺服器時間戳記，寫入後不得修改。
- **從何到何：**原狀態與新狀態的代碼各記一份，不依賴事後推算。
- **為什麼：**理由或產出說明。退回、取消、待澄清三類轉換必填，空白不得切換。交接說明（`handoff`）另記一欄：試行階段的兩段交接（拆解 → 待開發、開發中 → 待 Review）必填，其餘轉換可附可不附；見第 12 章。
- **附帶產出：**該步的交付物參照，例如拆解清單、變更說明、測試結果、部署版本。

### 稽核規則

- 轉換紀錄只可新增，不可修改或刪除；狀態欄位與紀錄在同一個資料庫交易內寫入，避免狀態變了卻沒有紀錄。
- 被拒絕的轉換嘗試也要留痕（標記為 rejected 並記原因），讓權限問題事後查得到。
- 任一工單都能以轉換紀錄重播完整生命週期：開立、每一次前進、每一次退回、最終交付或取消。
- 此設計與 WebTracker 既有的 agent_audit_log 概念一致，但工單稽核存放在工單自己的獨立資料庫內，不與 WebTracker 共用表格。

## 8. 資料模型與儲存

工單存放於 PostgreSQL 獨立資料庫：與 WebTracker 的資料庫分開，在同一台 PostgreSQL 上另開一個 database。好處是權限、備份與演進各自獨立，工單系統故障或改版不波及 WebTracker，反之亦然。

### 核心表格（綱要）

```
tickets
  id            UUID / 流水主鍵
  title         需求或工作標題
  source        project | oncall（未來可擴充）
  status        目前狀態代碼（見附錄 A）
  creator_id    開立者（PM 或來源系統）
  assignee_id   目前負責人（接取後寫入）
  developer_id  實際開發者（供兼任檢查使用）
  description   目標、範圍、驗收條件
  project_id    所屬專案；可空，未分類工單為空（專案視野）
  created_at / updated_at

ticket_transitions
  id            主鍵
  ticket_id     對應工單
  actor_id      執行者
  actor_role    執行時角色
  from_status   原狀態（開立時為空）
  to_status     新狀態
  reason        理由或產出說明
  handoff       交接說明（第 12 章：試行兩段交接必填，其餘可附）
  artifacts     附帶產出參照（JSON）
  result        applied | rejected
  created_at    伺服器時間戳記（不可改）
```

PM 監控另有一張提醒狀態表（第 13 章）：

```
monitor_reminders
  ticket_id           對應工單（主鍵，刪工單時連帶刪除）
  last_transition_id  目前卡住回合的最新 applied 轉換 id
  reminder_count      本回合已提醒次數
  last_reminded_at    上次提醒時間（未提醒為空）
  escalated_at        本回合升級時間（未升級為空）
  updated_at
```

自訂 Workflow 另有一張表（第 14 章）：

```
workflows
  id            UUID / 主鍵
  project_id    所屬專案；可空，空即全域預設 workflow（只有一筆預設）
  name          workflow 名稱；同一專案內唯一
  roles         JSONB：14 個狀態各一筆 {role, responsibilities}
  is_default    是否為全域預設 workflow（唯讀）
  is_active     是否為該專案目前生效的 workflow（每專案最多一筆）
  created_by    建立者帳號 ID
  created_at / updated_at
```

上表為綱要而非最終 DDL；欄位型別、索引與拆解子單的關聯方式（一個需求拆成多張開發單時，父子工單如何連結）在實作第一期定案，見第 10 章。

帳號與會話另有兩張表（第 11 章）：

```
users
  id            UUID / 主鍵
  username      帳號名稱，大小寫不區分且唯一
  password_hash scrypt 雜湊（格式 scrypt$鹽$雜湊），不存明文
  display_name  顯示名稱
  roles         角色陣列：pm / leader / engineer / reviewer / tester / deployer / admin 的子集
  project_id    指派的專案（Agent 指派，第 11–12 章）：可空，未指派即看全部專案；刪專案時清空
  is_active     停用後無法登入，既有會話立即失效
  created_at / updated_at

projects
  id            UUID / 主鍵
  name          專案名稱，唯一
  description   專案說明
  created_by    建立者帳號 ID
  created_at / updated_at

sessions
  token         Bearer 權杖（256 位元隨機值），主鍵
  user_id       對應帳號，刪帳號時連帶刪除
  expires_at    到期時間（登入起 7 天）
  created_at

API 金鑰另有一張表（第 12 章）：

```
api_keys
  id            UUID / 主鍵
  user_id       對應帳號，刪帳號時連帶刪除
  name          金鑰名稱（管理者自填，方便識別）
  key_hash      金鑰的 scrypt 雜湊，只存雜湊、不存明文
  key_prefix    金鑰前綴（rl_ 加前 4 碼），供列表識別與查詢
  created_at
  last_used_at  最近一次使用時間（資訊用）
  revoked_at    撤銷時間；有值即失效
```

### 隔離與存取

- 使用獨立的資料庫帳號與連線字串，不與 WebTracker 共用帳號；應用層只能透過工單系統自己的服務存取。
- 備份與還原獨立排程；還原測試時不得覆寫 WebTracker 資料庫。
- 未來若需在 WebTracker 介面顯示工單摘要，應透過 API 讀取，不直接跨資料庫連表查詢。

## 9. Agent 接單與交接規則

### 接單：只拉自己的佇列

- 每個 Agent 以角色身分訂閱佇列：佇列的定義就是「狀態屬於我負責的待接取狀態」的工單集合。例如工程師 Agent 只看 `pending_dev`，Reviewer Agent 只看 `pending_review`。
- 接取是原子操作：切入進行中狀態的同時寫入負責人，避免兩個人或兩個 Agent 同時接走同一張單。
- 增量處理：Agent 再次掃描佇列時，已處理、已在自己手上或已轉出的工單不重複處理，只補新進與缺少的部分；除非使用者明確要求，否則不做全量重抓、重做。
- 不屬於自己狀態的工單，即使看見了也不代為處理、不代切狀態；需要別人處理時，正確動作是完成自己這一步並正確交接。

### 交接：狀態加證據，缺一不可

- 交接 = 一次合法的狀態轉換 + 第 6 章該轉換要求的必附內容。必附內容缺失時，轉換應被系統擋下，而不是先切再補。
- 往前交接要附產出：拆解附工作清單、開發附變更說明、測試附結果、部署附版本與驗證。
- 往回交接要附理由：退回開發要寫明待改事項，退回待澄清要寫明具體疑問，部署失敗要寫明失敗原因。下一手的人不應該需要猜上一手為什麼退回來。
- 交接完成後，原負責人的工作即結束；工單後續的進展由新狀態的負責人承擔，原負責人可從轉換紀錄追蹤，但不介入。

> **一句話版本：**Agent 只認狀態、不認人。看到自己的狀態就接，做完就附證據切給下一手，切不過去就代表缺了東西，先補齊再切。

---

## 10. 實作分期與未決事項

### 建議分期（建議，尚未鎖定）

1. **第一期 · 地基：**建立獨立資料庫、工單與轉換紀錄表格、狀態機與權限的強制檢查、工單歷史查詢。先讓人能開單、切狀態、查回溯。
2. **第二期 · Agent 接入（已鎖定，2026 年 11 月 11 日）：**各角色 Agent 依佇列接單與交接，先從拆解與開發兩段試行，驗證交接內容是否足夠下一手使用。實作見第 12 章。
3. **第三期 · 來源擴充：**接上值班告警來源，並依使用情況決定是否需要通知、看板與統計。

### 未決事項（待拍板）

- 拆解的父子關係：一個需求拆成多張開發單時，用父工單加子工單，還是同一張單內的工作清單？影響第 8 章資料模型定案。
- 工單的優先級與分級欄位是否需要（例如嚴重度），以及是否影響接單順序。
- 值班來源的工單若只需處置、不需開發，是否走完整開發鏈，還是允許在特定狀態直接交付。
- 操作介面形式：先以 API 加簡單列表頁面，還是一開始就做完整的工單看板。
- 通知方式：狀態轉換後是否主動通知下一手負責人，透過哪個頻道。—— PM 監控（第 13 章）已回答其中一半：卡住偵測與提醒狀態由 server 提供，發送由 PM 值班 Agent 負責；其他狀態轉換的主動通知仍待定。

---

## 11. 帳號、認證與管理

> 本章已鎖定（2026 年 11 月 11 日），與第 3 章第四項決定一致。

第一期上線時請求由呼叫方自行申報身分，伺服器只驗權限矩陣；本章把「誰在操作」改為登入後的真實身分。身分不再由客戶端說了算：每一次開單與轉換的執行者，都是登入會話對應的帳號。

### 帳號與角色

- 一個帳號有一組使用者名稱（大小寫不區分、唯一）、顯示名稱、密碼，以及一個或多個角色。
- 角色共七種：六個流程角色（PM、Leader、工程師、Reviewer、Tester、Deployer）加一個管理者角色（`admin`）。管理者不是流程角色，不能用來切工單狀態。
- 一個帳號可同時持有多個角色，例如工程師兼 Reviewer。轉換時系統檢查帳號是否持有該轉換要求的角色；持有任一符合的角色即可，不需切換身分。
- 帳號可停用：停用後無法登入，既有會話立即失效。

### 密碼

- 密碼以 Node 內建 `crypto.scrypt` 加每人隨機鹽雜湊儲存，格式為 `scrypt$鹽$雜湊`；不引入雜湊函式庫，不存明文。
- 密碼至少 8 個字元。登入失敗時，不論是帳號不存在、密碼錯誤或帳號已停用，一律回覆同一則通用錯誤，不透露是哪一種。

### 會話

- 登入成功發一枚不透明 Bearer 權杖（256 位元隨機值），效期 7 天；客戶端每次請求帶 `Authorization: Bearer <權杖>`。
- 伺服器每次請求都檢查權杖是否存在、是否到期、對應帳號是否仍啟用；任一項不過即拒絕。
- 登出即刪除該會話。管理者重設某帳號密碼時，該帳號的全部會話一併撤銷，等於全裝置登出。

### 首次啟用：沒有預設帳號

- 系統不內建任何帳號或密碼。`users` 表為空時，前端顯示設定畫面；第一位管理者自行建立帳號（使用者名稱、顯示名稱、密碼）。
- 一旦存在任何帳號，設定流程永久關閉（再呼叫回 403）。第一位管理者同時持有 `admin` 與 `pm` 角色，建好後即可直接開單；角色之後可在管理介面調整。

### 管理者

- 持有 `admin` 角色的帳號可管理帳號（新增、改顯示名稱／角色／啟用狀態、重設密碼）與查看全系統概覽：帳號數量與清單（不含密碼雜湊）、各狀態工單數、轉換總數、最新 10 筆稽核紀錄、資料庫健康狀態。
- 管理者不能把自己鎖在門外：系統拒絕停用最後一位啟用的管理者，也拒絕拿掉其管理者角色。
- **管理者不繞過流程檢查。**要切工單狀態，管理者的帳號同樣必須持有該轉換要求的流程角色；`admin` 本身不能開單、不能審查、不能部署。管理者的權力是看得全、管帳號，不是跳過流程。

### 專案指派（Agent 指派）

- 管理者在管理介面可把一個帳號指派到一個專案（`users.project_id`，可空）；取消指派即恢復看全部專案。v1 一個帳號只指派一個專案，多專案指派不在範圍內。
- 指派以帳號為單位：API 金鑰繼承所屬帳號的指派，不另外指派。
- 公開的帳號資料含指派的專案（`project_id`，未指派為 null）。
- 指派不影響帳號的角色與啟用狀態；未指派的帳號（含各值班帳號）維持現行行為。

### 稽核裡的角色

- 轉換紀錄的 `actor_role` 記的是該次轉換實際行使的角色，也就是狀態機裡該轉換要求的角色；不是客戶端申報的值，也不是帳號持有的全部角色。
- 被拒的嘗試同樣留痕：有適用規則時記該規則的角色；沒有適用規則時，記該帳號持有的第一個流程角色；若帳號不持有任何流程角色，記 `pm`（稽核表要求必填六種流程角色之一，此為佔位值，原因欄會寫明拒絕理由）。

---

## 12. Agent 接入（第二期）

> 本章已鎖定（2026 年 11 月 11 日），與第 10 章第二期一致：各角色 Agent 依佇列接單與交接，先從拆解與開發兩段試行，驗證交接內容是否足夠下一手使用。

### API 金鑰

- Agent 程序不走密碼登入：管理者在管理介面為某個帳號發一枚長期 API 金鑰，格式為 `rl_` 加 32 個隨機十六進位字元，呼叫時帶 `X-API-Key` 標頭。
- 只存雜湊：金鑰以 scrypt 加隨機鹽雜湊儲存（與密碼同一格式），完整金鑰只在建立當下的回應裡出現一次，之後不再顯示、不記日誌、不存明文。列表只顯示名稱與前綴（`rl_` 加前 4 碼），供識別與查詢。
- 金鑰繼承帳號角色：金鑰登入的使用者與密碼登入是同一個帳號，流程角色檢查、不得審自己的 code、稽核紀錄完全相同；伺服器分不出呼叫方用的是會話還是金鑰，也不需分。金鑰不能用管理端點，除非其帳號持有 `admin` 角色。
- 撤銷即失效：管理者可隨時撤銷金鑰，撤銷後立即無法認證；停用帳號也使該帳號的全部金鑰失效。每次成功使用會更新金鑰的最近使用時間（資訊用，更新失敗不影響該次請求）。

### 接單佇列

- `GET /api/queue` 只回呼叫方目前能接的單：依呼叫方持有的角色篩選，每筆附上下一步轉換（去向、角色、種類、是否需要理由與交接說明）。前端有「Claimable」分頁顯示這個佇列。
- 「Claimable」分頁不多餘（2026 年 11 月 11 日，工單 6cac9d1f）：狀態分頁列出該狀態的全部工單（只受專案範圍限制，不論看的人持什麼角色、能不能接）；「Claimable」只列呼叫方依角色能接的單，多重角色的使用者一頁看到兩段待接單，且每筆附下一步轉換。試行範圍外的角色（Reviewer／Tester／Deployer）在此分頁永遠是空的，他們的待接單在各自的狀態分頁（待 Review／待測試／待部署）看。`GET /api/queue` 不得移除：Leader 與 Engineer 值班排程每 5 分鐘用它檢查佇列。
- 試行範圍限拆解與開發兩段：`requirement` 等 Leader 接手拆解，`pending_dev` 等工程師接手開發。進行中的狀態（拆解中、開發中等）已有負責人，不在佇列裡。
- 接取仍是原子操作：切入進行中狀態的同時寫入負責人（第 9 章），兩方無法同時接走同一張單。增量處理原則不變：Agent 再次掃描佇列時只補新進與缺少的部分，不重做已處理的單。

### 專案指派與範圍強制

- 已指派的帳號，其接單佇列（`GET /api/queue`）與工單列表（`GET /api/tickets`）只回傳該專案的工單；傳入其他專案的篩選條件也無法擴大範圍。未分類工單不在已指派帳號的範圍內。
- 已指派的帳號對其他專案工單的狀態轉換，伺服器端直接拒絕（403 `out_of_scope`），並如其他被拒嘗試一樣留稽核紀錄。範圍檢查在狀態、角色、不得審自己的 code 之前先執行（第 6 章）。
- 工單詳情（`GET /api/tickets/:id`）與轉換歷程（`GET /api/tickets/:id/transitions`）用同一條範圍檢查（`stateMachine.checkProjectScope`，工單 8d030ed9 補上）：已指派帳號只能讀自己專案的工單，跨範圍讀取回 403 `out_of_scope` 並留稽核紀錄。被拒的讀取在稽核表記一筆 `rejected` 列，from_status 與 to_status 皆為工單當下狀態（讀取不指向新狀態），以此與被拒的轉換區分。
- 強制執行在伺服器端，不只前端擋：前端的專案篩選只是顯示，真正的範圍由後端在佇列、列表、轉換、詳情、歷程五處強制。
- 未指派的帳號行為不變：佇列與列表看全部專案，轉換、詳情、歷程不受範圍限制。

### 交接說明

- 兩段試行交接必填交接說明：拆解完成交給開發（拆解中 → 待開發）時附工作清單，開發完成送審（開發中 → 待 Review）時附變更說明與自測結果。交接說明空白或缺失時，轉換被系統擋下（400 `handoff_required`），而不是先切再補。
- 其餘轉換的交接說明可附可不附；有附就一併記在轉換紀錄裡，工單歷史與工單詳情頁都看得到。
- 交接夠不夠用，由下一手判斷：收到交接說明後若認為不足，不需要新狀態——直接用既有的待澄清機制把單打回，並寫明具體疑問。前端在最新交接說明旁邊就提示這條退回路徑。交接是否足夠，是第二期試行要驗證的事，不是系統預先判定。
- 缺少必填內容（理由或交接說明）屬於驗證錯誤，回 400；角色不符、非法轉換、審自己的工作屬於授權錯誤，回 403。兩種被拒的嘗試都留稽核紀錄。

### 試行範圍說明

- API 金鑰本身不限階段：金鑰認證與會話認證相同，不會因為某段不在試行範圍就擋下呼叫。試行的意思是：接單佇列與交接必填目前只覆蓋拆解與開發兩段，交接是否足夠也在這兩段驗證。其他階段照原有規則走，不另外設 Agent 專用限制。

### PM 監控

- PM 每 15 分鐘輪詢 `GET /api/monitor/stalled` 看範圍內卡住的單（第 13 章）。三個監控端點皆須 PM 角色，並走同一條專案範圍檢查（`stateMachine.checkProjectScope`）；跨專案的提醒或升級紀錄回 403 `out_of_scope`。

---

## 13. PM 監控（防卡住）

> 本章實作於工單 c3f13041：PM 負責整個任務順利跑完、不被卡住，每 15 分鐘檢查一次、提醒成員。

### 卡住的定義

- 處於工作中狀態（`decomposing`、`in_dev`、`in_review`、`in_test`、`pending_deploy`）超過 30 分鐘沒有任何轉換，或處於 `needs_clarification` 超過 30 分鐘沒人回。
- 時鐘是最新一筆 applied 轉換紀錄（`ticket_transitions` 的 `created_at`），不是 `tickets.updated_at`：把工單移專案也會更新 `updated_at`，被拒的嘗試也不會推進工單，兩者都不該重置時鐘。
- 刻意未納入：`requirement`、`pending_dev`、`pending_review`、`pending_test`（等接取的佇列狀態）與 `needs_acceptance_clarification`。規格只列五個工作中狀態加待澄清；若 Leader 要把等接取的佇列也納入監控，改 `server/monitor.js` 的 `STALLED_STATES` 一行即可。

### 分工：伺服器偵測、值班 Agent 發送

- Relay server 沒有通往 Muse 聊天室的通道，所以「通知到角色聊天室」不可能由 server 直接做。分工如下：
  - Server：偵測卡住、保存提醒狀態（`monitor_reminders` 表）、去重、判斷是否該升級，並提供 PM 輪詢的端點。
  - PM 值班 Agent：每 15 分鐘呼叫 `GET /api/monitor/stalled`，對 `needs_reminder` 為真的單發提醒、呼叫 `POST .../reminded` 回報；對 `needs_escalation` 為真的單升級到主聊天室給 Dylan、呼叫 `POST .../escalated` 回報。
- 15 分鐘的節奏由 PM 值班排程控制（repo 外），server 只提供「現在該提醒誰」的狀態；server 本身不跑定時任務（不新增依賴）。

### 提醒狀態與去重

- 每張單在 `monitor_reminders` 最多一列，以「卡住回合」（episode）區分：回合的 key 是最新一筆 applied 轉換的 id。工單一有新轉換，回合就換了，提醒次數從 0 重新算、升級狀態清空——轉換路徑不需掛鉤子，server 在讀取時比對 key 即可。
- 每個 15 分鐘週期每張單最多一則提醒：`needs_reminder` 只在「從未提醒」或「上次提醒已滿 15 分鐘」時為真；提醒後 PM 呼叫 ack 端點寫入 `last_reminded_at`，15 分鐘內再查就不會重複 flagged。即使 PM 沒來得及 ack，下次輪詢仍只會發一則（一個週期一則）。
- 升級：同一回合提醒滿 3 次（約 45 分鐘）仍卡住，`needs_escalation` 為真；PM 升級後呼叫 ack 端點寫入 `escalated_at`，同一回合只升級一次。升級後提醒照常每 15 分鐘繼續（單子還卡著），直到工單移動、回合結束。提醒滿 3 次後，下一次輪詢即 flag 升級；PM 也可在發完第 3 則提醒後立刻重查一次、同一週期內升級，兩種做法都符合「提醒 3 次後升級」。
- `needs_clarification` 的負責角色是 PM：提醒的對象就是 PM 自己——輪詢的 PM Agent 看到後應直接補充澄清（本職工作），而不是再轉發一則訊息給自己。

### 端點（皆須 PM 角色，皆走專案範圍檢查）

- `GET /api/monitor/stalled`：範圍內全部卡住的單，每筆附 `stalled_since`、`stalled_minutes`、`reminder_count`、`last_reminded_at`、`escalated_at`、`needs_reminder`、`needs_escalation`、`notify_role`（負責角色）與 `next_actions`（該角色下一步合法轉換，即「解開需要什麼」）。
- `POST /api/monitor/stalled/:id/reminded`：記錄已發提醒；同一回合次數 +1，新回合重置為 1。單子當下沒卡住回 400 `not_stalled`；非 PM 回 403 `wrong_role`；跨專案回 403 `out_of_scope`。
- `POST /api/monitor/stalled/:id/escalated`：記錄已升級；同一回合只接受一次，未滿 3 次提醒或已升級過回 400 `not_due`。

### 備註

- migration 009 是 `monitor_reminders` 表。CHECK 約束補漏（第 14 個狀態 `needs_acceptance_clarification`）由 migration 011 處理（工單 16f227ff）：001／002 的三處 CHECK 清單補上第 14 個狀態，011 另以 DROP＋ADD 修正既有資料庫的約束。
- 未驗證：migration SQL 與 upsert 語句未在 live PostgreSQL 上實際執行（本機無資料庫）；合併部署前應在 develop 預覽環境以真實工單跑一次完整週期（卡住 → 提醒 → 3 次 → 升級）。

---

## 14. 自訂 Workflow

> 本章實作於工單 3269ec1c：專案可以自訂每個狀態由哪個角色負責，取代內建的固定對照；預設 workflow 的行為與今天完全一致。

### 動機

第 5／6 章的狀態機與角色對照是寫死在程式裡的：待開發永遠等工程師、測試中永遠是 Tester。不同專案想換分工（例如某專案的待開發由 Tester 先接去寫測試計畫）時，過去只能改程式。自訂 Workflow 把「狀態 → 角色」這層對照搬進資料庫：每個專案可以有一套具名 workflow，工單的路由、接單佇列與卡住提醒都改走該專案生效的 workflow。

### 資料模型

- `workflows` 表（綱要見第 8 章，DDL 為 migration 010）：`name`、每個狀態的 `{role, responsibilities}`（`roles` JSONB）、`is_default`／`is_active` 旗標。
- `roles` 的形狀：14 個狀態缺一不可、多餘的 key 拒絕。非終態的 `role` 必須是 6 個 workflow 角色（pm／leader／engineer／reviewer／tester／deployer）之一，`responsibilities` 是非空字串；終態（`delivered`／`cancelled`）的 `role` 必須是 `null`，`responsibilities` 是字串。驗證函式為 `server/workflows.js` 的 `validateRolesMap`。
- 名稱唯一：同一專案內（`project_id`，`name`）唯一，撞名回 409 `workflow_name_taken`（沿用 projects 的慣例，service 收到 23505 回 409）。

### 旗標語意

- `is_default`：全域預設 workflow 只有一筆（`project_id` NULL），是所有專案的 fallback。**唯讀**：更新、刪除、設為 active 都拒絕（400 `default_workflow_readonly`）。
- `is_active`：每個專案最多一筆。設為 active 時，把同一專案其他 workflow 的 `is_active` 清掉（同一交易內完成）。切回預設＝把該專案的 active 全部清掉（`workflow_id` 傳 `null`）。
- 刪除守則：預設 workflow 永遠不能刪；active workflow 在該專案沒有其他非預設 workflow 可替代時不能刪（400 `active_workflow_no_alternative`）；有其他非預設 workflow 時可刪，刪後該專案退回預設 workflow。非 active 的 workflow 可直接刪。

### Seed 與預設 workflow

- migration 010 用 `INSERT ... SELECT ... WHERE NOT EXISTS (SELECT 1 FROM workflows WHERE is_default)` 寫入一筆名為 `Default` 的預設 workflow，內容等於目前內建流程，確保既有行為完全不變。
- 預設 workflow 的角色對照從 `server/stateMachine.js` 的 `TRANSITIONS` 推導（每個狀態取第一條 `from` 為該狀態的規則之 role）：requirement→leader，decomposing→leader，needs_clarification→pm，pending_dev→engineer，in_dev→engineer，pending_review→reviewer，in_review→reviewer，pending_test→tester，in_test→tester，needs_acceptance_clarification→pm，pending_deploy→deployer，deploying→deployer，delivered／cancelled→null。
- **responsibilities 文字是我補寫的**：現有文件與程式沒有現成寫法，預設 workflow 每個狀態的職責句是我為本單新寫的（見 `server/workflows.js` 的 `DEFAULT_RESPONSIBILITIES`），不是從既有文件抄來的。
- Seed 的 JSON 與 `server/workflows.js` 的 `DEFAULT_WORKFLOW_ROLES` 完全一致：以程式產生（node 讀 workflows.js 印出 JSON 再寫進 SQL），不要手抄兩份。

### 角色解析：三層 fallback

`workflows.getRoleMap(db, projectId)` 回傳該專案生效的 roles map：

1. 該專案的 active workflow；
2. 否則 DB 裡 `is_default` 的預設 workflow；
3. 否則程式內建 `DEFAULT_WORKFLOW_ROLES` 常數（從 TRANSITIONS 推導，見上）。

`projectId` 為 null（未分類工單）直接走預設。這個三層 fallback 保證既有行為不變，即使 seed 還沒跑過。兩條查詢寫成固定形式，方便測試 fake 處理：`SELECT * FROM workflows WHERE project_id = $1 AND is_active = true LIMIT 1`，以及 `SELECT * FROM workflows WHERE is_default = true LIMIT 1`。

### 角色解析的三個整合點

- **轉換（`server/tickets.js` 的 `transitionTicket`）**：在交易內（用傳入的 client）先以 `getRoleMap(db, ticket.project_id)` 取角色 map，傳給 `validateTransition` 當 `roleOverrides`。`stateMachine.js` 的 `validateTransition` 與 `allowedTransitions` 各加一個可選參數 `roleOverrides`（狀態→角色的 map）：有 override 時，該條規則的 `from` 狀態之要求角色改為 override 的角色（僅當 override 是 6 個 workflow 角色之一）；回傳的 rule 其 role 亦改為 override 後的角色，稽核列才能正確記錄。Cancel 規則維持 PM-only，不接受 override。沒傳 `roleOverrides` 時行為與今天完全一致。
- **接單佇列（`server/tickets.js` 的 `listClaimable`）**：不再用寫死的 CLAIMABLE 常數。先取 requirement／pending_dev 兩種等待狀態的工單，再按每張單所屬專案的 role map 決定該狀態的負責角色（同一專案的 map 快取起來，只查一次），只有呼叫者持有該角色時才列入；`next_transition` 從 TRANSITIONS 找該 from 狀態的唯一出路規則（requirement→decomposing，pending_dev→in_dev），但 role 欄位填 workflow 的角色。預設 workflow 下結果與今天完全相同。
- **PM 監控（`server/monitor.js` 的 `listStalled`）**：每張卡住工單的 `notify_role` 與 `next_actions` 改按該單所屬專案的 role map 解析（同一專案快取一次）；`next_actions` 呼叫 `allowedTransitions` 時把該單的 role map 當 `roleOverrides` 傳入。原本的 `responsibleRole(status)`（內建推導）保留並 export，當 fallback 與既有測試用。

### 端點

| 方法 | 端點 | 說明 |
| --- | --- | --- |
| `GET` | `/api/workflows?project_id=` | 列表；已指派帳號只能看到自己專案的 workflow＋全域預設，跨專案回 403 `out_of_scope` |
| `GET` | `/api/workflows/:id` | 單筆；同上範圍檢查（`project_id` 為 null 的 workflow 視為全域、所有人可見） |
| `POST` | `/api/workflows` | 建立（僅 Admin；name 必填、未知專案 400、重名 409、roles 驗證 400） |
| `PATCH` | `/api/workflows/:id` | 更新 name／roles（僅 Admin；預設唯讀） |
| `DELETE` | `/api/workflows/:id` | 刪除（僅 Admin；見刪除守則） |
| `GET` | `/api/projects/:id/active-workflow` | 回傳 `{workflow, is_default}`：有 active 就回 active，否則回預設 workflow 並標 `is_default: true` |
| `POST` | `/api/projects/:id/active-workflow` | body `{workflow_id: string \| null}`，null＝切回預設（僅 Admin） |

### 前端

- Admin → Workflows 分頁（只對 Admin 顯示），點開時載入該專案的 workflows 與 active workflow。異動（建立／更新／刪除／設為啟用）僅 Admin 可做；PM 可讀 workflow（開單選 workflow 仍需讀），不可寫。
- Workflow 管理畫面（`src/WorkflowsPanel.tsx`，版式沿用 ProjectsPanel 的 card＋table＋form 風格）：專案篩選、workflow 列表（name、Default／Active 徽章、各狀態角色摘要）、建立表單（name＋14 個狀態各一列：角色下拉＋職責文字欄；新建時預設值從預設 workflow 的 roles 帶入）、編輯表單（同樣結構）、設為 active 按鈕、切回預設按鈕、刪除按鈕；後端錯誤訊息顯示在畫面上。角色下拉選項用 6 個 workflow 角色（不要含 admin），label 沿用 `helpers.ts` 的 `ROLE_LABELS`。
- 狀態與轉換本身的編輯（狀態機編輯器）見第 15 章：本章的表單結構已擴充為 States／Transitions／Roles 三段。

### 備註

- 未驗證：migration 010 的 SQL 未在 live PostgreSQL 上實際執行（本機無資料庫）；合併部署前應在 develop 預覽環境確認預設 workflow 正常寫入，且既有工單的轉換、佇列與監控行為不變。
- live DB CHECK 約束漏第 14 個狀態的問題由 migration 011 處理（工單 16f227ff，本單不碰）。

---

## 15. 自訂 Workflow：狀態機編輯器

> 本章實作於工單 baebf8b7：Workflow 不再只是角色對照表，狀態與轉換本身也可以自訂；開單時選擇套用的 workflow，預設為現有 14 狀態開發流程。

### 動機

第 14 章的 Workflow 只能改「某個狀態由哪個角色負責」：14 個狀態寫死在 `stateMachine.js`，不能加狀態、不能改名、不能改順序，短流程設不出來。Dylan 要的三條流程都不是開發流程：

1. 使用者需求 → 功能規劃 → 使用者確認 → 產生規格書 → 交付
2. 使用者需求 → 功能規劃 → 產生規格書 → 交付
3. 系統事件 → 建立報案 → 結束

本章把狀態機變成資料：每個 workflow 自帶 states 與 transitions，編輯器讓 Dylan 以後自己加流程；三條流程是第一批驗收範例，不是寫死的模板（fixture 只存在 `server/workflowExamples.js` 供測試與編輯器參考，不做 migration seed）。

### 核心決定：每張工單跟隨一個 workflow definition

- 一張工單在開立時選定一個 workflow，之後不再變更（`tickets.workflow_id`，`ON DELETE SET NULL`）。
- 沒有 `workflow_id` 的工單走內建 14 狀態流程（第 5 章）；內建流程只是預設 definition，不是特殊程式路徑——狀態機函式改為 definition-driven（`validateTransitionFor`／`allowedTransitionsFor`／`legalTransitionsFor`／`isTerminalFor`／`startStateFor`），舊函式（`validateTransition` 等）改為對內建 definition 的包裝，行為不變。
- Definition 解析優先順序（`workflows.definitionForTicket`）：工單的 `workflow_id` → 該 workflow 的 states／transitions／roles；無 workflow → 內建 definition。工單指到不存在的 workflow 列時回 `missing: true`，呼叫方視為內部錯誤（500），**不靜默 fallback 到內建流程**——fallback 會把工單留在未知狀態。刪除守則（有工單的 workflow 不可刪）與外鍵使這種情況實務上到不了。
- 專案 active workflow 的 role map（第 14 章三層 fallback）**只適用於內建流程的工單**。自訂流程工單的角色一律來自它自己的 workflow 的 roles map。理由：active workflow 是「某專案的開發流程用哪套角色對照」，而自訂流程工單根本不在開發流程裡，用專案的對照去覆蓋它自己的對照是錯的。

### 資料模型

- `workflows` 表新增 `states` JSONB 與 `transitions` JSONB（migration 013）。state：`{code, label, sort_order, is_start, is_terminal}`；transition：`{from, to, role, requiresReason, requiresHandoff, kind, selfCheck}`。欄位格式與既有 `TRANSITIONS` 常數一致：transition 用 camelCase（`requiresReason`／`requiresHandoff`／`selfCheck`），state 用 snake_case（`sort_order`／`is_start`／`is_terminal`）。
- `tickets` 表新增 `workflow_id UUID REFERENCES workflows(id) ON DELETE SET NULL`＋索引 `idx_tickets_workflow`（migration 013）。預設 workflow 列的 states／transitions 由 node 從 `stateMachine.js` 產生（14 states、18 條非 create 轉換）填入，僅當 states 為空時才填。
- **DB 狀態 CHECK 移除（migration 012）**：`tickets_status_check`、`ticket_transitions_from_status_check`、`ticket_transitions_to_status_check` 三處 DROP（皆 `IF EXISTS`，不重加）。狀態合法性改由應用層按工單的 workflow 驗證；資料庫層再也寫不出所有 workflow 的狀態清單。migration 001／002 就地更新（移除狀態 CHECK，保留 source／actor_role／result CHECK，並在檔頭註明 012 移除）。migration 011 另加一道 guard（DO block）：只有當全部已存狀態都在 14 個內建狀態內時才重加 CHECK——因為伺服器每次啟動都會重跑全部 migration，012 上線後若已有自訂狀態的工單，無條件重加會在每次啟動都失敗、並卡住 012／013 之後的 migration。011 本身的目的不受影響：它首次套用時所有已存狀態都是內建狀態，guard 一定通過。

### 驗證規則（`workflows.validateWorkflowDefinition`）

states：非空、code 為小寫 snake_case 且唯一、label 非空、恰一個起點、至少一個終態；列出的 `cancelled` 必須是終態。transitions：from／to 須為既有狀態、from ≠ to、kind 為 `forward`／`backward`／`pickup`／`clarify`／`return` 之一、requiresReason／requiresHandoff 為布林、backward／return 必須 requiresReason、role 須為 6 個 workflow 角色之一、無重複 (from, to)。roles：覆蓋恰好該 workflow 的 states（`validateRolesMap` 泛化為接受 states 參數，預設內建 14 狀態；roles 失敗沿用舊錯誤碼 `invalid_roles`，結構失敗為 `invalid_workflow`）。結構：每個非終態至少一條出路；從起點可達所有狀態（列出的 `cancelled` 視為可達）。

### 隱式規則：create 與 cancel 不存入 workflow

- **create**：NULL → 起點，PM 開立。開單 API 的稽核列 `to_status` 為該 workflow 的起點。
- **cancel**：PM、任一非終態 → `cancelled`、需理由。適用於所有 workflow，永遠不列入 workflow 的 transitions。
- **`cancelled` 是通用取消目標**：即使未列入該 workflow 的 states 也視為終態；列出的 `cancelled` 必須是終態。狀態機對它永遠回終態；轉換驗證允許 `to_status='cancelled'` 即使不在 states 裡。

### 角色：transition 的 role 與 roles map 的關係

- 一個狀態只有一個負責角色（第 14 章的模型不變）：transition 的 role 是「該流程設計時的角色」，roles map 是「該 workflow 指派的角色」。驗證時 roles map 覆蓋 transition 的 role（第 14 章的 override 機制，現在也套用於自訂流程）。
- 因此**只改 roles map 不必改 transition 表**：把某狀態的角色換掉是合法的 roles-only 更新，transition 表不用跟著改。存檔時伺服器以 roles map 重推每個 transition 的 role（`normalizeDefinition`），讓儲存的列保持一致；但執行期永遠以 roles map 為準。
- 角色／職責定義放在 Admin／User 上，並註明針對哪個 workflow（需求 3 的解讀）：用戶角色仍是全域的；per-workflow 的差異由各 workflow 自己的 state→role 對照決定——同一人在 workflow A 當 leader 負責某狀態、在 workflow B 當 engineer 負責另一狀態。實作：(a) workflow 編輯器按 workflow 定義 state→role＋responsibilities（標明所屬 workflow）；(b) Admin Users 頁新增衍生顯示：每位用戶在各 workflow 負責的狀態（以其全域角色對照各 workflow 的 role map），標明 workflow 名稱。備選方案（另建 `workflow_user_roles` 表、按 workflow 授權角色）已考慮未採用：它與現有「帳號持有全域多角色」模型衝突，且需求的核心是「同一人在不同 workflow 負責不同狀態」，roles map 已能表達。

### 轉換驗證、佇列、監控、擁有權

- **轉換（`transitionTicket`）**：以工單的 definition 驗證；自訂流程工單的 roleOverrides 是該 workflow 自己的 roles map，內建流程工單維持專案 active workflow 的 role map。退回（`kind=backward`／`return`）需理由，由狀態機的 requiresReason 強制。
- **佇列（`listClaimable`）**：內建流程維持試行範圍（僅 requirement／pending_dev，角色走專案 role map）；自訂流程改為「目前狀態有 kind=`pickup` 的轉換，且呼叫者持有該狀態的有效角色（roles map 優先）」才可認領。等待接取的狀態就是有 pickup 出路的狀態——定義本身說明了哪裡是佇列。
- **監控 stalled（`listStalled`／`isStalledState`）**：內建流程維持第 13 章的 `STALLED_STATES` 清單（`pending_deploy` 列入是既定例外：部署是最後一步，不試圖用 transition kind 推導）；自訂流程用通用規則：**非終態、且不是等接取佇列狀態（無出路 pickup 轉換），超過 30 分鐘無轉換**。理由：等接取的票不是卡住，是在等有人領；其餘進行中的狀態超過 30 分鐘沒動靜就是卡住，與第 13 章的 30 分鐘門檻一致。`notify_role` 與 `next_actions` 按工單自己的 workflow 解析（自訂：roles map 或第一條出路轉換的角色；內建：專案 role map＋`responsibleRole` fallback）。實作上候選集不能再用狀態預篩，改為讀取範圍內全部工單再以 JS 依 definition 篩選（每 workflow／專案的 definition 與 role map 各快取一次）。
- **擁有權（自訂流程，`nextOwnershipForCustom`）**：pickup／cancel 由執行者認領，其餘移交清空 assignee、等下一角色接取；`developer_id` 不動，自訂流程無 self-check（self-check 是開發流程的 Review／測試／部署規則）。

### 開單選 Workflow

- `POST /api/tickets` 接受 `workflow_id`（省略＝內建流程）。workflow 不存在回 404；專案 workflow 只能用於自己專案的工單，否則 400 `workflow_project_mismatch`；全域 workflow（`project_id` NULL）可用於任何專案。新工單狀態為該 workflow 的起點。
- `GET /api/meta/transitions?workflow_id=` 回傳該 workflow 的 legal transitions（無參數＝內建表，不變）。
- 前端 New ticket 表單加 workflow 下拉：預設「Default development flow（14 states）」→ `workflow_id` null，其餘為可用 workflows（該專案的或全域的，不含 Default 列本身——null 選項已代表它；他專案的 workflow 不出現）。

### Workflow 編輯器（Admin／PM）

- `src/WorkflowsPanel.tsx` 大改：States 編輯器（label、code、順序上下移、起點 radio、終態 checkbox、新增／刪除；code 改名時自動重指所有引用它的 transition；刪除狀態時一併刪掉相關 transition 與 roles 條目）、Transitions 編輯器（from／to 下拉、kind 下拉 forward／backward／pickup／clarify／return、requiresReason／requiresHandoff checkbox、role 為 from-state 衍生顯示唯讀）、Roles 表改由該 workflow 自己的 states 驅動（不再是寫死的 14 狀態）。
- 新建預設從空白開始（0 個狀態），不再複製 Default workflow 的完整定義；範本一鍵套用與快速建立見下節。Default workflow 唯讀檢視（View 開啟同一表單、全部 disabled、不送出）。
- 前端先做與伺服器相同的輕量驗證（恰一個起點、至少一終態、code 格式與唯一、backward／return 需理由、每非終態有出路等），伺服器再驗一次，後端訊息為準。Cancel 不列在編輯器裡（隱式規則，見上）。
- 守則：仍有工單處於某狀態時，該狀態不可刪除（400 `state_in_use`）；有工單的 workflow 不可刪除（400 `workflow_in_use`）。第 14 章的刪除守則（預設唯讀、active 需替代）維持不變。

### 簡化建立流程：空白開始、範本、快速建立

> 工單 ecf671fb：新建時編輯器直接複製預設的完整定義（14 個狀態＋全部轉換＋角色），做短流程得先刪一堆不要的東西，Dylan 回報建立流程太複雜。

- **空白開始**：新建 workflow 的表單初始為 0 個狀態、0 條轉換、空 roles map（`WorkflowsPanel.openCreate` 不再複製 Default workflow）。Default workflow 本身不動，既有 workflow 不受影響。
- **範本一鍵套用**：新建表單的「Start from」區列出三條內建範本，點一下把該範本的 states／transitions／roles 填入表單，微調後存檔。範本的單一來源仍是 `server/workflowExamples.js`，前端經 `GET /api/workflow-examples` 讀取（唯讀參考資料，不分專案，任何登入用戶可讀），不另寫一份；表單已有內容時套用前先確認覆蓋。
- **快速建立**：同一區的 Quick create：輸入狀態名清單、每狀態選負責人，Generate 自動串成線性流程（第一個狀態為起點、最後一個為終態；第一條轉換 kind `pickup`、其餘 `forward`；每狀態負責人寫進 roles map；responsibilities 自動填預設句，可在 Roles 表修改）。退回、理由等進階設定收進「Advanced」區（加一條 backward 轉換，from／to 自選，理由自動必填），預設不用填。產生邏輯是共用純函式 `src/workflowQuickCreate.ts` 的 `buildLinearFlow`（無 React、無 DOM），編輯器與 server 測試共用同一份；中文等無法 slug 的 label 以 `state_N` 為 code、碰撞加數字後綴。
- **驗證規則沒有改**：0 狀態的草稿只存在瀏覽器表單裡，存檔時仍須符合既有規則（恰一個起點、至少一個終態、每非終態至少一條出路等）；前端 `validateForm` 在 0 狀態時擋下送出（`Add at least one state.`），後端 `createWorkflow` 對明確傳入的空 states／transitions 亦回 400 `invalid_workflow`（有測試鎖住）。`createWorkflow` 省略 states／transitions 時預設內建 definition 的舊行為不變（roles-only 建立仍走該路徑）。

### 三條範例流程

`server/workflowExamples.js`（fixture，僅供測試與編輯器參考）：

| 流程 | 狀態 | 轉換 | 角色 |
| --- | --- | --- | --- |
| A：含使用者確認 | 使用者需求 → 功能規劃 → 使用者確認 → 產生規格書 → 交付 | 需求→規劃 pickup（leader）；規劃→確認 forward（leader）；確認→規格 forward（pm）；確認→規劃 **backward**（pm，需理由）；規格→交付 forward（engineer） | 需求 leader、規劃 leader、確認 pm、規格 engineer |
| B：不含確認 | 使用者需求 → 功能規劃 → 產生規格書 → 交付 | 需求→規劃 pickup（leader）；規劃→規格 forward（leader）；規格→交付 forward（engineer） | 同 A 去掉確認 |
| C：報案 | 系統事件 → 建立報案 → 結束 | 事件→報案 pickup（pm）；報案→結束 forward（engineer） | 事件 pm、報案 engineer（報案由 PM 接取建立、由 engineer 處理結案） |

驗收：三條流程都能在編輯器裡建出來、開單時選得到、按順序走完、使用者確認可退回功能規劃；預設開發流程行為不變（既有測試全過）。

### 端點（新增／變更）

| 方法 | 端點 | 說明 |
| --- | --- | --- |
| `POST` | `/api/tickets` | 加 `workflow_id`（見上） |
| `GET` | `/api/meta/transitions?workflow_id=` | 該 workflow 的 legal transitions；無參數＝內建表 |
| `GET` | `/api/workflow-examples` | 三條內建範本（編輯器一鍵套用）；唯讀，不分專案 |
| `POST` | `/api/workflows` | 加 `states`／`transitions`（省略時預設內建 definition；驗證失敗 400 `invalid_workflow`／`invalid_roles`） |
| `PATCH` | `/api/workflows/:id` | 加 `states`／`transitions`（同上；另有 `state_in_use` 守則） |
| `DELETE` | `/api/workflows/:id` | 加 `workflow_in_use` 守則（有工單時拒絕） |

### 前端（workflow-aware 顯示）

- `src/api.ts`：Ticket 加 `workflow_id`；Workflow 加 `states`／`transitions`；新 type `WorkflowState`／`WorkflowTransition`；`metaTransitions(workflowId?)`。
- `src/helpers.ts`：`stateLabelFor`／`isTerminalFor`／`statusBucketFor`（自訂狀態：終態→done、`in_*`／decomposing／deploying→active、其餘 pending）；`statusColor` 對未知狀態碼以 hash 取色；`transitionTargets`／`targetsForUser` 接受 terminal 判斷函式（Cancel 只在非終態出現）；`countTicketsByProject`／`ganttRange` 接受 workflow 對照。
- 狀態標籤、Dashboard bucket、Gantt 終態判斷、工單詳情、佇列 next-step 皆改走 workflow-aware helper；自訂狀態只出現在 All／Claimable 頁籤，不新增動態頁籤。Admin Users 頁新增「Workflow responsibilities」衍生顯示。

### 測試

- `stateMachine.test.js`：`validateTransitionFor`／`allowedTransitionsFor`／`legalTransitionsFor` 對自訂 definition（建得出、走得完、退得回、cancel、起點、未知狀態、終態、錯角色、backward 需理由）；`legalTransitionsFor(BUILTIN_DEFINITION)` 等於 `legalTransitions()`。
- `workflows.test.js`：`validateWorkflowDefinition` 各規則、三條範例流程 fixture、create／update 含 states／transitions、roles-only 更新重推 transition roles、`state_in_use`／`workflow_in_use` 守則、`definitionForTicket`；`listWorkflowExamples` 回傳三條範本且與 fixture 一致、每條皆通過驗證；明確傳入空 states／transitions 建立時回 400（空白草稿不可存檔）。
- `workflowQuickCreate.test.js`：`buildLinearFlow`——三狀態線性串接（起點／終態、第一條 pickup）、兩狀態、少於兩個拒絕、空白 label 略過、中文 label 以 `state_N` 為 code、code 碰撞加後綴、非終態缺角色拒絕、終態角色忽略、transition 角色與 from-state 一致、輸入不被改動；產生的定義皆通過伺服器驗證。
- `tickets.test.js`：開單帶 workflow（起點、稽核列、404／400）、三條流程走完＋退回＋cancel、佇列自訂 pickup 規則；預設流程既有測試全過。
- `monitor.test.js`：自訂流程通用 stalled 規則（工作狀態卡住、佇列／終態不卡住、30 分鐘門檻）、內建清單不變。
- `migrations.test.js`：001／002 無狀態 CHECK、011 仍重加 14 狀態 CHECK、012 移除三約束且不重加、013 欄位與 seed 內容等於內建 definition。

### 備註

- 未驗證：前端編輯器未做瀏覽器實點驗證（無瀏覽器）；migration 012／013 未在 live PostgreSQL 上實際執行（本機無資料庫），合併部署前應在 VM 臨時 scratch 資料庫驗證 001→013 依序套用與全新建表，絕對不要碰 live 資料庫。
- 第 14 章的「自訂 Workflow」現指「專案的角色對照」；本章的「狀態機編輯器」指「workflow 自身的 states／transitions」。兩者共用 `workflows` 表：roles map 是第 14 章的層，states／transitions 是本章加的層。

---

## 附錄 A. 狀態代碼對照

> 本表是內建 14 狀態開發流程的狀態。自訂 workflow 有自己的狀態（見第 15 章），不列在此表。

| 中文狀態 | 代碼 | 類型 | 負責角色 |
| --- | --- | --- | --- |
| 需求 | `requirement` | 待接取 | Leader |
| 拆解中 | `decomposing` | 進行中 | Leader |
| 待澄清 | `needs_clarification` | 等待補充 | PM |
| 待開發 | `pending_dev` | 待接取 | 工程師 |
| 開發中 | `in_dev` | 進行中 | 工程師 |
| 待 Review | `pending_review` | 待接取 | Reviewer |
| Review 中 | `in_review` | 進行中 | Reviewer |
| 待測試 | `pending_test` | 待接取 | Tester |
| 測試中 | `in_test` | 進行中 | Tester |
| 待驗收澄清 | `needs_acceptance_clarification` | 等待補充 | PM |
| 待部署 | `pending_deploy` | 待接取 | Deployer |
| 部署中 | `deploying` | 進行中 | Deployer |
| 已交付 | `delivered` | 終點 | - |
| 已取消 | `cancelled` | 終點 | - |

## 附錄 B. 工單生命週期範例

以下範例示範一張 Project 需求工單的完整歷史，包含一次澄清來回與一次 Review 退回。每列就是一筆轉換紀錄，這正是第 7 章要求能隨時重播的內容。

| # | 執行者 | 從 → 到 | 理由 / 產出 |
| --- | --- | --- | --- |
| 1 | PM | （開立）→ 需求 | 建立需求：目標、範圍、驗收條件 |
| 2 | Leader | 需求 → 拆解中 | 開始拆解 |
| 3 | Leader | 拆解中 → 待澄清 | 疑問：驗收條件中的效能指標未定義 |
| 4 | PM | 待澄清 → 拆解中 | 補充效能指標定義 |
| 5 | Leader | 拆解中 → 待開發 | 拆解完成，附開發工作清單 |
| 6 | 工程師 | 待開發 → 開發中 | 接取開發 |
| 7 | 工程師 | 開發中 → 待 Review | 附變更說明與自測結果 |
| 8 | Reviewer | 待 Review → Review 中 | 接取審查 |
| 9 | Reviewer | Review 中 → 開發中 | 退回：附待改事項 |
| 10 | 工程師 | 開發中 → 待 Review | 修正後再次送審 |
| 11 | Reviewer | Review 中 → 待測試 | 審查通過（經待 Review → Review 中接取） |
| 12 | Tester | 測試中 → 待部署 | 測試通過，附測試結果（經待測試 → 測試中接取） |
| 13 | Deployer | 部署中 → 已交付 | 部署成功，附版本與驗證結果（經待部署 → 部署中接取） |

範例為流程示意，不對應任何真實工單。省略的接取步驟已在理由欄註明，實際紀錄中每一筆轉換各自成列。
