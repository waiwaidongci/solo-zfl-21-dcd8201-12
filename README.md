# 机械钟表擒纵调校 API（含鉴证与所有权流转）

纯后端、零依赖 Node 服务。两类存储：

- `data/db.json`：钟表档案、调校记录、复测记录（原子写）。
- `data/chain.log`：**鉴证、签发、撤销、转让**的不可修改哈希链（append-only），
  每行一条记录：`{prevHash, event, hash}`，`hash = sha256(prevHash + canonical(event))`，
  首条前驱为 `GENESIS`。启动时逐行校验并重放得到证书/所有权视图，篡改任何历史事件都会导致
  `503 CHAIN_CORRUPTED`；仅末尾半截写（进程崩溃在追加中途）会被截断恢复。

## 启动 / 测试

```bash
node server.js                 # 默认 PORT=3021，DATA_DIR=./data
npm test                       # node --test test/service.test.js，26 个用例
ALLOW_CLOCK_OVERRIDE=1 node server.js   # 允许 x-now 注入时间（仅测试用）
```

> 写接口请求体必须是 JSON 对象：空请求体、`null`、数组、字符串、数字、布尔或非法 JSON
> 一律返回 `400 INVALID_BODY`/`INVALID_JSON`，不会写入链路或转让记录。

## 角色

身份由请求头携带，三类角色只能操作各自环节：

| 请求头 | 说明 |
| --- | --- |
| `x-actor-id` | 操作者标识 |
| `x-actor-role` | `appraiser`（鉴定师）/ `reviewer`（复核人）/ `holder`（持有人） |

- 鉴定师：登记鉴证（真伪、品相、估价、凭证）。
- 复核人：通过/驳回鉴证；通过即签发唯一有效证书；可撤销证书。不能复核自己登记的鉴证。
- 持有人：当前持有人发起转让，**目标**持有人接受后所有权才变更。

## 流转规则

- 同一钟表至多一张 `valid` 证书；证书可撤销，撤销后该钟表不可再转让。
- 只有持有效证书的钟表可转让；同一钟表至多一笔 `pending` 转让。
- 转让 24 小时未接受自动失效（到期接受/发起时惰性判定并落盘 `transfer.expired`，重启同样生效）。
- 撤销证书时，若存在待处理转让，同一链上事务内一并作废。
- 所有写操作经进程内互斥锁串行化，一次业务操作 = 一次原子追加；并发接受、重复接受、
  超时接受、重复发起、非法流转一律拒绝，**不产生半截数据**。

## 接口

调校（原有）：

- `GET /health`、`GET /clocks`、`POST /clocks`、`GET /clocks/not-qualified`
- `GET /clocks/:id/history`、`POST /clocks/:id/adjustments`
- `POST /clocks/:id/retests`、`GET /clocks/:id/latest-retest`
- `GET /adjustments?clockId=`、`GET /retests?clockId=&qualified=`

鉴证与所有权：

| 方法与路径 | 角色 | 说明 |
| --- | --- | --- |
| `POST /clocks/:id/appraisals` | appraiser | 登记鉴证，body：`authenticity, condition, estimatedValue, evidence?` |
| `GET  /clocks/:id/appraisals` | - | 该钟表全部鉴证 |
| `POST /appraisals/:id/review` | reviewer | `{"decision":"approve","ownerId":"alice"}` 签发；`{"decision":"reject","reason"}` 驳回 |
| `POST /certificates/:serial/revoke` | reviewer | `{"reason}` 撤销，同时作废待处理转让 |
| `GET  /clocks/:id/certificate` | - | 当前有效证书 + 该钟表全部证书 |
| `GET  /certificates?status=&clockId=` | - | 证书列表 |
| `POST /clocks/:id/transfers` | 当前 holder | `{"toOwnerId":"bob"}` 发起转让 |
| `POST /transfers/:id/accept` | 目标 holder | 接受，所有权变更 |
| `GET  /transfers?clockId=&status=` | - | 转让列表（pending/accepted/expired） |
| `GET  /clocks/:id/ownership` | - | 当前所有权 + 签发/流转/撤销历史 |
| `GET  /clocks/:id/chain` | - | 该钟表的链上事件（全局序号与哈希） |
| `GET  /chain` | - | 全局审计链 |
| `GET  /chain/verify` | - | 链路完整性与尾哈希 |

## 端到端示例

```bash
B=http://127.0.0.1:3021
CID=$(curl -s -X POST $B/clocks -H 'Content-Type: application/json' \
  -d '{"code":"CLK-1","escapementType":"杠杆","balanceFrequency":"21600vph"}' | jq -r .data.id)

# 鉴定师登记
AID=$(curl -s -X POST $B/clocks/$CID/appraisals -H 'Content-Type: application/json' \
  -H 'x-actor-id: app1' -H 'x-actor-role: appraiser' \
  -d '{"authenticity":"genuine","condition":"mint","estimatedValue":88000,"evidence":"box,papers"}' | jq -r .data.id)

# 复核人通过并签发，初始持有人 alice
SERIAL=$(curl -s -X POST $B/appraisals/$AID/review -H 'Content-Type: application/json' \
  -H 'x-actor-id: rev1' -H 'x-actor-role: reviewer' \
  -d '{"decision":"approve","ownerId":"alice"}' | jq -r .data.certificate.serial)

# alice 发起 → bob 接受
TID=$(curl -s -X POST $B/clocks/$CID/transfers -H 'Content-Type: application/json' \
  -H 'x-actor-id: alice' -H 'x-actor-role: holder' -d '{"toOwnerId":"bob"}' | jq -r .data.id)
curl -s -X POST $B/transfers/$TID/accept -H 'Content-Type: application/json' \
  -H 'x-actor-id: bob' -H 'x-actor-role: holder' -d '{}'

curl -s $B/clocks/$CID/ownership
curl -s $B/chain/verify
```

## 失败与恢复语义

- `db.json`：临时文件 + `rename` 原子替换，任何时刻读到的都是完整旧版或完整新版。
- `chain.log`：写操作在互斥锁内单次 append + `fsync`；崩溃留下的末尾截断行在下次启动时
  按字节截断到最后一条完整记录，已落盘事件永不改动。
- 中间任意一行被修改/删除/插入 → 哈希链断裂 → 所有鉴证相关读写返回
  `503 CHAIN_CORRUPTED`，且不会追加任何新事件。
