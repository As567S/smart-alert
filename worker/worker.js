// smart-alert Worker (D1 版): 接收各机器上报的 smartctl JSON, 判断硬盘健康, 变坏才经 Bark 推送
// 绑定: DB (D1 数据库, 见 schema.sql / wrangler.toml)
// 密钥 (wrangler secret put 或控制台设置): REPORT_TOKEN, BARK_URL
//   BARK_URL 形如 https://api.day.app/<你的Bark key>  (自建 Bark 则换成自建地址/<key>)
// 接口: POST /report 上报 | POST /test 测试推送
//       GET /status?token=...            所有盘当前状态
//       GET /history?token=...&host=..&serial=..&days=30   某块盘的历史趋势
// 定时: wrangler.toml 里配 */10 * * * * cron, 做"整机失联"检测 + 清理过期历史

const WATCH_ATTRS = [5, 187, 188, 197, 198]; // 重映射/报告不可纠正/命令超时/待处理/离线不可纠正
const CRC_ATTR = 199;                        // CRC 错误: 多半是线/接口, 只警告不升级
const DEAD_AFTER_SEC = 30 * 60;              // 10 分钟一报, 漏 3 个周期 (30 分钟) 判失联
const CRIT_REMIND_SEC = 24 * 3600;           // 紧急状态未解除, 每 24 小时提醒一次
const HISTORY_KEEP_DAYS = 180;               // 历史保留 180 天

// 注意: 不能用 DB.exec() 跑多行 SQL —— D1 的 exec 按行切分语句, 跨行的 CREATE TABLE 会被切断报错。
// 所以每条语句写成单行, 用 batch + prepare 逐条执行。
const SCHEMA_STATEMENTS = [
  'CREATE TABLE IF NOT EXISTS hosts (host TEXT PRIMARY KEY, last_seen INTEGER NOT NULL, down_alerted INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS disks (host TEXT NOT NULL, serial TEXT NOT NULL, model TEXT, kind TEXT, level INTEGER NOT NULL DEFAULT 0, temp_streak INTEGER NOT NULL DEFAULT 0, last_crit_remind INTEGER NOT NULL DEFAULT 0, metrics TEXT, updated INTEGER, PRIMARY KEY (host, serial))',
  'CREATE TABLE IF NOT EXISTS history (host TEXT NOT NULL, serial TEXT NOT NULL, ts INTEGER NOT NULL, level INTEGER NOT NULL, passed INTEGER, temp INTEGER, metrics TEXT)',
  'CREATE INDEX IF NOT EXISTS idx_history ON history (host, serial, ts)',
];

let schemaPromise = null;
function ensureSchema(env) {
  if (!schemaPromise)
    schemaPromise = env.DB.batch(SCHEMA_STATEMENTS.map((s) => env.DB.prepare(s)))
      .catch((e) => { schemaPromise = null; throw e; });
  return schemaPromise;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/report') {
      if (!auth(req, env, url)) return new Response('unauthorized', { status: 401 });
      const body = await req.json().catch(() => null);
      if (!body || !body.host || !Array.isArray(body.reports))
        return new Response('bad request', { status: 400 });
      ctx.waitUntil(handleReport(env, body));
      return new Response('ok');
    }
    if (req.method === 'POST' && url.pathname === '/test') {
      if (!auth(req, env, url)) return new Response('unauthorized', { status: 401 });
      await bark(env, 'SMART 监控测试', '推送通道正常', 'active');
      return new Response('sent');
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      if (!auth(req, env, url)) return new Response('unauthorized', { status: 401 });
      await ensureSchema(env);
      const { results } = await env.DB.prepare(
        'SELECT host, serial, model, kind, level, updated FROM disks ORDER BY host, serial').all();
      return Response.json(results);
    }
    if (req.method === 'GET' && url.pathname === '/history') {
      if (!auth(req, env, url)) return new Response('unauthorized', { status: 401 });
      const host = url.searchParams.get('host'), serial = url.searchParams.get('serial');
      if (!host || !serial) return new Response('need host & serial', { status: 400 });
      const days = Math.min(parseInt(url.searchParams.get('days') || '30', 10) || 30, 365);
      await ensureSchema(env);
      const since = Math.floor(Date.now() / 1000) - days * 86400;
      const { results } = await env.DB.prepare(
        'SELECT ts, level, temp, metrics FROM history WHERE host=?1 AND serial=?2 AND ts>=?3 ORDER BY ts'
      ).bind(host, serial, since).all();
      return Response.json(results.map((r) => ({
        ts: r.ts, level: r.level, temp: r.temp,
        metrics: JSON.parse(r.metrics || '{}'),
      })));
    }
    return new Response('smart-alert worker is running');
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => { await ensureSchema(env); await checkDeadHosts(env); await pruneHistory(env); })());
  },
};

