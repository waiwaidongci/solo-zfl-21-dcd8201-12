const http = require("http");
const { readFile, writeFile, mkdir, open } = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3021);
const DEFAULT_DATA_DIR = path.join(__dirname, "data");

const TRANSFER_TTL_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

function dbFile(dataDir) {
  return path.join(dataDir, "db.json");
}
function chainFile(dataDir) {
  return path.join(dataDir, "chain.log");
}

const ROLES = {
  appraiser: "appraiser", // 鉴定师
  reviewer: "reviewer", // 复核人
  holder: "holder" // 持有人
};

const initialData = {
  clocks: [
    {
      id: "clock_demo",
      code: "CLK-1890-07",
      escapementType: "瑞士杠杆式",
      balanceFrequency: "18000vph",
      targetDailyRateSeconds: 20,
      note: "怀表机芯，走时偏快",
      createdAt: "2026-06-16T00:00:00.000Z"
    }
  ],
  adjustments: [
    {
      id: "adjustment_demo",
      clockId: "clock_demo",
      currentDailyRateSeconds: 68,
      direction: "慢针方向",
      amount: "游丝快慢针向慢侧微调0.4格",
      note: "初次调校，先保守处理",
      createdAt: "2026-06-16T00:00:00.000Z"
    }
  ],
  retests: [
    {
      id: "retest_demo",
      clockId: "clock_demo",
      adjustmentId: "adjustment_demo",
      testedAt: "2026-06-16T00:00:00.000Z",
      dailyRateSeconds: 31,
      amplitude: 248,
      qualified: false,
      note: "仍偏快，振幅尚可"
    }
  ]
};

const routes = [
  "GET /health",
  "GET /clocks",
  "POST /clocks",
  "GET /clocks/not-qualified",
  "GET /clocks/:id/history",
  "POST /clocks/:id/adjustments",
  "POST /clocks/:id/retests",
  "GET /clocks/:id/latest-retest",
  "GET /adjustments",
  "GET /retests",
  // 鉴证与所有权流转
  "POST /clocks/:id/appraisals",
  "GET  /clocks/:id/appraisals",
  "POST /appraisals/:id/review",
  "POST /certificates/:serial/revoke",
  "GET  /clocks/:id/certificate",
  "GET  /certificates?status=",
  "POST /clocks/:id/transfers",
  "POST /transfers/:id/accept",
  "GET  /transfers?clockId=&status=",
  "GET  /clocks/:id/ownership",
  "GET  /clocks/:id/chain",
  "GET  /chain",
  "GET  /chain/verify"
];

/* -------------------------------------------------------------------------- */
/* 工具函数                                                                    */
/* -------------------------------------------------------------------------- */

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || "ERROR";
  }
}

function required(body, fields) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "请求体必须是 JSON 对象", "INVALID_BODY");
  }
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) throw new HttpError(400, `缺少字段：${missing.join(", ")}`, "MISSING_FIELDS");
}

/** 简单的异步互斥锁：同一时刻只允许一个写事务，杜绝并发接受/重复发起的竞态 */
function createMutex() {
  let tail = Promise.resolve();
  return function withLock(task) {
    const run = tail.then(() => task());
    // 无论成功失败都释放锁
    tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
}

/** 临时文件 + rename 的原子写：崩溃只会留下旧文件或完整新文件，不会出现半截 JSON */
async function atomicWrite(file, content) {
  const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, content, { encoding: "utf8" });
  await renameOver(tmp, file);
}

async function renameOver(tmp, target) {
  const fsp = require("fs/promises");
  try {
    await fsp.rename(tmp, target);
  } catch (error) {
    if (error.code === "ENOTEMPTY" || error.code === "EPERM") {
      // Windows 等平台 rename 覆盖已存在文件可能失败
      await fsp.unlink(target).catch(() => {});
      await fsp.rename(tmp, target);
    } else {
      throw error;
    }
  }
}

function canonicalJson(value) {
  return JSON.stringify(value === undefined ? null : value);
}

function hashEvent(prevHash, event) {
  return crypto
    .createHash("sha256")
    .update(prevHash)
    .update("\0")
    .update(canonicalJson(event))
    .digest("hex");
}

/* -------------------------------------------------------------------------- */
/* 存储：调校数据 db.json + 不可修改链路 chain.log                             */
/* -------------------------------------------------------------------------- */

async function ensureStorage(dataDir) {
  await mkdir(dataDir, { recursive: true });
  const dbPath = dbFile(dataDir);
  const chainPath = chainFile(dataDir);
  try {
    JSON.parse(await readFile(dbPath, "utf8"));
  } catch {
    await atomicWrite(dbPath, JSON.stringify(initialData, null, 2));
  }
  try {
    await readFile(chainPath, "utf8");
  } catch {
    await writeFile(chainPath, "", { flag: "wx" }).catch(() => {});
  }
}

async function readDb(dataDir) {
  await ensureStorage(dataDir);
  return JSON.parse(await readFile(dbFile(dataDir), "utf8"));
}

async function writeDb(dataDir, data) {
  await atomicWrite(dbFile(dataDir), JSON.stringify(data, null, 2));
}

