# @nxvet/nxst-plugin-devkit

[English](README.md) · 繁體中文

給 [NxVet SyncTool](https://www.npmjs.com/package/@nxvet/nxst-plugin) 儀器外掛用的**開發期工具包**：
一支**儀器模擬機**（拿實機擷取到的位元組去打真的 SyncTool）與一支**實機擷取 server**（收真機的位元組、
存成重播用的 fixture）。

儀器通常是借來的、要退回。退回之後 SDK 的重播 harness 仍能測外掛的 driver，但它不會真的開 port，碰不到
正在執行的 SyncTool。這個套件補的就是這一段：模擬機真的開 TCP 連線連到外掛的 port，照儀器在線路上的習慣
送訊息；擷取工具是它的鏡像，那些位元組與習慣一開始就是用它錄下來的。

- **儀器語意留在外掛。** 哪一則是品管、ACK 怎麼判、重送時儀器改哪些欄位、哪幾欄是個資、儀器怎麼用 TCP——
  全部透過一個 *profile* 物件交給工具包；工具包只負責機制。
- **逐位元組。** 訊息照擷取到的位元組原樣送出；一次執行允許改的幾個欄位（control id、時間戳、病歷號）
  用 [`@nxvet/nxst-hl7-parser`](https://www.npmjs.com/package/@nxvet/nxst-hl7-parser) 的位元組範圍 API 原地改寫。
- **輸出不含個資。** 從不印 frame 內容；清單、日誌、摘要只印 profile 回傳的字串；fixture 寫出前先置換個資。
- **核心可測、CLI 很薄。** `createSimulator` 與 `createCapture` 只透過 `io` 物件碰外界、從不 exit；
  `runSimulator` 與 `runCapture` 是命令列包裝。

## 安裝

```bash
npm install --save-dev @nxvet/nxst-plugin-devkit @nxvet/nxst-hl7-parser
```

需要 **Node 22 以上**。`@nxvet/nxst-hl7-parser` 是 peer dependency：外掛本來就依賴它，而且只有一份才能保證
擷取工具的切框與 driver 完全相同。套件是 ESM，出的是編譯好的 JavaScript 與型別宣告。

這是開發期依賴，由外掛的 `tools/*.ts` 引用，從不打進 `.nxplugin`。

> **型別一律用 `import type`。** 外掛的工具是靠 Node 的 type stripping 直接跑 `.ts`，它不會拿掉
> `import { SimulatorProfile }` 這種沒有執行期值的 import，載入時會炸。要寫
> `import type { SimulatorProfile } from '@nxvet/nxst-plugin-devkit'`。

## 模擬機

外掛的 `tools/simulate.ts` 組一個 `SimulatorProfile` 交給 `runSimulator`（完整範例見英文 README）。
profile 要給：顯示名稱、提示符、外掛目錄（預設的來源與輸出位置由此推）、預設值（port、ACK 逾時、chunk
大小、間隔）、連線模型、清單欄位的表頭，以及五個函式：

| 函式 | 用途 |
|---|---|
| `describe(bytes, now)` | 跑外掛自己的解析器，回傳 control id、清單欄位、送出時印的一行摘要、driver 會不會回 ACK |
| `resend(bytes, now)` | `r` 重送時要送的位元組：真機手動重送會改哪些欄位，這裡就改哪些 |
| `fresh(bytes, now, seen)` | `--fresh` 時的新 control id（避開 `seen`）與時間戳 |
| `setPatientId(bytes, id)` | 把病歷號換掉（沒有病患段落的訊息可原樣回傳並在 `skipped` 說明） |
| `evaluateAck(ackText, sentBytes)` | 判斷一則已用 MSA-2 配對的 ACK：代碼、算不算接受（決定 exit code）、要印的備註與警告 |

連線模型兩種：`persistent`（開機就連、一直開著、被對端關掉後隔 `retryMs` 重連；可用 `n` / `c` / `k`
手動開關連線）與 `per-message`（每則結果一條連線、連上 `preSendMs` 後送、ACK 後 `closeAfterAckMs` 關線、
閒置時每 `probeMs` 探測一次：連上即關、0 bytes）。

終端機裡啟動後會列出清單，輸入編號就送那一則；stdin 不是終端機時每一行都是指令，所以可以
`printf '1 2\nw 500\nq\n' | node tools/simulate.ts` 腳本化，exit code 反映每則是否都拿到被接受的 ACK。

指令：`3` / `3 5 8` 送那幾則、`s [n]`、`a` 全送剩下的、`r` 重送上一則、`… id=A123` 單次改病歷號、
`id A123` / `id` / `id -` 設定／顯示／取消改寫、`l` 重列清單、`n` / `c` / `k`（只有 persistent 模型）、
`w <ms>` 等待、`h` 說明、`q` 結束。`0`、不認得的字、多餘參數一律拒絕——打錯不能誤送。

旗標：`--host`、`--port`、`--source`（fixture、raw 檔目錄或單一檔）、`--gap <ms>|real`、`--ack-timeout`、
`--chunk` / `--chunk-gap`、`--patient-id`、`--fresh`、`--retry`（persistent）、`--probe` / `--pre-send`
（per-message）、`--hold`、`--out`、`--list`。明確指定的 `--out` 目錄裡若已有 `sent-NNN.hl7` 或 `simulate.log`
（上一次模擬的結果）會直接拒絕（exit 1），不覆寫；擷取工具的檔案不算，所以兩支工具可以共用同一個目錄。

Exit code：0 = 每則都拿到 profile 接受的 ACK；1 = 有逾時、不被接受、連不上或寫入失敗；2 = 參數錯；
130 = 連按兩次 Ctrl-C。`ackExpected` 為 false 的訊息（driver 本來就不回、或沒有 control id）逾時不算失敗。

## 擷取工具

外掛的 `tools/live-capture.ts` 組一個 `CaptureProfile` 交給 `runCapture`：顯示名稱、外掛目錄、預設 port、
個資置換規則（`RedactionSpec`）、`--ack-code` 允許的代碼、自訂旗標，以及兩個函式：`onFrame(frame, receivedAt, say)`
（跑外掛的解析器、印出文件講不清楚的欄位的真機值、回傳 control id／摘要／payload 雜湊／該回的 ACK 或 `null`）
與 `buildAck(frame, verdict, { sequence, code, switches })`（組 ACK 文字，不含 MLLP 外框）。

工具 listen 在外掛的 port、印出這台機器的 IP 供儀器設定；每收到一則 frame 就寫 `raw-NNN.hl7`（原始位元組）、
記連線時序（何時連入、送出、關閉、ACK 後幾毫秒）、印外掛的解析結果；Ctrl-C 結束時寫 `session.jsonl`
（保留每個 chunk 切點、個資已置換）。旗標：`--port`、`--out`、`--no-ack`、`--ack-code`、`--ack-delay`、
`--close-after-ack`、`--no-redact`（只供本機除錯，不得 commit）以及 profile 自己宣告的旗標。

重送以 control id 偵測，並比對原始位元組與 `payloadHash`，所以看得出儀器的「再送一次」是不是同一份位元組。

## fixture、個資置換、欄位改寫

兩支工具底下的純函式也可以單獨用：`parseFixtureSteps`、`messagesFromFixture`、`messagesFromRawFiles`、
`buildFixture`、`createRedactor`（規則：段落、欄位、成分、每個重複值、針對 OBX 這類通用段落的 `when` 判斷；
同一原值一律同一代號）、`redactChunks`（跨 chunk 置換且切點不落在值的中間）、`residualCheck`（原值若等於已發出的
任一代號就略過，例如重新擷取已置換過的 fixture 時，兩者分不出來）、
`rewriteFields`（逐位元組的欄位／重複值／成分改寫，缺的欄位只回報、不合成）、`wrapFrame`、`splitChunks`，
以及互動模式的純函式 `parseCommand`、`formatTable`、`describeState`、`validatePatientId`。

## 個資

工具包從不印 frame 內容，也只把它寫進 raw 與 sent 檔；這兩種檔案要放在外掛的 `captures/` 底下（版控忽略；
`--out` 指到別處時兩支工具都會警告）。所有印出來的訊息描述都來自 profile：`Description.cells` 與 `summary`、
`FrameVerdict.summary`、`onFrame` 印的行——**profile 不得把姓名、飼主等個資放進這些字串**。病歷號要不要印
是外掛自己的決定（driver 的日誌本來就印）。

擷取工具寫出的 fixture 會依 profile 的 `RedactionSpec` 置換個資，其餘位元組不變，檔頭列出每一類置換了幾個
相異值。commit 前請人工再看一次：只有設定到的欄位會被置換。

## 與 SDK 重播 harness 的分工

`nxst-plugin dev --fixture` 透過 mock SDK 把 fixture 重播**給外掛的 driver**，是沒有硬體、沒有 SyncTool 時
測外掛的方法。這個工具包在另一側：擷取工具從真機產生那些 fixture，模擬機把 fixture 播**給真的 SyncTool**，
儀器退回之後整條路徑（裝置狀態、上傳、去重、重啟）都還能驗。

## 驗證一個外掛的 profile

兩支工具可以在同一台機器互打：先在一個空的 port 跑 `tools/live-capture.ts`，再跑
`printf 'a\nw 1000\nq\n' | node tools/simulate.ts --port <那個 port>`。擷取端的 `raw-NNN.hl7` 必須與模擬機的
`sent-NNN.hl7` 逐位元組相同、每則都有 ACK、模擬機 exit 0。擷取端的 `--no-ack`、`--ack-code`、`--ack-delay`
可以再驗模擬機（與它封裝的真機習慣）遇到不乖的 receiver 時的反應。

互動模式用終端機手動驗最準：啟動就有清單、打編號會送、ACK 到時提示符會重畫、Ctrl-C 印摘要。

## 版本

遵循 semantic versioning。profile 介面（`SimulatorProfile`、`CaptureProfile`）與命令列旗標是公開契約：
拿掉欄位或改變旗標語意是 major；新增可選欄位或旗標是 minor。

## 授權

Apache-2.0
