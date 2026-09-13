const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const { buildServer, chainFile, dbFile, hashEvent } = require("../server");

/* -------------------------------------------------------------------------- */
/* 测试夹具                                                                    */
/* -------------------------------------------------------------------------- */

let serverState = null;
let dataDir = null;
let baseUrl = "";
let clockSeq = 0;

async function freshServer() {
  if (serverState) {
    await serverState.close();
    serverState = null;
  }
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "clock-test-"));
  // 从干净库开始：删除 ensureStorage 自动写入的初始数据
  serverState = await buildServer({ port: 0, dataDir, allowClockOverride: true });
  baseUrl = `http://127.0.0.1:${serverState.port}`;
  clockSeq = 0;
  return serverState;
}

/** 不自动建库，用于失败恢复测试（模拟半截数据/篡改） */
async function freshServerFrom(dir) {
  if (serverState) {
    await serverState.close();
    serverState = null;
  }
  dataDir = dir;
  serverState = await buildServer({ port: 0, dataDir: dir, allowClockOverride: true });
  baseUrl = `http://127.0.0.1:${serverState.port}`;
  return serverState;
}

async function stopServer() {
  if (serverState) {
    await serverState.close();
    serverState = null;
  }
}

async function request(method, urlPath, { body, raw, headers = {}, now } = {}) {
  const allHeaders = { ...headers };
  let payload;
  if (raw !== undefined) {
    payload = raw;
    if (raw !== "") allHeaders["Content-Type"] = "application/json";
  } else if (body !== undefined) {
    allHeaders["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  if (now) allHeaders["x-now"] = now;
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: allHeaders,
    body: payload
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

const ACT = {
  appraiser: (id) => ({ "x-actor-id": id, "x-actor-role": "appraiser" }),
  reviewer: (id) => ({ "x-actor-id": id, "x-actor-role": "reviewer" }),
  holder: (id) => ({ "x-actor-id": id, "x-actor-role": "holder" })
};

async function createClock(codeSuffix) {
  clockSeq += 1;
  const res = await request("POST", "/clocks", {
    body: {
      code: `CLK-T-${clockSeq}-${codeSuffix || ""}`,
      escapementType: "瑞士杠杆式",
      balanceFrequency: "21600vph"
    }
  });
  assert.equal(res.status, 201, res.body && JSON.stringify(res.body));
  return res.body.data.id;
}

async function registerApproved(clockId, { appraiser = "app1", reviewer = "rev1", owner = "alice", approvedAt } = {}) {
  const reg = await request("POST", `/clocks/${clockId}/appraisals`, {
    headers: ACT.appraiser(appraiser),
    now: approvedAt,
    body: { authenticity: "genuine", condition: "uncirculated", estimatedValue: 100000, evidence: "photo#1" }
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const appraisalId = reg.body.data.id;
  const rev = await request("POST", `/appraisals/${appraisalId}/review`, {
    headers: ACT.reviewer(reviewer),
    now: approvedAt,
    body: { decision: "approve", ownerId: owner }
  });
  assert.equal(rev.status, 200, JSON.stringify(rev.body));
  return {
    appraisalId,
    serial: rev.body.data.certificate.serial
  };
}

async function proposeAndAccept(clockId, from, to, { at } = {}) {
  const prop = await request("POST", `/clocks/${clockId}/transfers`, {
    headers: ACT.holder(from),
    now: at,
    body: { toOwnerId: to }
  });
  assert.equal(prop.status, 201, JSON.stringify(prop.body));
  const transferId = prop.body.data.id;
  const acc = await request("POST", `/transfers/${transferId}/accept`, {
    headers: ACT.holder(to),
    now: at,
    body: {}
  });
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  return transferId;
}

async function readChain() {
  const raw = await fs.readFile(chainFile(dataDir), "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await freshServer();
});

afterEach(async () => {
  await stopServer();
});

/* -------------------------------------------------------------------------- */
/* 1. 正常流程                                                                 */
/* -------------------------------------------------------------------------- */

test("正常流程：登记鉴证→复核签发唯一证书→发起转让→接受→所有权与历史可查", async () => {
  const clockId = await createClock("happy");

  // 鉴定师登记
  const reg = await request("POST", `/clocks/${clockId}/appraisals`, {
    headers: ACT.appraiser("app1"),
    body: { authenticity: "genuine", condition: "mint", estimatedValue: 68000, evidence: "box,papers" }
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.data.status, "pending");
  assert.equal(reg.body.data.appraiserId, "app1");

  // 复核人通过并签发
  const rev = await request("POST", `/appraisals/${reg.body.data.id}/review`, {
    headers: ACT.reviewer("rev1"),
    body: { decision: "approve", ownerId: "alice" }
  });
  assert.equal(rev.status, 200);
  assert.equal(rev.body.data.certificate.status, "valid");
  assert.match(rev.body.data.certificate.serial, /^CERT-\d{4}-[0-9A-F]{12}$/);
  const serial = rev.body.data.certificate.serial;

  // 同一钟表只有一张有效证书
  const certs = await request("GET", `/certificates?clockId=${clockId}&status=valid`);
  assert.equal(certs.body.data.length, 1);

  // 当前持有人 alice 发起转让给 bob
  const prop = await request("POST", `/clocks/${clockId}/transfers`, {
    headers: ACT.holder("alice"),
    body: { toOwnerId: "bob" }
  });
  assert.equal(prop.status, 201);
  assert.equal(prop.body.data.status, "pending");
  assert.equal(prop.body.data.toOwnerId, "bob");
  assert.ok(new Date(prop.body.data.expiresAt).getTime() - Date.now() > DAY - 60_000);

  // 目标持有人接受
  const acc = await request("POST", `/transfers/${prop.body.data.id}/accept`, {
    headers: ACT.holder("bob"),
    body: {}
  });
  assert.equal(acc.status, 200);
  assert.equal(acc.body.data.ownership.ownerId, "bob");

  // 所有权与历史
  const own = await request("GET", `/clocks/${clockId}/ownership`);
  assert.equal(own.body.data.current.ownerId, "bob");
  assert.deepEqual(
    own.body.data.history.map((h) => [h.type, h.fromOwnerId, h.ownerId]),
    [
      ["issued", null, "alice"],
      ["transfer", "alice", "bob"]
    ]
  );
});

test("正常流程：复核驳回不签发证书，重新登记后可再鉴证签发", async () => {
  const clockId = await createClock("reject");
  const reg = await request("POST", `/clocks/${clockId}/appraisals`, {
    headers: ACT.appraiser("app1"),
    body: { authenticity: "genuine", condition: "good", estimatedValue: 1000 }
  });
  const reject = await request("POST", `/appraisals/${reg.body.data.id}/review`, {
    headers: ACT.reviewer("rev1"),
    body: { decision: "reject", reason: "凭证不足" }
  });
  assert.equal(reject.status, 200);
  assert.equal(reject.body.data.appraisal.status, "rejected");
  assert.equal(reject.body.data.certificate, null);

  const certs = await request("GET", `/certificates?clockId=${clockId}`);
  assert.equal(certs.body.data.length, 0);

  // 可再次登记并通过
  const { serial } = await registerApproved(clockId);
  assert.ok(serial);
});

/* -------------------------------------------------------------------------- */
/* 2. 越权：三类角色只能操作各自环节                                           */
/* -------------------------------------------------------------------------- */

test("越权：鉴定师不能复核，复核人不能登记鉴证，持有人不能签发/撤销", async () => {
  const clockId = await createClock("authz");
  const reg = await request("POST", `/clocks/${clockId}/appraisals`, {
    headers: ACT.reviewer("rev1"),
    body: { authenticity: "x", condition: "x", estimatedValue: 1 }
  });
  assert.equal(reg.status, 403);
  assert.equal(reg.body.code, "FORBIDDEN_ROLE");

  const regOk = await request("POST", `/clocks/${clockId}/appraisals`, {
    headers: ACT.appraiser("app1"),
    body: { authenticity: "genuine", condition: "good", estimatedValue: 1 }
  });
  const appraisalId = regOk.body.data.id;

  const reviewByAppraiser = await request("POST", `/appraisals/${appraisalId}/review`, {
    headers: ACT.appraiser("app1"),
    body: { decision: "approve", ownerId: "alice" }
  });
  assert.equal(reviewByAppraiser.status, 403);

  const reviewByHolder = await request("POST", `/appraisals/${appraisalId}/review`, {
    headers: ACT.holder("alice"),
    body: { decision: "approve", ownerId: "alice" }
  });
  assert.equal(reviewByHolder.status, 403);

  // 正常签发（由合规复核人复核此前已登记的鉴证）
  const approved = await request("POST", `/appraisals/${appraisalId}/review`, {
    headers: ACT.reviewer("rev9"),
    body: { decision: "approve", ownerId: "alice" }
  });
  assert.equal(approved.status, 200);
  const serial = approved.body.data.certificate.serial;

  const revokeByHolder = await request("POST", `/certificates/${serial}/revoke`, {
    headers: ACT.holder("alice"),
    body: { reason: "x" }
  });
  assert.equal(revokeByHolder.status, 403);

  const revokeByAppraiser = await request("POST", `/certificates/${serial}/revoke`, {
    headers: ACT.appraiser("app1"),
    body: { reason: "x" }
  });
  assert.equal(revokeByAppraiser.status, 403);
});

test("越权：非当前持有人不能发起转让；非目标持有人不能接受；不能接受他人的转让", async () => {
  const clockId = await createClock("authz2");
  await registerApproved(clockId, { owner: "alice" });

  // 陌生人发起
  const stranger = await request("POST", `/clocks/${clockId}/transfers`, {
    headers: ACT.holder("mallory"),
    body: { toOwnerId: "bob" }
  });
  assert.equal(stranger.status, 403);

  const prop = await request("POST", `/clocks/${clockId}/transfers`, {
    headers: ACT.holder("alice"),
    body: { toOwnerId: "bob" }
  });
  const transferId = prop.body.data.id;

  // 原持有人自己不能接受
  const selfAccept = await request("POST", `/transfers/${transferId}/accept`, {
    headers: ACT.holder("alice"),
    body: {}
  });
  assert.equal(selfAccept.status, 403);

  // 第三方不能接受
  const third = await request("POST", `/transfers/${transferId}/accept`, {
    headers: ACT.holder("carol"),
    body: {}
  });
  assert.equal(third.status, 403);
});

test("越权：缺少身份头 401；未知角色 403；复核人不能复核自己登记的鉴证", async () => {
  const clockId = await createClock("authz3");
  const noHead = await request("POST", `/clocks/${clockId}/appraisals`, {
    body: { authenticity: "genuine", condition: "x", estimatedValue: 1 }
  });
  assert.equal(noHead.status, 401);

  const badRole = await request("POST", `/clocks/${clockId}/appraisals`, {
    headers: { "x-actor-id": "x", "x-actor-role": "admin" },
    body: { authenticity: "genuine", condition: "x", estimatedValue: 1 }
  });
  assert.equal(badRole.status, 403);

  // 同一人同时是 appraiser/reviewer 角色也不能自审（按 actorId 判定）
  const reg = await request("POST", `/clocks/${clockId}/appraisals`, {
    headers: ACT.appraiser("sameperson"),
    body: { authenticity: "genuine", condition: "x", estimatedValue: 1 }
  });
  const selfReview = await request("POST", `/appraisals/${reg.body.data.id}/review`, {
    headers: ACT.reviewer("sameperson"),
    body: { decision: "approve", ownerId: "alice" }
  });
  assert.equal(selfReview.status, 403);
  assert.equal(selfReview.body.code, "SELF_REVIEW_FORBIDDEN");
});

/* -------------------------------------------------------------------------- */
/* 3. 重复：重复签发、重复接受、重复发起                                       */
/* -------------------------------------------------------------------------- */

test("重复：已签发证书不能重复复核/重复鉴证；撤销不能重复", async () => {
  const clockId = await createClock("dup1");
  const { appraisalId, serial } = await registerApproved(clockId);

  const secondReview = await request("POST", `/appraisals/${appraisalId}/review`, {
    headers: ACT.reviewer("rev2"),
    body: { decision: "approve", ownerId: "alice2" }
  });
  assert.equal(secondReview.status, 409);
  assert.equal(secondReview.body.code, "APPRAISAL_NOT_PENDING");

  const secondAppraisal = await request("POST", `/clocks/${clockId}/appraisals`, {
    headers: ACT.appraiser("app2"),
    body: { authenticity: "fake", condition: "x", estimatedValue: 1 }
  });
  assert.equal(secondAppraisal.status, 409);
  assert.equal(secondAppraisal.body.code, "CERTIFICATE_EXISTS");

  const revoke1 = await request("POST", `/certificates/${serial}/revoke`, {
    headers: ACT.reviewer("rev1"),
    body: { reason: "first" }
  });
  assert.equal(revoke1.status, 200);
  const revoke2 = await request("POST", `/certificates/${serial}/revoke`, {
    headers: ACT.reviewer("rev1"),
    body: { reason: "second" }
  });
  assert.equal(revoke2.status, 409);
  assert.equal(revoke2.body.code, "CERTIFICATE_NOT_VALID");
});

test("重复：待处理转让期间不能重复发起；接受后不能重复接受", async () => {
  const clockId = await createClock("dup2");
  await registerApproved(clockId, { owner: "alice" });

  const p1 = await request("POST", `/clocks/${clockId}/transfers`, {
    headers: ACT.holder("alice"),
    body: { toOwnerId: "bob" }
  });
  assert.equal(p1.status, 201);

  const p2 = await request("POST", `/clocks/${clockId}/transfers`, {
    headers: ACT.holder("alice"),
    body: { toOwnerId: "carol" }
  });
  assert.equal(p2.status, 409);
  assert.equal(p2.body.code, "TRANSFER_PENDING");

  const a1 = await request("POST", `/transfers/${p1.body.data.id}/accept`, {
    headers: ACT.holder("bob"),
    body: {}
  });
  assert.equal(a1.status, 200);

  const a2 = await request("POST", `/transfers/${p1.body.data.id}/accept`, {
    headers: ACT.holder("bob"),
    body: {}
  });
  assert.equal(a2.status, 409);
  assert.equal(a2.body.code, "TRANSFER_ALREADY_ACCEPTED");

  // 接受完成后可以发起下一笔
  const p3 = await request("POST", `/clocks/${clockId}/transfers`, {
    headers: ACT.holder("bob"),
    body: { toOwnerId: "carol" }
  });
  assert.equal(p3.status, 201);
});

/* -------------------------------------------------------------------------- */
/* 4. 并发：并发接受只有一笔成功；并发发起只有一笔成功                          */
/* -------------------------------------------------------------------------- */

test("并发：目标持有人重复/并发接受，恰好一笔成功且无半截数据", async () => {
  const clockId = await createClock("conc1");
  await registerApproved(clockId, { owner: "alice" });
  const prop = await request("POST", `/clocks/${clockId}/transfers`, {
    headers: ACT.holder("alice"),
    body: { toOwnerId: "bob" }
  });
  const transferId = prop.body.data.id;

  // 同一路径并发 10 次接受
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      request("POST", `/transfers/${transferId}/accept`, { headers: ACT.holder("bob"), body: {} })
    )
  );
  const ok = results.filter((r) => r.status === 200);
  const conflict = results.filter((r) => r.status === 409);
  assert.equal(ok.length, 1, `应有且仅有一次成功，实际 ${ok.length}`);
  assert.equal(conflict.length, 9);

  const own = await request("GET", `/clocks/${clockId}/ownership`);
  assert.equal(own.body.data.current.ownerId, "bob");

  // 链路完整：每个 accepted 事件只有一个
  const records = await readChain();
  const accepted = records.filter((r) => r.event.type === "transfer.accepted");
  assert.equal(accepted.length, 1);
});

test("并发：持有人同时发起多笔转让，恰好一笔进入 pending", async () => {
  const clockId = await createClock("conc2");
  await registerApproved(clockId, { owner: "alice" });

  const results = await Promise.all(
    ["bob", "carol", "dave", "erin"].map((to) =>
      request("POST", `/clocks/${clockId}/transfers`, {
        headers: ACT.holder("alice"),
        body: { toOwnerId: to }
      })
    )
  );
  const ok = results.filter((r) => r.status === 201);
  assert.equal(ok.length, 1, `应有且仅有一笔待处理，实际 ${ok.length}`);
  assert.equal(results.filter((r) => r.status === 409).length, 3);

  const pending = await request("GET", `/transfers?clockId=${clockId}&status=pending`);
  assert.equal(pending.body.data.length, 1);
});

/* -------------------------------------------------------------------------- */
/* 5. 撤销：撤销后非法流转全部拒绝；待处理转让一并作废                          */
/* -------------------------------------------------------------------------- */

test("撤销：无有效证书不能发起转让；撤销后转让/再转让被拒", async () => {
  const clockId = await createClock("rev1");

  // 未签发证书前不能转让
  const before = await request("POST", `/clocks/${clockId}/transfers`, {
    headers: ACT.holder("alice"),
    body: { toOwnerId: "bob" }
  });
  assert.equal(before.status, 409);
  assert.equal(before.body.code, "NO_VALID_CERTIFICATE");

  const { serial } = await registerApproved(clockId, { owner: "alice" });

  const revoke = await request("POST", `/certificates/${serial}/revoke`, {
    headers: ACT.reviewer("rev1"),
    body: { reason: "凭证造假" }
  });
  assert.equal(revoke.status, 200);
  assert.equal(revoke.body.data.certificate.status, "revoked");

  const after = await request("POST", `/clocks/${clockId}/transfers`, {
    headers: ACT.holder("alice"),
    body: { toOwnerId: "bob" }
  });
  assert.equal(after.status, 409);
  assert.equal(after.body.code, "NO_VALID_CERTIFICATE");

  // 证书查询：valid 列表为空、revoked 可查
  const valid = await request("GET", `/certificates?clockId=${clockId}&status=valid`);
  assert.equal(valid.body.data.length, 0);
  const revoked = await request("GET", `/certificates?clockId=${clockId}&status=revoked`);
  assert.equal(revoked.body.data.length, 1);
});

test("撤销：待处理转让随证书撤销一并作废，目标再接受被拒，且可重新发起", async () => {
  const clockId = await createClock("rev2");
  const { serial } = await registerApproved(clockId, { owner: "alice" });
  const prop = await request("POST", `/clocks/${clockId}/transfers`, {
    headers: ACT.holder("alice"),
    body: { toOwnerId: "bob" }
  });
  const transferId = prop.body.data.id;

  const revoke = await request("POST", `/certificates/${serial}/revoke`, {
    headers: ACT.reviewer("rev1"),
    body: { reason: "争议冻结" }
  });
  assert.equal(revoke.status, 200);
  assert.equal(revoke.body.data.voidedTransferId, transferId);

  const accept = await request("POST", `/transfers/${transferId}/accept`, {
    headers: ACT.holder("bob"),
    body: {}
  });
  assert.equal(accept.status, 409);

  // 所有权未变
  const own = await request("GET", `/clocks/${clockId}/ownership`);
  assert.equal(own.body.data.current.ownerId, "alice");
  assert.equal(own.body.data.current.certificateSerial, null);
});

/* -------------------------------------------------------------------------- */
/* 6. 超时：24 小时未接受自动失效，失效后释放名额且不可接受                     */
/* -------------------------------------------------------------------------- */

test("超时：恰好24小时后接受被拒并自动失效，之后可重新发起", async () => {
  const clockId = await createClock("ttl");
  await registerApproved(clockId, { owner: "alice", approvedAt: "2026-01-01T00:00:00.000Z" });

  const t0 = "2026-01-01T00:00:00.000Z";
  const prop = await request("POST", `/clocks/${clockId}/transfers`, {
    headers: ACT.holder("alice"),
    now: t0,
    body: { toOwnerId: "bob" }
  });
  assert.equal(prop.status, 201);
  const transferId = prop.body.data.id;
  assert.equal(prop.body.data.expiresAt, "2026-01-02T00:00:00.000Z");

  // 24 小时差 1 秒：仍可接受（撤销该笔后重开一笔做边界）
  // —— 直接验证临界点：到达 24h，接受触发惰性过期
  const late = await request("POST", `/transfers/${transferId}/accept`, {
    headers: ACT.holder("bob"),
    now: "2026-01-02T00:00:00.000Z",
    body: {}
  });
  assert.equal(late.status, 409);
  assert.equal(late.body.code, "TRANSFER_EXPIRED");

  // 状态已自动落盘为 expired
  const got = await request("GET", `/transfers?clockId=${clockId}`);
  assert.equal(got.body.data[0].status, "expired");
  assert.ok(got.body.data[0].resolvedAt);

  // 同一钟表再发起新转让：原 pending 名额已释放（边界前再验证一次未超时可接受）
  const prop2 = await request("POST", `/clocks/${clockId}/transfers`, {
    headers: ACT.holder("alice"),
    now: "2026-01-02T01:00:00.000Z",
    body: { toOwnerId: "carol" }
  });
  assert.equal(prop2.status, 201);
  const accept2 = await request("POST", `/transfers/${prop2.body.data.id}/accept`, {
    headers: ACT.holder("carol"),
    now: "2026-01-02T01:00:30.000Z",
    body: {}
  });
  assert.equal(accept2.status, 200);
});

test("超时：23:59:59 仍在窗口内可以接受", async () => {
  const clockId = await createClock("ttl2");
  await registerApproved(clockId, { owner: "alice", approvedAt: "2026-03-01T08:00:00.000Z" });
  const t0 = "2026-03-01T08:00:00.000Z";
  const prop = await request("POST", `/clocks/${clockId}/transfers`, {
    headers: ACT.holder("alice"),
    now: t0,
    body: { toOwnerId: "bob" }
  });
  const within = await request("POST", `/transfers/${prop.body.data.id}/accept`, {
    headers: ACT.holder("bob"),
    now: "2026-03-02T07:59:59.000Z",
    body: {}
  });
  assert.equal(within.status, 200, JSON.stringify(within.body));
});

test("超时：重启后未决转让到达24小时同样被判定失效（持久化恢复）", async () => {
  const clockId = await createClock("ttl3");
  await registerApproved(clockId, { owner: "alice", approvedAt: "2026-02-01T00:00:00.000Z" });
  const prop = await request("POST", `/clocks/${clockId}/transfers`, {
    headers: ACT.holder("alice"),
    now: "2026-02-01T00:00:00.000Z",
    body: { toOwnerId: "bob" }
  });
  const transferId = prop.body.data.id;

  const dir = dataDir;
  await stopServer();
  // 用一个“当前时间已经超过24h”的方式重启：注入时间通过 x-now 在请求时驱动；
  // 重启后第一次访问该转让即应过期
  await freshServerFrom(dir);

  const accept = await request("POST", `/transfers/${transferId}/accept`, {
    headers: ACT.holder("bob"),
    now: "2026-02-03T00:00:00.000Z",
    body: {}
  });
  assert.equal(accept.status, 409);
  assert.equal(accept.body.code, "TRANSFER_EXPIRED");

  const own = await request("GET", `/clocks/${clockId}/ownership`);
  assert.equal(own.body.data.current.ownerId, "alice");
});

/* -------------------------------------------------------------------------- */
/* 7. 失败恢复：半截写截断、篡改检测、重启重放                                 */
/* -------------------------------------------------------------------------- */

test("失败恢复：重启后证书、所有权、链路均可查且哈希一致", async () => {
  const clockId = await createClock("persist");
  const { serial } = await registerApproved(clockId, { owner: "alice" });
  await proposeAndAccept(clockId, "alice", "bob");
  await proposeAndAccept(clockId, "bob", "carol");

  const dir = dataDir;
  await stopServer();
  await freshServerFrom(dir);

  const cert = await request("GET", `/clocks/${clockId}/certificate`);
  assert.equal(cert.body.data.valid.serial, serial);
  assert.equal(cert.body.data.valid.status, "valid");

  const own = await request("GET", `/clocks/${clockId}/ownership`);
  assert.equal(own.body.data.current.ownerId, "carol");
  assert.equal(own.body.data.history.length, 3); // issued + 2 transfers

  const verify = await request("GET", "/chain/verify");
  assert.equal(verify.status, 200);
  assert.equal(verify.body.data.ok, true);
});

test("失败恢复：链路末尾半截写（崩溃在 append 中途）启动时自动截断恢复", async () => {
  const clockId = await createClock("crash");
  await registerApproved(clockId, { owner: "alice" });
  const prop = await request("POST", `/clocks/${clockId}/transfers`, {
    headers: ACT.holder("alice"),
    body: { toOwnerId: "bob" }
  });
  assert.equal(prop.status, 201);
  const chainLengthBefore = (await readChain()).length;

  const dir = dataDir;
  const chainPath = chainFile(dir);
  await stopServer();

  // 模拟崩溃：追加一行被截断的 JSON（没有换行结尾）
  const partial = '{"prevHash":"000","event":{"type":"transfer.accepted","transferId":"broken'
  await fs.appendFile(chainPath, partial, "utf8");

  await freshServerFrom(dir);

  // 半截行被丢弃，链路完好；服务可继续工作
  const verify = await request("GET", "/chain/verify");
  assert.equal(verify.status, 200);
  assert.equal(verify.body.data.length, chainLengthBefore);

  // 待处理转让仍然有效，可正常接受（崩溃未破坏已落盘数据）
  const pending = await request("GET", `/transfers?clockId=${clockId}&status=pending`);
  assert.equal(pending.body.data.length, 1);
  const accept = await request("POST", `/transfers/${pending.body.data[0].id}/accept`, {
    headers: ACT.holder("bob"),
    body: {}
  });
  assert.equal(accept.status, 200);
});

test("失败恢复：db.json 写坏（半截JSON）时原子写保证文件不存在该状态（无 tmp 残留）", async () => {
  const clockId = await createClock("atomic");
  await registerApproved(clockId, { owner: "alice" });
  const dir = dataDir;
  const files = await fs.readdir(dir);
  // 原子写：任何时刻都不应留下 tmp 文件
  assert.equal(files.filter((f) => f.endsWith("tmp") || f.includes(".tmp.")).length, 0);
  // db.json 始终是合法 JSON
  JSON.parse(await fs.readFile(dbFile(dir), "utf8"));
});

test("失败恢复：链路中任一历史事件被篡改，服务拒绝读写并报完整性错误", async () => {
  const clockId = await createClock("tamper");
  await registerApproved(clockId, { owner: "alice" });
  await proposeAndAccept(clockId, "alice", "bob");

  const dir = dataDir;
  const chainPath = chainFile(dir);
  await stopServer();

  // 篡改第一条历史事件（改估价）
  const raw = await fs.readFile(chainPath, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const first = JSON.parse(lines[0]);
  first.event.estimatedValue = 1;
  lines[0] = JSON.stringify(first);
  await fs.writeFile(chainPath, lines.join("\n") + "\n", "utf8");

  await freshServerFrom(dir);

  const verify = await request("GET", "/chain/verify");
  assert.equal(verify.status, 503);
  assert.equal(verify.body.code, "CHAIN_CORRUPTED");

  // 命令也全部拒绝，且不产生新事件
  const reject = await request("POST", `/clocks/${clockId}/transfers`, {
    headers: ACT.holder("bob"),
    body: { toOwnerId: "carol" }
  });
  assert.equal(reject.status, 503);

  const records = (await fs.readFile(chainPath, "utf8")).split("\n").filter(Boolean).length;
  assert.equal(records, lines.length);
});

test("失败恢复：篡改最后一行（无后继哈希牵连）同样被检测到", async () => {
  const clockId = await createClock("tamper-last");
  await registerApproved(clockId, { owner: "alice" });
  await proposeAndAccept(clockId, "alice", "bob");

  const dir = dataDir;
  const chainPath = chainFile(dir);
  await stopServer();

  const raw = await fs.readFile(chainPath, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1]);
  last.event.toOwnerId = "mallory"; // 改最后一条的受让人
  lines[lines.length - 1] = JSON.stringify(last);
  await fs.writeFile(chainPath, lines.join("\n") + "\n", "utf8");

  await freshServerFrom(dir);
  const verify = await request("GET", "/chain/verify");
  assert.equal(verify.status, 503);
  assert.equal(verify.body.code, "CHAIN_CORRUPTED");
});

test("撤销后：旧证书保持 revoked，可重新鉴证并签发全新证书再流转", async () => {
  const clockId = await createClock("reissue");
  const { serial: serial1 } = await registerApproved(clockId, {
    appraiser: "app1",
    reviewer: "rev1",
    owner: "alice"
  });

  const revoke = await request("POST", `/certificates/${serial1}/revoke`, {
    headers: ACT.reviewer("rev1"),
    body: { reason: "原始凭证存疑" }
  });
  assert.equal(revoke.status, 200);

  // 重新鉴证（不同鉴定师）+ 不同复核人签发
  const reg2 = await request("POST", `/clocks/${clockId}/appraisals`, {
    headers: ACT.appraiser("app2"),
    body: { authenticity: "genuine", condition: "fine", estimatedValue: 72000, evidence: "lab-report#9" }
  });
  assert.equal(reg2.status, 201);
  const rev2 = await request("POST", `/appraisals/${reg2.body.data.id}/review`, {
    headers: ACT.reviewer("rev2"),
    body: { decision: "approve", ownerId: "alice" }
  });
  assert.equal(rev2.status, 200);
  const serial2 = rev2.body.data.certificate.serial;
  assert.notEqual(serial2, serial1);

  // 只有一张有效证书；旧证书仍可查且为 revoked
  const valid = await request("GET", `/certificates?clockId=${clockId}&status=valid`);
  assert.equal(valid.body.data.length, 1);
  assert.equal(valid.body.data[0].serial, serial2);
  const revoked = await request("GET", `/certificates?clockId=${clockId}&status=revoked`);
  assert.equal(revoked.body.data.length, 1);

  // 持新证书恢复流转
  await proposeAndAccept(clockId, "alice", "bob");
  const own = await request("GET", `/clocks/${clockId}/ownership`);
  assert.equal(own.body.data.current.ownerId, "bob");
  assert.equal(own.body.data.current.certificateSerial, serial2);
  const types = own.body.data.history.map((h) => h.type);
  assert.deepEqual(types, ["issued", "revoked", "issued", "transfer"]);
});

/* -------------------------------------------------------------------------- */
/* 8. 链路内容与其它非法流转                                                   */
/* -------------------------------------------------------------------------- */

test("非法流转：不能转让给自己；估价非法/缺字段返回400且不落任何事件", async () => {
  const clockId = await createClock("illegal");
  await registerApproved(clockId, { owner: "alice" });

  const self = await request("POST", `/clocks/${clockId}/transfers`, {
    headers: ACT.holder("alice"),
    body: { toOwnerId: "alice" }
  });
  assert.equal(self.status, 400);

  const noTarget = await request("POST", `/clocks/${clockId}/transfers`, {
    headers: ACT.holder("alice"),
    body: {}
  });
  assert.equal(noTarget.status, 400);

  const badValue = await request("POST", `/clocks/${clockId}/appraisals`, {
    headers: ACT.appraiser("app9"),
    body: { authenticity: "genuine", condition: "x", estimatedValue: -5 }
  });
  assert.equal(badValue.status, 400);

  // 失败请求不产生链路事件：链上只应有 registered + approved
  const records = await readChain();
  assert.deepEqual(records.map((r) => r.event.type), ["appraisal.registered", "appraisal.approved"]);
});

test("链路：单钟表链路只含该钟表事件，全局链哈希首尾相连可独立验", async () => {
  const c1 = await createClock("chain1");
  const c2 = await createClock("chain2");
  await registerApproved(c1, { owner: "alice" });
  await registerApproved(c2, { owner: "zoe" });
  await proposeAndAccept(c1, "alice", "bob");

  const r1 = await request("GET", `/clocks/${c1}/chain`);
  assert.equal(r1.status, 200);
  assert.equal(r1.body.data.length, 4); // registered + approved + proposed + accepted
  assert.ok(r1.body.data.every((item) => item.event.clockId === c1));

  // 与全局链过滤结果一致（seq/prevHash/hash 以全局链为准）
  const global = await request("GET", "/chain");
  const filtered = global.body.data.filter((item) => item.event.clockId === c1);
  assert.deepEqual(
    r1.body.data.map((item) => item.hash),
    filtered.map((item) => item.hash)
  );

  // 全局链从 GENESIS 起序号连续、哈希首尾相连
  let prev = "GENESIS";
  global.body.data.forEach((item, index) => {
    assert.equal(item.seq, index + 1);
    assert.equal(item.prevHash, prev);
    assert.equal(item.hash, hashEvent(prev, item.event));
    prev = item.hash;
  });
});

test("历史：连续多手转让后所有权历史完整有序", async () => {
  const clockId = await createClock("multi");
  await registerApproved(clockId, { owner: "h0" });
  await proposeAndAccept(clockId, "h0", "h1");
  await proposeAndAccept(clockId, "h1", "h2");
  await proposeAndAccept(clockId, "h2", "h3");

  const own = await request("GET", `/clocks/${clockId}/ownership`);
  assert.equal(own.body.data.current.ownerId, "h3");
  const chain = own.body.data.history.map((h) => h.ownerId);
  assert.deepEqual(chain, ["h0", "h1", "h2", "h3"]);
});

test("安全：生产配置（未开启时间注入）下 x-now 头被拒绝", async () => {
  const prodDir = await fs.mkdtemp(path.join(os.tmpdir(), "clock-prod-"));
  const prod = await buildServer({ port: 0, dataDir: prodDir, allowClockOverride: false });
  const url = `http://127.0.0.1:${prod.port}`;
  const res = await fetch(`${url}/clocks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-now": "2000-01-01T00:00:00.000Z",
      "x-actor-id": "x",
      "x-actor-role": "appraiser"
    },
    body: JSON.stringify({ code: "P1", escapementType: "x", balanceFrequency: "x" })
  });
  // POST /clocks 不校验角色，但 x-now 一律拒绝
  assert.equal(res.status, 403);
  const json = await res.json();
  assert.equal(json.code, "CLOCK_OVERRIDE_FORBIDDEN");
  await prod.close();
  await fs.rm(prodDir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* 9. 回归：null/空体/非对象请求体                                             */
/* -------------------------------------------------------------------------- */

test("回归：鉴证登记、复核、撤销、发起转让收到坏请求体一律400，且不写链路/转让", async () => {
  const clockId = await createClock("badbody");

  const badPayloads = [
    { label: "空请求体", raw: "" },
    { label: "null", raw: "null" },
    { label: "数组", raw: "[]" },
    { label: "字符串", raw: '"abc"' },
    { label: "数字", raw: "42" },
    { label: "布尔", raw: "true" },
    { label: "非法JSON", raw: "{oops" }
  ];

  const endpoints = [
    {
      name: "鉴证登记",
      path: `/clocks/${clockId}/appraisals`,
      headers: ACT.appraiser("app1")
    },
    {
      name: "复核",
      path: "/appraisals/appraisal_nonexistent/review",
      headers: ACT.reviewer("rev1")
    },
    {
      name: "撤销",
      path: "/certificates/CERT-NONE/revoke",
      headers: ACT.reviewer("rev1")
    },
    {
      name: "发起转让",
      path: `/clocks/${clockId}/transfers`,
      headers: ACT.holder("alice")
    }
  ];

  for (const ep of endpoints) {
    for (const payload of badPayloads) {
      const res = await request("POST", ep.path, { headers: ep.headers, raw: payload.raw });
      assert.equal(
        res.status,
        400,
        `${ep.name} 对「${payload.label}」应返回400，实际 ${res.status}: ${JSON.stringify(res.body)}`
      );
      assert.ok(
        ["INVALID_BODY", "INVALID_JSON"].includes(res.body.code),
        `${ep.name} 对「${payload.label}」错误码应为 INVALID_BODY/INVALID_JSON，实际 ${res.body.code}`
      );
    }
  }

  // 所有坏请求都被挡在落盘之前：链路为空、无任何鉴证/证书/转让
  const records = await readChain();
  assert.equal(records.length, 0);
  const transfers = await request("GET", "/transfers");
  assert.equal(transfers.body.data.length, 0);
  const certs = await request("GET", "/certificates");
  assert.equal(certs.body.data.length, 0);
  const appraisals = await request("GET", `/clocks/${clockId}/appraisals`);
  assert.equal(appraisals.body.data.length, 0);
});

test("回归：坏请求之后完整成功流程（鉴证→签发→转让→接受）与并发互斥仍正常", async () => {
  const clockId = await createClock("badafter");

  // 先制造一批坏请求
  for (const raw of ["", "null", "[]", "42", "{x"]) {
    await request("POST", `/clocks/${clockId}/appraisals`, { headers: ACT.appraiser("app1"), raw });
  }

  // 完整成功流程
  const reg = await request("POST", `/clocks/${clockId}/appraisals`, {
    headers: ACT.appraiser("app1"),
    body: { authenticity: "genuine", condition: "mint", estimatedValue: 50000, evidence: "docs" }
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));

  const rev = await request("POST", `/appraisals/${reg.body.data.id}/review`, {
    headers: ACT.reviewer("rev1"),
    body: { decision: "approve", ownerId: "alice" }
  });
  assert.equal(rev.status, 200);
  const serial = rev.body.data.certificate.serial;

  // 撤销入口的空体被 400 拒绝，证书仍然有效（失败不改变状态）
  const emptyRevoke = await request("POST", `/certificates/${serial}/revoke`, {
    headers: ACT.reviewer("rev1"),
    raw: ""
  });
  assert.equal(emptyRevoke.status, 400);
  const stillValid = await request("GET", `/certificates?clockId=${clockId}&status=valid`);
  assert.equal(stillValid.body.data.length, 1);

  const prop = await request("POST", `/clocks/${clockId}/transfers`, {
    headers: ACT.holder("alice"),
    body: { toOwnerId: "bob" }
  });
  assert.equal(prop.status, 201);
  const transferId = prop.body.data.id;

  // 空接受体此前为合法（{}）；真正空体现在按 400 拒绝，且转让仍停留在 pending
  const emptyAccept = await request("POST", `/transfers/${transferId}/accept`, {
    headers: ACT.holder("bob"),
    raw: ""
  });
  assert.equal(emptyAccept.status, 400);

  // 并发接受仍恰好一笔成功
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      request("POST", `/transfers/${transferId}/accept`, { headers: ACT.holder("bob"), body: {} })
    )
  );
  assert.equal(results.filter((r) => r.status === 200).length, 1);

  const own = await request("GET", `/clocks/${clockId}/ownership`);
  assert.equal(own.body.data.current.ownerId, "bob");

  // 链上恰为 registered/approved/proposed/accepted 四个事件，坏请求无一落链
  const records = await readChain();
  assert.deepEqual(
    records.map((r) => r.event.type),
    ["appraisal.registered", "appraisal.approved", "transfer.proposed", "transfer.accepted"]
  );
});