/**
 * 加载 append-only 链路：
 *  - 中间任何一行损坏/哈希不连：判定整链被篡改，置 integrityError，账本接口全部拒绝
 *  - 仅最后一行是半截写（进程在 append 中途被杀）：截断到最后一条完整记录，
 *    这是失败恢复的唯一允许动作，不会修改任何已落盘的完整事件
 */
async function loadChain(dataDir) {
  await ensureStorage(dataDir);
  const chainPath = chainFile(dataDir);
  const raw = await readFile(chainPath, "utf8").catch(() => "");
  const recordsList = [];
  const events = [];
  let prevHash = "GENESIS";
  let validBytes = 0;
  let integrityError = null;

  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "" && i === lines.length - 1) break; // 结尾换行
    if (line === "") {
      integrityError = `第 ${i + 1} 行为空，链路格式被破坏`;
      break;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      if (i === lines.length - 1 && !raw.endsWith("\n")) break; // 末尾半截行：丢弃并截断
      integrityError = `第 ${i + 1} 行不是合法JSON，链路被破坏`;
      break;
    }
    const expected = hashEvent(prevHash, record.event);
    if (record.prevHash !== prevHash || record.hash !== expected) {
      integrityError = `第 ${i + 1} 行哈希校验失败，链路已被篡改`;
      break;
    }
    recordsList.push(record);
    events.push(record.event);
    prevHash = record.hash;
    validBytes += Buffer.byteLength(line, "utf8") + 1;
  }

  if (!integrityError && validBytes < Buffer.byteLength(raw, "utf8")) {
    // 末尾存在半截行：原子截断，保证后续 append 从干净位置开始
    const fh = await open(chainPath, "r+");
    try {
      await fh.truncate(validBytes);
    } finally {
      await fh.close();
    }
  }

  return { records: recordsList, events, tailHash: prevHash, integrityError };
}

/* -------------------------------------------------------------------------- */
/* 状态机：由链路事件重放（fold）得到当前视图                                   */
/* -------------------------------------------------------------------------- */

function emptyLedger() {
  return {
    appraisals: new Map(), // id -> appraisal
    certificates: new Map(), // serial -> certificate
    transfers: new Map(), // id -> transfer
    ownership: new Map(), // clockId -> { ownerId, certificateSerial, since }
    chain: [], // 完整事件（含序号/哈希），查询用
    tailHash: "GENESIS",
    integrityError: null
  };
}