function auth(req, env, url) {
  if (!env.REPORT_TOKEN) return false;
  const h = req.headers.get('Authorization') || '';
  return h === `Bearer ${env.REPORT_TOKEN}` || url.searchParams.get('token') === env.REPORT_TOKEN;
}

// ---------- 数据提取: smartctl 原始 JSON -> 只留判断需要的字段 ----------
function extract(r) {
  if (!r || typeof r !== 'object') return null;
  const table = r.ata_smart_attributes && r.ata_smart_attributes.table;
  const hasAta = Array.isArray(table);
  const nvme = r.nvme_smart_health_information_log || null;
  if (!hasAta && !nvme && !r.smart_status) return null; // 休眠盘/读不到 -> 跳过
  const attrs = {};
  if (hasAta) for (const a of table) attrs[a.id] = (a.raw && a.raw.value) || 0;
  return {
    model: r.model_name || r.model_family || 'unknown',
    serial: r.serial_number || 'unknown',
    kind: nvme ? 'nvme' : 'ata',
    passed: r.smart_status ? !!r.smart_status.passed : true,
    temp: r.temperature && typeof r.temperature.current === 'number' ? r.temperature.current : null,
    attrs,
    nvme: nvme ? {
      critical_warning: nvme.critical_warning || 0,
      percentage_used: nvme.percentage_used || 0,
      media_errors: nvme.media_errors || 0,
      spare: typeof nvme.available_spare === 'number' ? nvme.available_spare : 100,
      spare_threshold: typeof nvme.available_spare_threshold === 'number' ? nvme.available_spare_threshold : 10,
    } : null,
    coarse: null,
  };
}

// Windows 降级数据 (Get-StorageReliabilityCounter) 统一成同一种盘对象
function coarseDisk(c) {
  return {
    model: c.model || 'unknown',
    serial: c.serial || 'unknown',
    kind: 'coarse',
    passed: true,
    temp: typeof c.temp === 'number' ? c.temp : null,
    attrs: {},
    nvme: null,
    coarse: {
      wear: c.wear || 0,
      read_errors: c.read_errors || 0,
      write_errors: c.write_errors || 0,
    },
  };
}

function snapshot(d) {
  const attrs = {};
  for (const id of [...WATCH_ATTRS, CRC_ATTR])
    if (d.attrs[id] !== undefined) attrs[id] = d.attrs[id];
  return { attrs, nvme: d.nvme, coarse: d.coarse };
}

// 增量型判断的指标是否真的干净: CRC 和粗粒度错误计数是"增长才报",
// 级别回落时靠这道闸门确认它们也为 0, 才允许发"恢复"通知
function countersClean(d) {
  if (d.attrs[CRC_ATTR] !== undefined && d.attrs[CRC_ATTR] > 0) return false;
  if (d.coarse && (d.coarse.read_errors > 0 || d.coarse.write_errors > 0)) return false;
  return true;
}

