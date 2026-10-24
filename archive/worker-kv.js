// smart-alert Worker: 接收各机器上报的 smartctl JSON, 判断硬盘健康, 变坏才经 Bark 推送
// 绑定: KV (KV namespace)
// 密钥 (wrangler secret put 或控制台设置): REPORT_TOKEN, BARK_URL
//   BARK_URL 形如 https://api.day.app/<你的Bark key>  (自建 Bark 则换成自建地址/<key>)
// 接口: POST /report 上报 | POST /test 测试推送 | GET /status?token=... 查看所有盘当前状态
// 定时: wrangler.toml 里配 hourly cron, 做"整机失联"检测

const WATCH_ATTRS = [5, 187, 188, 197, 198]; // 重映射/报告不可纠正/命令超时/待处理/离线不可纠正
const CRC_ATTR = 199;                        // CRC 错误: 多半是线/接口, 只警告不升级
const DEAD_AFTER_SEC = 26 * 3600;            // 超过 26 小时没上报 = 失联
const CRIT_REMIND_SEC = 24 * 3600;           // 紧急状态未解除, 每 24 小时提醒一次

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
      return Response.json(await dumpStatus(env));
    }
    return new Response('smart-alert worker is running');
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkDeadHosts(env));
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

// ---------- 判断: 返回 level 0=OK 1=警告 2=紧急 + 原因 ----------
// 核心原则: 不看厂家阈值, 看关键计数"从无到有"与"持续增长"
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
    if (v > 0 && pv === 0) warn(`属性 ${id} 首次出现非零值 ${v}`);
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
  const now = Math.floor(Date.now() / 1000);
  await env.KV.put(`host:${body.host}`, JSON.stringify({ last_seen: now, down_alerted: false }));

  const disks = [];
  for (const r of body.reports) { const d = extract(r); if (d) disks.push(d); }
  for (const c of body.coarse || []) disks.push(coarseDisk(c));

  for (const d of disks) {
    const key = `disk:${body.host}:${d.serial}`;
    const prev = await env.KV.get(key, 'json');
    const { level: rawLevel, reasons } = evaluate(d, prev);
    let level = rawLevel;

    // 温度: 连续 2 次超标才算数, 防单次尖峰误报
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
    } else if (level === 0 && prevLevel > 0) {
      await bark(env, `🟢 硬盘恢复: ${label}`, '指标已回到正常', 'active');
    }

    await env.KV.put(key, JSON.stringify({
      host: body.host, model: d.model, serial: d.serial, kind: d.kind,
      level, tempStreak, last_crit_remind: lastCritRemind,
      metrics: snapshot(d), updated: now,
    }));
  }
}

// ---------- 失联检测 (cron) ----------
async function checkDeadHosts(env) {
  const now = Math.floor(Date.now() / 1000);
  let cursor;
  do {
    const list = await env.KV.list({ prefix: 'host:', cursor });
    for (const k of list.keys) {
      const v = await env.KV.get(k.name, 'json');
      if (!v) continue;
      if (now - v.last_seen > DEAD_AFTER_SEC && !v.down_alerted) {
        const host = k.name.slice(5);
        await bark(env, `⚠️ 服务器失联: ${host}`,
          `已超过 26 小时没有上报 SMART 数据, 最后上报: ${new Date(v.last_seen * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
          'timeSensitive');
        await env.KV.put(k.name, JSON.stringify({ ...v, down_alerted: true }));
      }
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
}

async function dumpStatus(env) {
  const out = {};
  let cursor;
  do {
    const list = await env.KV.list({ prefix: 'disk:', cursor });
    for (const k of list.keys) out[k.name] = await env.KV.get(k.name, 'json');
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
  return out;
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