function fold(ledger, record, index) {
  const { event, prevHash, hash } = record;
  ledger.chain.push({ seq: index + 1, event, prevHash, hash });

  switch (event.type) {
    case "appraisal.registered": {
      ledger.appraisals.set(event.appraisalId, {
        id: event.appraisalId,
        clockId: event.clockId,
        authenticity: event.authenticity,
        condition: event.condition,
        estimatedValue: event.estimatedValue,
        evidence: event.evidence,
        appraiserId: event.actor.actorId,
        status: "pending",
        certificateSerial: null,
        registeredAt: event.at
      });
      break;
    }
    case "appraisal.approved": {
      const appraisal = ledger.appraisals.get(event.appraisalId);
      if (appraisal) appraisal.status = "approved";
      ledger.certificates.set(event.certificateSerial, {
        serial: event.certificateSerial,
        clockId: event.clockId,
        appraisalId: event.appraisalId,
        appraiserId: event.appraiserId,
        reviewerId: event.actor.actorId,
        authenticity: event.authenticity,
        condition: event.condition,
        estimatedValue: event.estimatedValue,
        status: "valid",
        issuedAt: event.at,
        revokedAt: null,
        revokeReason: null
      });
      if (appraisal) appraisal.certificateSerial = event.certificateSerial;
      ledger.ownership.set(event.clockId, {
        ownerId: event.ownerId,
        certificateSerial: event.certificateSerial,
        since: event.at
      });
      break;
    }
    case "appraisal.rejected": {
      const appraisal = ledger.appraisals.get(event.appraisalId);
      if (appraisal) {
        appraisal.status = "rejected";
        appraisal.reviewNote = event.reason;
        appraisal.reviewedAt = event.at;
      }
      break;
    }
    case "certificate.revoked": {
      const cert = ledger.certificates.get(event.certificateSerial);
      if (cert) {
        cert.status = "revoked";
        cert.revokedAt = event.at;
        cert.revokeReason = event.reason;
      }
      const owner = ledger.ownership.get(event.clockId);
      if (owner && owner.certificateSerial === event.certificateSerial) {
        owner.certificateSerial = null; // 证书撤销后该钟表不再可转让
      }
      break;
    }
    case "transfer.proposed": {
      ledger.transfers.set(event.transferId, {
        id: event.transferId,
        clockId: event.clockId,
        certificateSerial: event.certificateSerial,
        fromOwnerId: event.fromOwnerId,
        toOwnerId: event.toOwnerId,
        status: "pending",
        proposedAt: event.at,
        expiresAt: event.expiresAt,
        resolvedAt: null
      });
      break;
    }
    case "transfer.accepted": {
      const transfer = ledger.transfers.get(event.transferId);
      if (transfer) {
        transfer.status = "accepted";
        transfer.resolvedAt = event.at;
      }
      const owner = ledger.ownership.get(event.clockId);
      if (owner) {
        owner.ownerId = event.toOwnerId;
        owner.since = event.at;
      }
      break;
    }
    case "transfer.expired": {
      const transfer = ledger.transfers.get(event.transferId);
      if (transfer) {
        transfer.status = "expired";
        transfer.resolvedAt = event.at;
      }
      break;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 领域服务                                                                    */
/* -------------------------------------------------------------------------- */

function createService(options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || DEFAULT_DATA_DIR;
  // 仅测试环境允许通过 x-now 注入时间；生产始终取系统时钟
  const allowClockOverride = Boolean(options.allowClockOverride);
  const mutex = createMutex();
  const ledger = emptyLedger();
  let sweepTimer = null;

  async function init() {
    await ensureStorage(dataDir);
    const loaded = await loadChain(dataDir);
    ledger.integrityError = loaded.integrityError;
    ledger.tailHash = loaded.tailHash;
    // loadChain 已逐行校验 prevHash 与哈希，这里只做状态重放
    loaded.records.forEach((record, index) => fold(ledger, record, index));
    // 重启后补一次过期处理，之后定时兜底（真正的 24h 判定按事件时间，测试可用 x-now 驱动）
    if (!ledger.integrityError) {
      await expireDue(new Date().toISOString()).catch(() => {});
    }
    sweepTimer = setInterval(() => {
      expireDue(new Date().toISOString()).catch(() => {});
    }, SWEEP_INTERVAL_MS);
    if (sweepTimer.unref) sweepTimer.unref();
    return ledger.integrityError;
  }

  function assertHealthy() {
    if (ledger.integrityError) {
      throw new HttpError(503, `鉴证链路完整性校验失败：${ledger.integrityError}`, "CHAIN_CORRUPTED");
    }
  }

  /** 原子追加一批事件（一次业务操作 = 一批 = 一次 append），失败不留半截数据 */
  async function appendEvents(events) {
    let prevHash = ledger.tailHash;
    const lines = [];
    const records = [];
    for (const event of events) {
      const hash = hashEvent(prevHash, event);
      const record = { prevHash, event, hash };
      records.push(record);
      lines.push(JSON.stringify(record));
      prevHash = hash;
    }
    const payload = lines.join("\n") + "\n";
    await appendFileAtomic(chainFile(dataDir), payload);
    records.forEach((record, index) => fold(ledger, record, ledger.chain.length));
    ledger.tailHash = prevHash;
    return records;
  }

  async function appendFileAtomic(file, payload) {
    // O_APPEND + 单次 write：小于 PIPE_BUF/页大小的写在本地文件系统上由单次 syscall 完成；
    // 所有写操作已在互斥锁内串行化，此处追加是锁内唯一磁盘写，崩溃只可能产生末尾半截行，
    // loadChain 启动时会截断恢复。
    const fh = await open(file, "a");
    try {
      await fh.write(payload, null, "utf8");
      if (fh.sync) await fh.sync(); // fsync，降低崩溃丢数据概率
    } finally {
      await fh.close();
    }
  }

  /* ---- 查询辅助 ---- */

  function getClockOrThrow(db, clockId) {
    const clock = db.clocks.find((item) => item.id === clockId);
    if (!clock) throw new HttpError(404, "钟表不存在", "CLOCK_NOT_FOUND");
    return clock;
  }

  function getAppraisalOrThrow(appraisalId) {
    const appraisal = ledger.appraisals.get(appraisalId);
    if (!appraisal) throw new HttpError(404, "鉴证记录不存在", "APPRAISAL_NOT_FOUND");
    return appraisal;
  }

  function validCertificateFor(clockId) {
    for (const cert of ledger.certificates.values()) {
      if (cert.clockId === clockId && cert.status === "valid") return cert;
    }
    return null;
  }

  function pendingTransfer(clockId) {
    for (const transfer of ledger.transfers.values()) {
      if (transfer.clockId === clockId && transfer.status === "pending") return transfer;
    }
    return null;
  }

  function isExpired(transfer, nowIso) {
    return transfer.status === "pending" && new Date(transfer.expiresAt).getTime() <= new Date(nowIso).getTime();
  }

  /** 只读投影：已到点但尚未惰性落盘的 pending 转让，在查询时呈现为 expired */
  function projectTransfer(transfer, nowIso) {
    if (transfer.status !== "pending") return transfer;
    return { ...transfer, status: isExpired(transfer, nowIso) ? "expired" : "pending" };
  }

  function effectivePendingTransfer(clockId, nowIso) {
    const transfer = pendingTransfer(clockId);
    if (!transfer) return null;
    return isExpired(transfer, nowIso) ? null : transfer;
  }

  /** 惰性过期：所有转让命令执行前调用，保证超时转让不再可接受且释放唯一待处理名额 */
  async function expireDue(nowIso) {
    const due = [];
    for (const transfer of ledger.transfers.values()) {
      if (isExpired(transfer, nowIso)) due.push(transfer);
    }
    if (!due.length) return [];
    const events = due.map((transfer) => ({
      type: "transfer.expired",
      transferId: transfer.id,
      clockId: transfer.clockId,
      at: nowIso,
      actor: { actorId: "system", role: "system" }
    }));
    return appendEvents(events);
  }

  /* ---- 命令 ---- */

  async function registerAppraisal(db, clockId, body, actor, nowIso) {
    assertHealthy();
    if (actor.role !== ROLES.appraiser) {
      throw new HttpError(403, "仅鉴定师可登记鉴证", "FORBIDDEN_ROLE");
    }
    getClockOrThrow(db, clockId);
    required(body, ["authenticity", "condition", "estimatedValue"]);
    const authenticity = String(body.authenticity);
    if (!authenticity) throw new HttpError(400, "真伪结论不能为空", "INVALID_FIELD");
    const estimatedValue = Number(body.estimatedValue);
    if (!Number.isFinite(estimatedValue) || estimatedValue < 0) {
      throw new HttpError(400, "估价必须是非负数字", "INVALID_FIELD");
    }
    // 已有有效证书的钟表不能重复鉴证；有待决鉴证也不允许重复登记
    if (validCertificateFor(clockId)) {
      throw new HttpError(409, "该钟表已持有效证书，不能重复鉴证", "CERTIFICATE_EXISTS");
    }
    const hasPending = [...ledger.appraisals.values()].some(
      (item) => item.clockId === clockId && item.status === "pending"
    );
    if (hasPending) throw new HttpError(409, "该钟表已有待复核鉴证", "APPRAISAL_PENDING");

    const appraisalId = makeId("appraisal");
    const event = {
      type: "appraisal.registered",
      appraisalId,
      clockId,
      authenticity,
      condition: String(body.condition || ""),
      estimatedValue,
      evidence: body.evidence == null ? "" : String(body.evidence),
      at: nowIso,
      actor: { actorId: actor.actorId, role: actor.role }
    };
    await appendEvents([event]);
    return ledger.appraisals.get(appraisalId);
  }

  async function reviewAppraisal(db, appraisalId, body, actor, nowIso) {
    assertHealthy();
    if (actor.role !== ROLES.reviewer) {
      throw new HttpError(403, "仅复核人可复核鉴证并签发证书", "FORBIDDEN_ROLE");
    }
    required(body, ["decision"]);
    const decision = body.decision === "approve" ? "approve" : body.decision === "reject" ? "reject" : null;
    if (!decision) throw new HttpError(400, "decision 必须是 approve 或 reject", "INVALID_FIELD");

    const appraisal = getAppraisalOrThrow(appraisalId);
    getClockOrThrow(db, appraisal.clockId);
    if (appraisal.status !== "pending") {
      throw new HttpError(409, `鉴证已处理（${appraisal.status}），不能重复复核`, "APPRAISAL_NOT_PENDING");
    }
    if (appraisal.appraiserId === actor.actorId) {
      throw new HttpError(403, "复核人不能复核自己登记的鉴证", "SELF_REVIEW_FORBIDDEN");
    }

    if (decision === "reject") {
      await appendEvents([
        {
          type: "appraisal.rejected",
          appraisalId,
          clockId: appraisal.clockId,
          reason: body.reason == null ? "" : String(body.reason),
          at: nowIso,
          actor: { actorId: actor.actorId, role: actor.role }
        }
      ]);
      return { appraisal: ledger.appraisals.get(appraisalId), certificate: null };
    }

    // approve：必须指定初始持有人，且同一钟表只能有一张有效证书
    required(body, ["ownerId"]);
    const ownerId = String(body.ownerId);
    if (!ownerId) throw new HttpError(400, "ownerId 不能为空", "INVALID_FIELD");
    if (validCertificateFor(appraisal.clockId)) {
      throw new HttpError(409, "该钟表已存在有效证书，不能重复签发", "CERTIFICATE_EXISTS");
    }
    const serial = makeCertSerial();
    if (ledger.certificates.has(serial)) throw new HttpError(500, "证书序号冲突，请重试", "SERIAL_COLLISION");

    await appendEvents([
      {
        type: "appraisal.approved",
        appraisalId,
        clockId: appraisal.clockId,
        certificateSerial: serial,
        appraiserId: appraisal.appraiserId,
        authenticity: appraisal.authenticity,
        condition: appraisal.condition,
        estimatedValue: appraisal.estimatedValue,
        ownerId,
        at: nowIso,
        actor: { actorId: actor.actorId, role: actor.role }
      }
    ]);
    return { appraisal: ledger.appraisals.get(appraisalId), certificate: ledger.certificates.get(serial) };
  }

  function makeCertSerial() {
    const rand = crypto.randomBytes(6).toString("hex").toUpperCase();
    return `CERT-${new Date().getFullYear()}-${rand}`;
  }

  async function revokeCertificate(db, serial, body, actor, nowIso) {
    assertHealthy();
    if (actor.role !== ROLES.reviewer) {
      throw new HttpError(403, "仅复核人可撤销证书", "FORBIDDEN_ROLE");
    }
    required(body, ["reason"]);
    const cert = ledger.certificates.get(serial);
    if (!cert) throw new HttpError(404, "证书不存在", "CERTIFICATE_NOT_FOUND");
    if (cert.status !== "valid") {
      throw new HttpError(409, "证书已撤销，不能重复撤销", "CERTIFICATE_NOT_VALID");
    }
    getClockOrThrow(db, cert.clockId);

    // 撤销时若存在待处理转让，同一事务内一并作废，保证“无有效证书不可流转”
    const events = [
      {
        type: "certificate.revoked",
        certificateSerial: serial,
        clockId: cert.clockId,
        reason: String(body.reason),
        at: nowIso,
        actor: { actorId: actor.actorId, role: actor.role }
      }
    ];
    const pending = pendingTransfer(cert.clockId);
    if (pending) {
      events.push({
        type: "transfer.expired",
        transferId: pending.id,
        clockId: cert.clockId,
        reason: "certificate_revoked",
        at: nowIso,
        actor: { actorId: actor.actorId, role: actor.role }
      });
    }
    await appendEvents(events);
    return { certificate: ledger.certificates.get(serial), voidedTransferId: pending ? pending.id : null };
  }

  async function proposeTransfer(db, clockId, body, actor, nowIso) {
    assertHealthy();
    getClockOrThrow(db, clockId);
    await expireDue(nowIso);

    if (actor.role !== ROLES.holder) {
      throw new HttpError(403, "仅当前持有人可发起转让", "FORBIDDEN_ROLE");
    }
    required(body, ["toOwnerId"]);
    const toOwnerId = String(body.toOwnerId);
    if (!toOwnerId) throw new HttpError(400, "toOwnerId 不能为空", "INVALID_FIELD");
    if (toOwnerId === actor.actorId) {
      throw new HttpError(400, "不能转让给自己", "INVALID_TARGET");
    }
    const ownership = ledger.ownership.get(clockId);
    if (!ownership || !ownership.certificateSerial) {
      throw new HttpError(409, "只有持有效证书的钟表可转让", "NO_VALID_CERTIFICATE");
    }
    if (ownership.ownerId !== actor.actorId) {
      throw new HttpError(403, "只有当前持有人可发起转让", "NOT_CURRENT_OWNER");
    }
    const cert = ledger.certificates.get(ownership.certificateSerial);
    if (!cert || cert.status !== "valid") {
      throw new HttpError(409, "证书已失效，不能转让", "NO_VALID_CERTIFICATE");
    }
    if (pendingTransfer(clockId)) {
      throw new HttpError(409, "同一钟表只能有一笔待处理转让", "TRANSFER_PENDING");
    }

    const transferId = makeId("transfer");
    const proposedAtMs = new Date(nowIso).getTime();
    const event = {
      type: "transfer.proposed",
      transferId,
      clockId,
      certificateSerial: cert.serial,
      fromOwnerId: actor.actorId,
      toOwnerId,
      at: nowIso,
      expiresAt: new Date(proposedAtMs + TRANSFER_TTL_MS).toISOString(),
      actor: { actorId: actor.actorId, role: actor.role }
    };
    await appendEvents([event]);
    return ledger.transfers.get(transferId);
  }

  async function acceptTransfer(db, transferId, body, actor, nowIso) {
    assertHealthy();
    await expireDue(nowIso);

    if (actor.role !== ROLES.holder) {
      throw new HttpError(403, "仅持有人可接受转让", "FORBIDDEN_ROLE");
    }
    const transfer = ledger.transfers.get(transferId);
    if (!transfer) throw new HttpError(404, "转让不存在", "TRANSFER_NOT_FOUND");
    getClockOrThrow(db, transfer.clockId);

    if (transfer.status === "expired") {
      throw new HttpError(409, "转让已超时失效", "TRANSFER_EXPIRED");
    }
    if (transfer.status === "accepted") {
      throw new HttpError(409, "转让已被接受，不能重复接受", "TRANSFER_ALREADY_ACCEPTED");
    }
    if (transfer.toOwnerId !== actor.actorId) {
      throw new HttpError(403, "只有目标持有人可接受该转让", "NOT_TARGET_OWNER");
    }
    const ownership = ledger.ownership.get(transfer.clockId);
    if (!ownership || ownership.ownerId !== transfer.fromOwnerId || !ownership.certificateSerial) {
      throw new HttpError(409, "所有权或有效证书状态已变化，转让非法", "TRANSFER_STALE");
    }

    await appendEvents([
      {
        type: "transfer.accepted",
        transferId,
        clockId: transfer.clockId,
        certificateSerial: transfer.certificateSerial,
        fromOwnerId: transfer.fromOwnerId,
        toOwnerId: transfer.toOwnerId,
        at: nowIso,
        actor: { actorId: actor.actorId, role: actor.role }
      }
    ]);
    return { transfer: ledger.transfers.get(transferId), ownership: ledger.ownership.get(transfer.clockId) };
  }

  /** 所有权历史：签发（确权）→ 每次接受流转，按时间排列 */
  function ownershipHistory(clockId) {
    const items = [];
    for (const { event } of ledger.chain) {
      if (event.clockId !== clockId) continue;
      if (event.type === "appraisal.approved") {
        items.push({
          at: event.at,
          type: "issued",
          fromOwnerId: null,
          ownerId: event.ownerId,
          certificateSerial: event.certificateSerial,
          refId: event.appraisalId
        });
      } else if (event.type === "transfer.accepted") {
        items.push({
          at: event.at,
          type: "transfer",
          fromOwnerId: event.fromOwnerId,
          ownerId: event.toOwnerId,
          certificateSerial: event.certificateSerial,
          refId: event.transferId
        });
      } else if (event.type === "certificate.revoked") {
        items.push({
          at: event.at,
          type: "revoked",
          certificateSerial: event.certificateSerial,
          ownerId: null,
          fromOwnerId: null,
          refId: event.certificateSerial
        });
      }
    }
    return items;
  }

  async function withMutex(task) {
    return mutex(task);
  }

  return {
    init,
    dataDir,
    allowClockOverride,
    ledger,
    withMutex,
    readDb: () => readDb(dataDir),
    writeDb: (data) => writeDb(dataDir, data),
    registerAppraisal,
    reviewAppraisal,
    revokeCertificate,
    proposeTransfer,
    acceptTransfer,
    expireDue,
    ownershipHistory,
    validCertificateFor,
    pendingTransfer,
    projectTransfer,
    effectivePendingTransfer,
    assertHealthy,
    getClockOrThrow,
    stop() {
      if (sweepTimer) clearInterval(sweepTimer);
    }
  };
}

/* -------------------------------------------------------------------------- */
/* HTTP 层                                                                     */
/* -------------------------------------------------------------------------- */

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw.trim()) {
    throw new HttpError(400, "请求体不能为空，必须是 JSON 对象", "INVALID_BODY");
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "请求体必须是合法JSON", "INVALID_JSON");
  }
  // null、数组、字符串、数字、布尔都不是合法的请求体
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "请求体必须是 JSON 对象", "INVALID_BODY");
  }
  return value;
}