// ---------- 判断: 返回 level 0=OK 1=警告 2=紧急 + 原因 ----------
// 核心原则: 不看厂家阈值; 关键计数非零即保持警告 (粘性), 持续增长才升级
function evaluate(d, prev) {
  const reasons = [];
  let level = 0;
  const warn = (m) => { level = Math.max(level, 1); reasons.push(m); };
  const crit = (m) => { level = Math.max(level, 2); reasons.push(m); };
  const pa = (prev && prev.metrics && prev.metrics.attrs) || {};

  if (!d.passed) crit('SMART 总判定 FAILED');

  if (d.nvme) {
    const n = d.nvme;
    if (n.media_errors > 0) crit(`NVMe 介质错误计数 ${n.media_errors}`);
    if (n.critical_warning !== 0) crit(`NVMe Critical Warning = ${n.critical_warning}`);
    if (n.spare < n.spare_threshold) crit(`NVMe 备用块 ${n.spare}% 已低于阈值 ${n.spare_threshold}%`);
    if (n.percentage_used >= 100) crit(`NVMe 寿命已用尽 (${n.percentage_used}%)`);
    else if (n.percentage_used >= 80) warn(`NVMe 寿命已用 ${n.percentage_used}%`);
  }

  for (const id of WATCH_ATTRS) {
    const v = d.attrs[id];
    if (v === undefined) continue;
    const pv = pa[id] || 0;
    // 状态型判断 (粘性): 计数非零就保持警告 —— 这类计数只增不减,
    // "没恶化"不等于"已恢复", 不归零就不解除
    if (v > 0) warn(`属性 ${id} 当前值 ${v}`);
    if (v > pv && pv > 0) crit(`属性 ${id} 持续增长 ${pv} → ${v}`);
    if (id === 197 && v > 0) crit(`待处理扇区 ${v} (已有数据处于风险中)`);
    if ((id === 5 || id === 198) && v >= 10) crit(`属性 ${id} 已累计 ${v}`);
  }

  const crc = d.attrs[CRC_ATTR];
  if (crc !== undefined && pa[CRC_ATTR] !== undefined && crc > pa[CRC_ATTR])
    warn(`CRC 错误增长 ${pa[CRC_ATTR]} → ${crc} (多半是数据线/接口问题)`);

  if (d.coarse) {
    const c = d.coarse, p = (prev && prev.metrics && prev.metrics.coarse) || null;
    if (c.wear >= 100) crit(`磨损率已达 ${c.wear}% (粗粒度数据)`);
    else if (c.wear >= 90) warn(`磨损率 ${c.wear}% (粗粒度数据)`);
    if (p && (c.read_errors > p.read_errors || c.write_errors > p.write_errors))
      crit(`读写错误计数增长 (粗粒度数据)`);
    else if (!p && (c.read_errors > 0 || c.write_errors > 0))
      warn(`已存在读写错误计数 (粗粒度数据)`);
  }
  return { level, reasons };
}

