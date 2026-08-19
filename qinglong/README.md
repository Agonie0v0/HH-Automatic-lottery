# HHCLUB 幸运大转盘 · 命令行版

**不只能在青龙里跑** —— 任何装了 Node 18+ 的机器（Debian / Ubuntu / NAS / 群晖…）`node hh_lottery.js` 直接就能用。不用开浏览器、不用挂机。**所有配置都在脚本最上面那一块，改完保存就能跑，不用配环境变量。** 跟油猴版共用一套抽奖逻辑（限流退避、VIP 折算、站内信清理都在），只是把面板换成了日志和通知。

统计会存成一份 JSON，**格式和油猴版的「💾 备份 JSON」完全一致** —— 挂 NAS 上跑，隔段时间把文件拿下来，在浏览器面板里点「📥 导入备份」就能合进电脑上的历史统计。

**依赖：Node 18 以上。** 用的是内置 `fetch`，不需要 `npm install` 任何东西。

---

## 装

### 青龙

脚本管理 → 新建 `hh_lottery.js`，把 [`hh_lottery.js`](hh_lottery.js) 全文贴进去。或者直接拉：

```bash
ql raw https://raw.githubusercontent.com/SAGIRIxr/HH-Automatic-lottery/main/qinglong/hh_lottery.js
```

脚本头部带了 `cron: 5 9 * * *`（每天早上 9:05），青龙一般会自动识别；没识别就手动建个定时任务指过去。

### Debian / Ubuntu / NAS 直接跑

只要 Node 18 以上，下下来改完配置就能跑，没有任何依赖：

```bash
curl -fLO https://raw.githubusercontent.com/SAGIRIxr/HH-Automatic-lottery/main/qinglong/hh_lottery.js
```

```bash
node hh_lottery.js
```

Debian 12 自带的 `nodejs` 包是 18.19，够用；`node -v` 看一下就知道。

定时用 crontab（`crontab -e`）：

```
5 9 * * * cd /opt/hh && /usr/bin/node hh_lottery.js >> /var/log/hh-lottery.log 2>&1
```

或者 systemd timer，`/etc/systemd/system/hh-lottery.service`：

```ini
[Unit]
Description=HHCLUB 幸运大转盘

[Service]
Type=oneshot
WorkingDirectory=/opt/hh
ExecStart=/usr/bin/node /opt/hh/hh_lottery.js
```

`/etc/systemd/system/hh-lottery.timer`：

```ini
[Unit]
Description=每天跑一次 HHCLUB 抽奖

[Timer]
OnCalendar=*-*-* 09:05:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl enable --now hh-lottery.timer
```

跑到一半按 Ctrl-C（或者 `systemctl stop`）不会丢成绩 —— 收到信号会先把已经抽到的存进统计文件再退出。

---

## 配置

打开脚本，最上面就是配置区，改完保存即可：

```js
const CONFIG = {
    /* ① Cookie（必填） */
    cookie: '在这里粘贴你的 Cookie',

    draws: 10,          // ② 每次抽多少次。填 0 = 一抽到底
    reserve: 0,         // ③ 一抽到底时留多少憨豆
    interval: 8,        // ④ 每抽间隔（秒），最小 3
    maxMinutes: 60,     // ⑤ 单次运行时间上限（分钟）
    cleanMail: false,   // ⑥ 抽完顺手清抽奖站内信
    statsFile: 'hh_lottery_stats.json',   // ⑦ 统计存哪儿，留空 '' 就是不记
    timezone: 'Asia/Shanghai',            // ⑧ 日志时间按哪个时区显示
    host: 'hhanclub.net',
    userAgent: '...'
};
```

| 项 | 默认 | 说明 |
|---|---|---|
| `cookie` | **必填** | 站点完整 Cookie |
| `draws` | `10` | 每次运行抽多少次。**填 `0` 表示一抽到底** |
| `reserve` | `0` | 一抽到底时留多少憨豆不动 |
| `interval` | `8` | 每抽间隔（秒），最小 3。站点有重复点击风控，别贪快 |
| `maxMinutes` | `60` | 单次运行时间上限（分钟），防止一抽到底把任务挂死 |
| `cleanMail` | `false` | 抽完顺手清掉「幸运大转盘 中奖通知」站内信 |
| `statsFile` | `hh_lottery_stats.json` | 统计存到哪个文件，相对路径按脚本所在目录算。留空 `''` 就是不记 |
| `timezone` | `Asia/Shanghai` | 日志时间按哪个时区显示。容器里系统时区多半是 UTC，不设的话日志时间跟你对不上 |
| `host` | `hhanclub.net` | 站点域名，一般不用改 |
| `userAgent` | Chrome | 一般不用改 |

填错类型不会炸：数字项会收敛到合法范围，`cookie` 没换掉的话会直接提示你去填而不是拿占位文字去请求。

### 几种常见配法

```js
draws: 20,                          // 每天固定抽 20 次
```

```js
draws: 0, reserve: 500000, maxMinutes: 120,   // 抽到只剩 50 万，最多跑 2 小时
```

```js
cleanMail: true,                    // 顺手清站内信
```

---

## 取 Cookie

浏览器登录 hhanclub.net → F12 → Network → 随便点一个请求 → 请求头里的 `Cookie:` 整行复制。