/** 三类角色身份从请求头带入：x-actor-id + x-actor-role，各环节只认对应角色 */
function parseActor(req) {
  const actorId = req.headers["x-actor-id"];
  const role = req.headers["x-actor-role"];
  if (!actorId || !role) {
    throw new HttpError(401, "缺少身份头 x-actor-id / x-actor-role", "UNAUTHENTICATED");
  }
  if (!ROLES[role]) {
    throw new HttpError(403, `未知角色：${role}（appraiser/reviewer/holder）`, "FORBIDDEN_ROLE");
  }
  return { actorId: String(actorId), role };
}

/** 仅当服务显式开启 allowClockOverride（测试环境）时，才接受 x-now 注入时间 */
function parseNow(req, allowClockOverride) {
  const injected = req.headers["x-now"];
  if (!injected) return new Date().toISOString();
  if (!allowClockOverride) {
    throw new HttpError(403, "生产环境不允许 x-now 时间注入", "CLOCK_OVERRIDE_FORBIDDEN");
  }
  const time = new Date(injected);
  if (Number.isNaN(time.getTime())) throw new HttpError(400, "x-now 不是合法时间", "INVALID_FIELD");
  return time.toISOString();
}

function clockSummary(db, service, clock) {
  const retest = db.retests
    .filter((item) => item.clockId === clock.id)
    .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt))[0];
  const adjustment = db.adjustments
    .filter((item) => item.clockId === clock.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  const cert = service.validCertificateFor(clock.id);
  const ownership = service.ledger.ownership.get(clock.id) || null;
  const pending = service.effectivePendingTransfer(clock.id, new Date().toISOString());
  return {
    ...clock,
    latestAdjustment: adjustment || null,
    latestRetest: retest || null,
    qualified: retest ? retest.qualified : false,
    ownerId: ownership ? ownership.ownerId : null,
    certificateSerial: cert ? cert.serial : null,
    certificateStatus: cert ? "valid" : ownership && ownership.certificateSerial === null ? "revoked" : "none",
    pendingTransferId: pending ? pending.id : null
  };
}

