# smart-alert

把服务器硬盘的 SMART 健康数据汇总到 Cloudflare Workers,用 D1 存状态与历史,
硬盘变坏时第一时间经 [Bark](https://github.com/Finb/Bark) 推送到 iPhone。

- 各机器每 10 分钟上报一次 `smartctl` 的原始 JSON,客户端不做任何判断
- 判断逻辑全在 Worker 一处:看关键计数"从无到有"与"持续增长",不迷信厂家阈值
- 同盘同档不重复推送;紧急未解除每 24 小时提醒一次;恢复正常也会通知
- 顺带做整机失联检测:漏报 3 个周期 (30 分钟) 推一条"服务器失联"
- 每次上报都留历史 (保留 180 天),可查任意一块盘的指标趋势
- 客户端支持 Linux (systemd/cron)、OpenWrt 与 Windows;全部跑在 Cloudflare 免费额度内

## 架构

```
[Linux / OpenWrt / Windows]  --smartctl -j-->  POST /report
        每 10 分钟                                  |
                                            Cloudflare Worker
                                            ├─ 判断/去重 (D1: disks 表)
                                            ├─ 历史留档 (D1: history 表)
                                            ├─ 失联检测 (D1: hosts 表 + Cron)
                                            └─ 变坏才推送 --> Bark --> iPhone
```

## 目录

```
worker/            云端
  worker.js        Worker 主体 (判断规则/状态机/推送/失联/趋势接口)
  wrangler.toml    wrangler 部署配置 (D1 绑定 + Cron)
  schema.sql       D1 表结构 (Worker 首次运行也会自动建表)
clients/
  linux/           smart-report.sh + systemd service/timer
  windows/         smart-report.ps1 + install-task.ps1 (任务计划注册)
archive/
  worker-kv.js     早期 KV 存储版 (已被 D1 版取代, 仅备查)
```

## 命名约定 (部署时照这个填)

| 对象 | 名称 | 说明 |
|---|---|---|
| Worker | `smart-alert` | |
| D1 数据库 | `smart-alert` | 与 Worker 同名好记 |
| D1 绑定变量名 | `DB` | 代码里写死, 必须叫这个 |
| 密钥 | `REPORT_TOKEN` | 自己定一串随机字符 (如 `openssl rand -hex 24`), Worker 与每台客户端填同一个 |
| 密钥 | `BARK_URL` | `https://api.day.app/<你的 Bark key>`, 只填在 Worker 里 |
| Cron | `*/10 * * * *` | 失联检测 + 清理过期历史 |
| 自定义域名 | 如 `smart.example.com` | 国内访问 workers.dev 基本被墙, 建议绑自己的域名 |

## 部署

### 0. 准备
- iPhone 装 Bark App, 记下 key。
- 定一个 `REPORT_TOKEN` 备用。

### 1. 建 D1
控制台 → Storage & Databases → D1 SQL Database → Create database → 名字 `smart-alert`。

### 2. 建 Worker
Workers & Pages → Create → Create Worker → 名字 `smart-alert` → 先 Deploy 默认代码 →
Edit code, 把默认代码全删, 粘贴 `worker/worker.js` 全文 → Deploy。

> ⚠️ 不要用控制台的"上传项目/拖放文件"入口, 它会报"暂不支持需要构建过程的项目"。
> 本项目是单文件无构建, 只有 Edit code 粘贴可用; 或者用命令行 `wrangler deploy`
> (`worker/wrangler.toml` 已写好绑定与 Cron, 填入 database_id 即可)。

### 3. 绑 D1
Worker → Settings → Bindings → Add → D1 database → 变量名 `DB` → 选 `smart-alert` → 保存并 Deploy。

### 4. 设密钥
Worker → Settings → Variables and Secrets → Add 两个 Secret: `REPORT_TOKEN`、`BARK_URL` → 保存并 Deploy。

### 5. 加 Cron
Worker → Settings → Triggers → Cron Triggers → Add `*/10 * * * *`。

### 6. 绑自定义域名 (国内建议)
域名 DNS 需托管在 Cloudflare。Worker → Settings → Domains & Routes → Add → Custom Domain →
填如 `smart.example.com`, Cloudflare 会自动加 DNS 记录并签证书, 约 1 分钟生效。
之后所有地址都用这个域名 (下文以 `smart.example.com` 代指)。

### 7. 测推送 (装客户端前先过这关)
```
curl -X POST https://smart.example.com/test -H "Authorization: Bearer <REPORT_TOKEN>"
```
手机收到「SMART 监控测试」即云端通。上报地址为 `https://smart.example.com/report`。

### 8. Linux 客户端
```
# 发行版需装好: smartmontools jq curl
# clients/linux/smart-report.sh 里改好 WORKER_URL (第 7 步的上报地址) 与 TOKEN
cp clients/linux/smart-report.sh /usr/local/bin/ && chmod +x /usr/local/bin/smart-report.sh
cp clients/linux/smart-report.service clients/linux/smart-report.timer /etc/systemd/system/
systemctl enable --now smart-report.timer
/usr/local/bin/smart-report.sh    # 先手动跑一次
```
浏览器开 `https://smart.example.com/status?token=<REPORT_TOKEN>` 能看到这台机与盘即通。
(不用 systemd 的环境可用 cron: `*/10 * * * * /usr/local/bin/smart-report.sh`)

### 9. OpenWrt 客户端
```
opkg install smartmontools jq curl
# smart-report.sh 按其末尾注释改成 ash 写法 (busybox 无数组), 改好 WORKER_URL / TOKEN
cp smart-report.sh /usr/bin/ && chmod +x /usr/bin/smart-report.sh
echo '*/10 * * * * /usr/bin/smart-report.sh' >> /etc/crontabs/root
/etc/init.d/cron restart
```

### 10. Windows 客户端
1. 装 smartmontools 官方 Windows 版 (默认 `C:\Program Files\smartmontools\`)。
2. 建 `C:\ProgramData\smart-alert\`, 放入改好地址/令牌的 `clients/windows/smart-report.ps1` 与 `install-task.ps1`。
3. 管理员 PowerShell 跑一次 `.\install-task.ps1` (注册 SYSTEM 每 10 分钟任务并立即执行一次)。
4. 回 `/status` 确认这台机出现。

> Windows 注意: smartctl 读 SMART 需要管理员权限, 所以任务以 SYSTEM 身份跑;
> PowerShell 5.1 需强制 TLS 1.2 才能连 Cloudflare (脚本已处理)。
> Intel RST/VMD 模式下的 NVMe 可能被 smartctl 漏掉, 脚本会自动改用系统自带的
> `Get-StorageReliabilityCounter` 降级补报 (只有磨损/温度/读写错误等粗粒度数据)。

### 11. (可选) 验证失联
停掉任一台的定时, 约 30 分钟后应收到「⚠️ 服务器失联」。验证完恢复定时。

## 判断规则 (worker.js 的 evaluate)

| 信号 | 级别 |
|---|---|
| SMART 总判定 FAILED | 紧急 |
| NVMe media_errors > 0 / Critical Warning 非零 / 备用块低于自身阈值 | 紧急 |
| 待处理扇区 (197) 非零 (数据已在风险中) | 紧急 |
| 关键属性 5/187/188/197/198 持续增长, 或 5/198 累计 ≥ 10 | 紧急 |
| 关键属性首次出现非零值 | 警告 |
| NVMe 寿命 ≥ 80% (≥ 100% 转紧急) | 警告 |
| CRC (199) 增长 (多半是数据线/接口问题, 不误判为盘坏) | 警告 |
| 温度连续 2 次超标 (ATA 55°C / NVMe 70°C) | 警告 |
| Windows 粗粒度盘: 磨损 ≥ 90% / 读写错误增长 (≥ 100% 磨损转紧急) | 警告 |

- 紧急 → Bark `critical` (静音也响); 警告 → `timeSensitive` (穿透专注模式)
- 采集时带 `--nocheck standby`, 休眠中的盘直接跳过, 不会为了读数把盘唤醒

## 接口

| 方法与路径 | 说明 |
|---|---|
| `POST /report` | 客户端上报 (Header: `Authorization: Bearer <REPORT_TOKEN>`) |
| `POST /test` | 发一条测试推送 |
| `GET /status?token=...` | 所有盘当前状态 |
| `GET /history?token=...&host=..&serial=..&days=30` | 某块盘的历史趋势 |

## 额度 (Cloudflare 免费版)

- Workers 请求 100,000/天: 每台机每天 144 次上报 + 144 次 Cron, 可忽略。
- D1 写 100,000 行/天: 一台 4 盘机每天约 144 × (1 主机 + 4 状态 + 4 历史) ≈ 1,300 行。
- 当初弃用 KV 的原因: KV 免费版每天仅 1,000 次写, 10 分钟一报必然超限。

## 开发笔记

- **D1 `exec()` 的坑**: 它按行切分 SQL, 多行 `CREATE TABLE` 会被切断报
  `D1_EXEC_ERROR ... incomplete input`。本地 SQLite 不挑这个, 模拟测试发现不了,
  故建表改为"每条语句单行 + `batch(prepare(...))`"。(`schema.sql` 在控制台/wrangler
  执行不受此限, 只有 JS 的 `exec()` 有这毛病。)
- Worker 逻辑已用本地真 SQLite 冒充 D1 做过场景测试: 健康静默 / 待处理扇区推 critical /
  重复上报不重复推 / NVMe media_errors 推 critical / 状态列表 / 历史累积 /
  失联触发且不重复, 全部符合预期。
- PowerShell 脚本未在真实 Windows 环境实测, 部署时请先手动跑一次确认。

## License

MIT