// ---------- 上报处理 ----------
async function handleReport(env, body) {
  await ensureSchema(env);
  const now = Math.floor(Date.now() / 1000);
  const stmts = [
    env.DB.prepare(
      `INSERT INTO hosts (host, last_seen, down_alerted) VALUES (?1, ?2, 0)
       ON CONFLICT(host) DO UPDATE SET last_seen=excluded.last_seen, down_alerted=0`
    ).bind(body.host, now),
  ];

  const disks = [];
  for (const r of body.reports) { const d = extract(r); if (d) disks.push(d); }
  for (const c of body.coarse || []) disks.push(coarseDisk(c));

  for (const d of disks) {
    const row = await env.DB.prepare(
      'SELECT * FROM disks WHERE host=?1 AND serial=?2').bind(body.host, d.serial).first();
    let prev = null;
    if (row) {
      let metrics = {};
      try { metrics = JSON.parse(row.metrics || '{}'); } catch (e) { metrics = {}; }
      prev = {
        level: row.level, tempStreak: row.temp_streak,
        last_crit_remind: row.last_crit_remind, metrics,
      };
    }

    const { level: rawLevel, reasons } = evaluate(d, prev);
    let level = rawLevel;

    // 温度: 连续 2 次超标才算数, 防单次尖峰误报 (10 分钟一报 = 持续 20 分钟)
    const tempLimit = d.kind === 'nvme' ? 70 : 55;
    let tempStreak = (prev && prev.tempStreak) || 0;
    tempStreak = d.temp !== null && d.temp >= tempLimit ? tempStreak + 1 : 0;
    if (tempStreak >= 2 && level < 1) { level = 1; reasons.push(`温度 ${d.temp}°C 持续超标`); }

    const prevLevel = prev ? prev.level : 0;
    const label = `${body.host} / ${d.model} (…${String(d.serial).slice(-4)})`;
    let lastCritRemind = (prev && prev.last_crit_remind) || 0;

    if (level > prevLevel) {
      await bark(env,
        level === 2 ? `🔴 硬盘紧急: ${label}` : `🟠 硬盘警告: ${label}`,
        reasons.join('; ') || '状态恶化',
        level === 2 ? 'critical' : 'timeSensitive');
      if (level === 2) lastCritRemind = now;
    } else if (level === 2 && now - lastCritRemind > CRIT_REMIND_SEC) {
      await bark(env, `🔴 硬盘紧急(未处理): ${label}`,
        (reasons.join('; ') || '仍处于紧急状态') + ' — 请尽快备份并换盘',
        'critical');
      lastCritRemind = now;
    } else if (level === 0 && prevLevel > 0 && countersClean(d)) {
      // 只在指标真回到干净时才报恢复 (典型: 温度回落);
      // 计数型问题不归零就不发, 状态会停在"警告"表示仍在观察中
      await bark(env, `🟢 硬盘恢复: ${label}`, '指标已回到正常', 'active');
    }

    const snap = JSON.stringify(snapshot(d));
    stmts.push(
      env.DB.prepare(
        `INSERT INTO disks (host, serial, model, kind, level, temp_streak, last_crit_remind, metrics, updated)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(host, serial) DO UPDATE SET
           model=excluded.model, kind=excluded.kind, level=excluded.level,
           temp_streak=excluded.temp_streak, last_crit_remind=excluded.last_crit_remind,
           metrics=excluded.metrics, updated=excluded.updated`
      ).bind(body.host, d.serial, d.model, d.kind, level, tempStreak, lastCritRemind, snap, now),
      env.DB.prepare(
        'INSERT INTO history (host, serial, ts, level, passed, temp, metrics) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)'
      ).bind(body.host, d.serial, now, level, d.passed ? 1 : 0, d.temp, snap),
    );
  }

  await env.DB.batch(stmts);
}

// ---------- 失联检测 + 历史清理 (cron) ----------
async function checkDeadHosts(env) {
  const now = Math.floor(Date.now() / 1000);
  const { results } = await env.DB.prepare(
    'SELECT host, last_seen FROM hosts WHERE down_alerted=0 AND last_seen < ?1'
  ).bind(now - DEAD_AFTER_SEC).all();
  for (const h of results) {
    await bark(env, `⚠️ 服务器失联: ${h.host}`,
      `已超过 ${Math.round(DEAD_AFTER_SEC / 60)} 分钟没有上报 SMART 数据, 最后上报: ${new Date(h.last_seen * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
      'timeSensitive');
    await env.DB.prepare('UPDATE hosts SET down_alerted=1 WHERE host=?1').bind(h.host).run();
  }
}

async function pruneHistory(env) {
  const cutoff = Math.floor(Date.now() / 1000) - HISTORY_KEEP_DAYS * 86400;
  await env.DB.prepare('DELETE FROM history WHERE ts < ?1').bind(cutoff).run();
}

// ---------- Bark 推送 ----------
async function bark(env, title, body, level) {
  if (!env.BARK_URL) return;
  try {
    await fetch(env.BARK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ title, body, level, group: 'SMART硬盘' }),
    });
  } catch (e) { /* 推送失败不影响状态记录 */ }
}