function createApp(service) {
  return async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    try {
      if (req.method === "GET" && pathname === "/health") {
        return send(res, 200, { ok: true, service: "clock-escapement-tuning-api", routes });
      }

      // 读接口：只读重放状态，无需加锁
      const dbRead = await service.readDb();

      if (req.method === "GET" && pathname === "/clocks") {
        const qualified = url.searchParams.get("qualified");
        let data = dbRead.clocks.map((clock) => clockSummary(dbRead, service, clock));
        if (qualified !== null) data = data.filter((clock) => clock.qualified === (qualified === "true"));
        return send(res, 200, { data });
      }

      if (req.method === "GET" && pathname === "/clocks/not-qualified") {
        const data = dbRead.clocks
          .map((clock) => clockSummary(dbRead, service, clock))
          .filter((clock) => !clock.qualified);
        return send(res, 200, { data });
      }

      if (req.method === "GET" && pathname === "/chain/verify") {
        service.assertHealthy();
        return send(res, 200, {
          data: {
            ok: true,
            length: service.ledger.chain.length,
            tailHash: service.ledger.tailHash
          }
        });
      }

      if (req.method === "GET" && pathname === "/chain") {
        service.assertHealthy();
        // 全局审计链：可按钟表过滤，但 seq/prevHash/hash 始终以全局链为准
        const clockId = url.searchParams.get("clockId");
        const data = clockId
          ? service.ledger.chain.filter((item) => item.event.clockId === clockId)
          : service.ledger.chain;
        return send(res, 200, { data });
      }

      if (req.method === "GET" && pathname === "/certificates") {
        service.assertHealthy();
        const status = url.searchParams.get("status");
        const clockId = url.searchParams.get("clockId");
        let data = [...service.ledger.certificates.values()];
        if (status) data = data.filter((cert) => cert.status === status);
        if (clockId) data = data.filter((cert) => cert.clockId === clockId);
        return send(res, 200, { data });
      }

      if (req.method === "GET" && pathname === "/transfers") {
        service.assertHealthy();
        const status = url.searchParams.get("status");
        const clockId = url.searchParams.get("clockId");
        const nowIso = new Date().toISOString();
        let data = [...service.ledger.transfers.values()].map((t) => service.projectTransfer(t, nowIso));
        if (status) data = data.filter((item) => item.status === status);
        if (clockId) data = data.filter((item) => item.clockId === clockId);
        return send(res, 200, { data });
      }

      if (req.method === "GET" && pathname === "/adjustments") {
        const clockId = url.searchParams.get("clockId");
        return send(res, 200, {
          data: dbRead.adjustments.filter((item) => !clockId || item.clockId === clockId)
        });
      }

      if (req.method === "GET" && pathname === "/retests") {
        const clockId = url.searchParams.get("clockId");
        const qualified = url.searchParams.get("qualified");
        const data = dbRead.retests.filter((item) => {
          const matchClock = !clockId || item.clockId === clockId;
          const matchQualified = qualified === null || item.qualified === (qualified === "true");
          return matchClock && matchQualified;
        });
        return send(res, 200, { data });
      }

      const match = (regexp) => pathname.match(regexp);

      let m;

      if ((m = match(/^\/clocks\/([^/]+)\/history$/)) && req.method === "GET") {
        const clock = service.getClockOrThrow(dbRead, m[1]);
        const adjustments = dbRead.adjustments.filter((item) => item.clockId === clock.id);
        const retests = dbRead.retests.filter((item) => item.clockId === clock.id);
        return send(res, 200, {
          data: {
            clock: clockSummary(dbRead, service, clock),
            adjustments,
            retests,
            latestRetest: retests.sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt))[0] || null
          }
        });
      }

      if ((m = match(/^\/clocks\/([^/]+)\/latest-retest$/)) && req.method === "GET") {
        service.getClockOrThrow(dbRead, m[1]);
        const retest = dbRead.retests
          .filter((item) => item.clockId === m[1])
          .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt))[0];
        return send(res, 200, { data: retest || null });
      }

      if ((m = match(/^\/clocks\/([^/]+)\/appraisals$/)) && req.method === "GET") {
        service.assertHealthy();
        service.getClockOrThrow(dbRead, m[1]);
        return send(res, 200, {
          data: [...service.ledger.appraisals.values()].filter((item) => item.clockId === m[1])
        });
      }

      if ((m = match(/^\/clocks\/([^/]+)\/certificate$/)) && req.method === "GET") {
        service.assertHealthy();
        service.getClockOrThrow(dbRead, m[1]);
        return send(res, 200, {
          data: {
            valid: service.validCertificateFor(m[1]),
            all: [...service.ledger.certificates.values()].filter((cert) => cert.clockId === m[1])
          }
        });
      }

      if ((m = match(/^\/clocks\/([^/]+)\/ownership$/)) && req.method === "GET") {
        service.assertHealthy();
        service.getClockOrThrow(dbRead, m[1]);
        const current = service.ledger.ownership.get(m[1]);
        return send(res, 200, {
          data: {
            current: current
              ? {
                  ownerId: current.ownerId,
                  certificateSerial: current.certificateSerial,
                  since: current.since
                }
              : null,
            history: service.ownershipHistory(m[1])
          }
        });
      }

      if ((m = match(/^\/clocks\/([^/]+)\/chain$/)) && req.method === "GET") {
        service.assertHealthy();
        service.getClockOrThrow(dbRead, m[1]);
        return send(res, 200, {
          data: service.ledger.chain.filter((item) => item.event.clockId === m[1])
        });
      }

      /* ---------------- 写接口：互斥串行 + 原子落盘 ---------------- */

      if ((m = match(/^\/clocks$/)) && req.method === "POST") {
        const body = await parseBody(req);
        ["code", "escapementType", "balanceFrequency"].forEach((f) => required(body, [f]));
        const result = await service.withMutex(async () => {
          const db = await service.readDb();
          const clock = {
            id: makeId("clock"),
            code: body.code,
            escapementType: body.escapementType,
            balanceFrequency: body.balanceFrequency,
            targetDailyRateSeconds: Number(body.targetDailyRateSeconds ?? 30),
            note: body.note || "",
            createdAt: parseNow(req, service.allowClockOverride)
          };
          db.clocks.push(clock);
          await service.writeDb(db);
          return clockSummary(db, service, clock);
        });
        return send(res, 201, { data: result });
      }

      if ((m = match(/^\/clocks\/([^/]+)\/adjustments$/)) && req.method === "POST") {
        const body = await parseBody(req);
        required(body, ["currentDailyRateSeconds", "direction", "amount"]);
        const result = await service.withMutex(async () => {
          const db = await service.readDb();
          const clock = service.getClockOrThrow(db, m[1]);
          const adjustment = {
            id: makeId("adjustment"),
            clockId: clock.id,
            currentDailyRateSeconds: Number(body.currentDailyRateSeconds),
            direction: body.direction,
            amount: body.amount,
            note: body.note || "",
            createdAt: parseNow(req, service.allowClockOverride)
          };
          db.adjustments.push(adjustment);
          await service.writeDb(db);
          return adjustment;
        });
        return send(res, 201, { data: result });
      }

      if ((m = match(/^\/clocks\/([^/]+)\/retests$/)) && req.method === "POST") {
        const body = await parseBody(req);
        required(body, ["dailyRateSeconds", "amplitude"]);
        const nowIso = parseNow(req, service.allowClockOverride);
        const result = await service.withMutex(async () => {
          const db = await service.readDb();
          const clock = service.getClockOrThrow(db, m[1]);
          const latestAdjustment = db.adjustments
            .filter((item) => item.clockId === clock.id)
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
          const adjustmentId = body.adjustmentId || latestAdjustment?.id || null;
          const qualified =
            body.qualified !== undefined
              ? Boolean(body.qualified)
              : Math.abs(Number(body.dailyRateSeconds)) <= Number(clock.targetDailyRateSeconds);
          const retest = {
            id: makeId("retest"),
            clockId: clock.id,
            adjustmentId,
            testedAt: body.testedAt || nowIso,
            dailyRateSeconds: Number(body.dailyRateSeconds),
            amplitude: Number(body.amplitude),
            qualified,
            note: body.note || ""
          };
          db.retests.push(retest);
          await service.writeDb(db);
          return { retest, clock: clockSummary(db, service, clock) };
        });
        return send(res, 201, { data: result.retest, clock: result.clock });
      }

      if ((m = match(/^\/clocks\/([^/]+)\/appraisals$/)) && req.method === "POST") {
        const body = await parseBody(req);
        const actor = parseActor(req);
        const nowIso = parseNow(req, service.allowClockOverride);
        const data = await service.withMutex(async () => {
          const db = await service.readDb();
          return service.registerAppraisal(db, m[1], body, actor, nowIso);
        });
        return send(res, 201, { data });
      }

      if ((m = match(/^\/appraisals\/([^/]+)\/review$/)) && req.method === "POST") {
        const body = await parseBody(req);
        const actor = parseActor(req);
        const nowIso = parseNow(req, service.allowClockOverride);
        const data = await service.withMutex(async () => {
          const db = await service.readDb();
          return service.reviewAppraisal(db, m[1], body, actor, nowIso);
        });
        return send(res, 200, { data });
      }

      if ((m = match(/^\/certificates\/([^/]+)\/revoke$/)) && req.method === "POST") {
        const body = await parseBody(req);
        const actor = parseActor(req);
        const nowIso = parseNow(req, service.allowClockOverride);
        const data = await service.withMutex(async () => {
          const db = await service.readDb();
          return service.revokeCertificate(db, decodeURIComponent(m[1]), body, actor, nowIso);
        });
        return send(res, 200, { data });
      }

      if ((m = match(/^\/clocks\/([^/]+)\/transfers$/)) && req.method === "POST") {
        const body = await parseBody(req);
        const actor = parseActor(req);
        const nowIso = parseNow(req, service.allowClockOverride);
        const data = await service.withMutex(async () => {
          const db = await service.readDb();
          return service.proposeTransfer(db, m[1], body, actor, nowIso);
        });
        return send(res, 201, { data });
      }

      if ((m = match(/^\/transfers\/([^/]+)\/accept$/)) && req.method === "POST") {
        const body = await parseBody(req);
        const actor = parseActor(req);
        const nowIso = parseNow(req, service.allowClockOverride);
        const data = await service.withMutex(async () => {
          const db = await service.readDb();
          return service.acceptTransfer(db, m[1], body, actor, nowIso);
        });
        return send(res, 200, { data });
      }

      return send(res, 404, { error: "接口不存在", routes });
    } catch (error) {
      if (error instanceof HttpError) {
        return send(res, error.status, { error: error.message, code: error.code });
      }
      return send(res, 500, { error: error.message || "服务器错误", code: "INTERNAL" });
    }
  };
}

async function buildServer({ port = PORT, dataDir, allowClockOverride = process.env.ALLOW_CLOCK_OVERRIDE === "1" } = {}) {
  const service = createService({ dataDir, allowClockOverride });
  const integrityError = await service.init();
  if (integrityError) {
    console.error(`[startup] 鉴证链路完整性校验失败：${integrityError}`);
  }
  const app = createApp(service);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(port, resolve));
  return {
    server,
    service,
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        service.stop();
        server.close(() => resolve());
      })
  };
}

if (require.main === module) {
  const dataDir = process.env.DATA_DIR || DEFAULT_DATA_DIR;
  buildServer({ port: PORT, dataDir })
    .then(({ port }) => {
      console.log(`Clock escapement tuning API running at http://127.0.0.1:${port}`);
      console.log(`Data dir: ${dataDir}`);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = {
  buildServer,
  createService,
  createApp,
  hashEvent,
  canonicalJson,
  ROLES,
  dbFile,
  chainFile,
  DEFAULT_DATA_DIR
};