大概长这样（`c_secure_uid` 和 `c_secure_pass` 是关键，少了就登不上）：

```
c_secure_uid=NzMyMQ%3D%3D; c_secure_pass=...; c_secure_ssl=...; c_secure_tracker_ssl=...; c_secure_login=...
```

**Cookie 等于你的账号。** 别往任何第三方脚本或聊天框里贴。

（站点每人只能有一个号，所以这里没做多账号。）

---

## 跑完能看到什么

```
[08/19 09:05:01] 🎡 HHCLUB 幸运大转盘
[08/19 09:05:01]    抽 20 次 · 间隔 8 秒
[08/19 09:05:02] ▶ 开始 · 余额 1,574,093 憨豆 · 单抽 2,000
[08/19 09:05:02] 🎲 第 1 抽：魔力 2000 · 余额 1,574,093
[08/19 09:05:10] 🎲 第 2 抽：补签卡 1 · 余额 1,572,093
...
[08/19 09:07:48] 📪 清掉 20 封抽奖通知
[08/19 09:07:48] 💾 统计已存到 /opt/hh/hh_lottery_stats.json

────────────────────────────────────────
本次：20 抽
  消耗 40,000 · 获得 37,100 憨豆
  盈亏 -2,900（-7.3%）
  其他：补签卡 2个 · 上传量 2GB
    2,000 憨豆 × 6
    100 憨豆 × 5
    1,000 憨豆 × 4
    5,000 憨豆 × 3
    补签卡 1 个 × 2
    上传量 2 GB × 1

历史总计：860 抽
  消耗 1,720,000 · 获得 1,698,400 憨豆
  盈亏 -21,600（-1.3%）

余额 1,571,193
```

每行日志都带时间戳（按 `timezone` 显示），汇总块不带 —— 套上反而没法看。青龙装了通知模块的话，这份汇总会一并推过去；直接跑的话重定向到文件即可。

---

## 统计导出 / 导入电脑

`statsFile` 指的那份 JSON 就是油猴版的备份格式，跨次运行一直累加：

```json
{
  "kind": "hhclub-lottery-backup",
  "version": 4,
  "exportedAt": "2026-08-19T12:00:00.000Z",
  "source": "qinglong",
  "current": { "draws": 20, ... },   // 这一次跑的
  "total":   { "draws": 860, ... }   // 累计
}
```

默认落在脚本同目录（青龙里一般是 `/ql/data/scripts/hh_lottery_stats.json`），写绝对路径也行。

**导到电脑上：** 把这个文件下载下来 → 打开 `hhanclub.net/lucky.php` → 面板上点「📥 导入备份」→ 选**合并**。两边记录本来就不重合，合并之后 NAS 上抽的和电脑上抽的就并到一块了。

导入读的是 `total` 那一份，所以每次导的都是完整累计；要是你在电脑上也抽过，选「合并」会把两边相加 —— 别重复导同一个文件，不然会算两遍。

---

## 它会自己处理的几件事

- **限流退避** —— 连续被拦就把间隔往上调（最高 30 秒），连拦 12 次放弃这个账号
- **接口异常** —— 连续 5 次失败自动停，不会闷头刷请求
- **憨豆不足 / 次数用完** —— 站点这么说就立刻停，不重试
- **单抽消耗变了** —— 每次开跑前读页面上的实际值，站点调价自动跟上
- **已是 VIP 时的憨豆折算** —— 见下

### 关于 VIP

抽奖页写着：**「当中奖 [VIP] 时，如果用户已经是 VIP 或以上等级，奖励憨豆：1000000」**，但接口返回的中奖文案还是 `VIP 7 Day(s)`。照文案记账的话，这一注会被记成「VIP 7 天」，一百万憨豆凭空蒸发。

脚本不去猜你是不是 VIP，**让余额说话**：中到 VIP 就当场回服务端核一次，余额真比估算多出十万以上就认定发生了替换。

认定之后这一注**仍然算一次 VIP 中奖**（转盘确实停在 VIP 那一格，爆率统计不该少这一笔），变的只是档位和收益：

- VIP 档位从「7 天」换成「已转换为憨豆 1,000,000」
- VIP 天数扣回去（没真拿到）
- 憨豆收入加上，单独记在 `swappedBeans` 上 —— 天数和憨豆不是一个单位，不能混在一起

不是 VIP 的用户余额对得上，照常记 VIP 天数。这套口径和油猴版 v1.16.0 完全一致。

---

## 测试

```bash
npm run test:ql
```

会在本地起一个假站点，把脚本当子进程真跑一遍，覆盖按次数抽 / 一抽到底 / VIP 折算两种走向及其跨次留存 / 站内信清理（含每页 10 封的分页）/ 统计导出格式 / 跨次累计 / 统计文件损坏 / Cookie 没填 / Cookie 失效 / 日志时间戳与时区 / 在仓库里直接运行，共 76 条断言。

测试是**照你的用法来的**：复制一份源码、把配置区整块换掉、再当子进程真跑，所以配置区的写法本身也在被测。

抽奖接口是花真憨豆的，没法拿线上验证，所以这层是它唯一的安全网 —— 改完记得跑。

---

## 免责声明

脚本只调用站点自身的接口，不做任何数据篡改。请自行控制抽奖频率，因使用本脚本产生的任何后果由使用者自行承担。
