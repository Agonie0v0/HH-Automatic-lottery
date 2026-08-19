/**
 * HHCLUB 幸运大转盘 · 青龙版
 *
 * new Env('HHCLUB抽奖');
 * cron: 5 9 * * *
 *
 * 用法：把下面「配置区」里的 Cookie 填上就能跑，其余按需改。
 * 详细说明见同目录 README.md。
 *
 * 统计会存成一份 JSON，格式和油猴版的「💾 备份 JSON」完全一致 ——
 * 从 NAS 上把这个文件拿下来，在浏览器面板里点「📥 导入备份」就能合进去。
 *
 * 不只能在青龙里跑 —— 任何装了 Node 18+ 的机器（Debian / NAS / 群晖…）
 * 直接 `node hh_lottery.js` 就行，配 crontab 或 systemd timer 定时。
 *
 * 依赖：Node 18+（用的是内置 fetch，不需要 npm install 任何东西）
 * 仓库：https://github.com/SAGIRIxr/HH-Automatic-lottery
 * 协议：MIT
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/* =========================================================
   ⚙️ 配置区 —— 只用改这一块，下面的都不用动
========================================================= */

const CONFIG = {
    /* ① Cookie（必填）
          浏览器登录 hhanclub.net → F12 → Network → 随便点一个请求
          → 请求头里的 Cookie 整行复制过来 */
    cookie: '在这里粘贴你的 Cookie',

    /* ② 每次运行抽多少次。
          填 0 = 一抽到底，一直抽到余额跌破下面的保留线为止 */
    draws: 10,

    /* ③ 一抽到底时给自己留多少憨豆不动 */
    reserve: 0,

    /* ④ 每抽间隔（秒）。站点有重复点击风控，别贪快，最小 3 */
    interval: 8,

    /* ⑤ 单次运行的时间上限（分钟）。
          一抽到底可能跑很久，这个是防止把青龙任务挂死的保险 */
    maxMinutes: 60,

    /* ⑥ 抽完顺手清掉「幸运大转盘 中奖通知」站内信。
          站点每抽一次就发一封，不清的话收件箱很快被埋掉。
          只删这一种，「种子被删除」之类的一封不碰 */
    cleanMail: false,

    /* ⑦ 统计存到哪个文件。跨次运行累计，格式和油猴版备份一致，
          拿下来就能在浏览器面板里「📥 导入备份」。
          留空字符串 '' 就是不记 */
    statsFile: 'hh_lottery_stats.json',

    /* ⑧ 日志时间按哪个时区显示。
          青龙容器默认常是 UTC，不设这个的话日志时间对不上 */
    timezone: 'Asia/Shanghai',

    /* ⑨ 站点域名，一般不用改 */
    host: 'hhanclub.net',

    /* ⑩ User-Agent，一般不用改 */
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
};

/* ===== 配置区结束 ===== */

/* 下面这些是内部节奏参数，除非站点风控变了，否则不用碰 */
const RUNTIME = {
    // 请求节奏抖动比例，避免固定频率特征
    jitter: 0.15,
    // 连续失败多少次放弃
    maxErrors: 5,
    // 连续被限流多少次放弃
    maxRateLimits: 12,
    // 被限流后的退避
    backoffAfter: 3,
    backoffFactor: 1.5,
    maxBackoffMs: 30000,
    // 中 VIP 后余额比估算多出这么多，就认定站点改发了憨豆
    vipSwapMinBeans: 100000,
    // 站内信一次提交多少个 id
    mailChunk: 100,
    // 站内信翻页上限（每页显示多少封是用户自己在站点设置里定的）
    mailMaxPages: 600,
    // 反复清第一页的轮数上限
    mailSweepRounds: 20,
    lotteryMailKeyword: '幸运大转盘'
};

/* 配置是手填的，收一遍边界，免得填了个负数或者字符串就跑出怪结果 */
function normalizeConfig() {
    const int = (value, fallback, min) => {
        const number = parseInt(value, 10);
        return Number.isFinite(number) ? Math.max(min, number) : fallback;
    };

    CONFIG.draws = int(CONFIG.draws, 10, 0);
    CONFIG.reserve = int(CONFIG.reserve, 0, 0);
    CONFIG.interval = int(CONFIG.interval, 8, 3);
    CONFIG.maxMinutes = int(CONFIG.maxMinutes, 60, 1);
    CONFIG.cleanMail = CONFIG.cleanMail === true;
    CONFIG.host = String(CONFIG.host || 'hhanclub.net').trim().replace(/\/+$/, '');
    CONFIG.statsFile = String(CONFIG.statsFile || '').trim();
    CONFIG.timezone = String(CONFIG.timezone || '').trim();
}

/* 还没填 Cookie 的占位文字要认出来，不然会拿着「在这里粘贴」去请求 */
function readCookie() {
    const cookie = String(CONFIG.cookie || '').trim();
    return cookie && !cookie.includes('在这里粘贴') ? cookie : '';
}

/* =========================================================
   小工具
========================================================= */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/* 日志时间。跑在容器里的话系统时区多半是 UTC，跟人对不上，
   所以按 CONFIG.timezone 显示；时区名写错就退回 ISO。 */
function stamp() {
    const now = new Date();
    try {
        return now.toLocaleString('zh-CN', {
            timeZone: CONFIG.timezone || undefined,
            hour12: false,
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    } catch (error) {
        return now.toISOString().slice(5, 19).replace('T', ' ');
    }
}

function log(line = '') {
    console.log(line === '' ? '' : `[${stamp()}] ${line}`);
}

/* 汇总那种多行块不套时间戳，套上反而没法看 */
function raw(block) {
    console.log(block);
}

const messages = [];
function report(line) {
    // 通知里存不带时间戳的版本，推送出去更紧凑
    messages.push(line);
    log(line);
}

function fmt(value) {
    const number = Number(value) || 0;
    return Number.isInteger(number) ? number.toLocaleString('en-US') : number.toFixed(2);
}

/* 从文本里取第一个数字，兼容 "1,000" 这种千分位写法 */
function firstNumber(text) {
    const match = String(text ?? '').match(/(\d[\d,]*(?:\.\d+)?)/);
    return match ? parseFloat(match[1].replace(/,/g, '')) : null;
}

/* 接口返回的中奖文案是 \uXXXX 转义过的 */
function decodeUnicode(text) {
    if (typeof text !== 'string') return text;
    return text.replace(/\\u[\dA-F]{4}/gi, match =>
        String.fromCharCode(parseInt(match.slice(2), 16))
    );
}

/* 没有 DOM，只能在 HTML 里按 class 取值：
   先定位到那个 class 属性，跳到它所在标签的 '>' 之后，
   再把后面一小段的标签剥掉。比整段正则匹配耐改版。 */
function textAfterClass(html, className, span = 400) {
    const matched = new RegExp(`class="[^"]*\\b${className}\\b[^"]*"`, 'i').exec(html);
    if (!matched) return null;

    const start = html.indexOf('>', matched.index);
    if (start < 0) return null;

    return html.slice(start + 1, start + 1 + span).replace(/<[^>]*>/g, ' ');
}

function numberAfterClass(html, className) {
    return firstNumber(textAfterClass(html, className));
}

/* =========================================================
   奖品解析（和油猴版同一套规则）
========================================================= */

const PRIZE_META = {
    beans: { name: '憨豆', unit: '' },
    magic: { name: '憨豆（旧魔力）', unit: '' },
    invite: { name: '邀请', unit: '' },
    rainbow: { name: '彩虹ID', unit: '天' },
    vip: { name: 'VIP', unit: '天' },
    makeup: { name: '补签卡', unit: '个' },
    upload: { name: '上传量', unit: 'GB' },
    rename: { name: '改名卡', unit: '张' },
    unknown: { name: '其他奖品', unit: '' }
};

function parsePrizeText(text) {
    const compact = String(text || '').trim().replace(/\s+/g, ' ');
    const fallback = { type: 'unknown', value: 0, label: compact || '未知奖品' };
    if (!compact) return fallback;

    const rules = [
        // 站点奖池里 type 1001 的 typeText 写作「魔力」，但图标是 bean_icon、
        // 消耗侧也叫憨豆 —— 同一种货币，归到一类
        { type: 'beans', test: t => t.includes('魔力') || t.includes('憨豆') },
        { type: 'invite', test: t => t.includes('邀请') },
        { type: 'rainbow', test: t => t.includes('彩虹') },
        { type: 'vip', test: t => /VIP/i.test(t) },
        { type: 'makeup', test: t => t.includes('补签') },
        { type: 'upload', test: t => t.includes('上传') },
        { type: 'rename', test: t => t.includes('改名') }
    ];

    for (const rule of rules) {
        if (!rule.test(compact)) continue;

        const meta = PRIZE_META[rule.type];
        let value;

        if (rule.type === 'upload') {
            const match = compact.match(/(\d[\d,]*(?:\.\d+)?)\s*(TB|GB|MB)/i);
            if (!match) break;
            value = parseFloat(match[1].replace(/,/g, ''));
            const unit = match[2].toUpperCase();
            if (unit === 'TB') value *= 1024;
            if (unit === 'MB') value /= 1024;
            value = Math.round(value * 100) / 100;
        } else {
            value = firstNumber(compact);
            if (value === null) break;
        }

        return {
            type: rule.type,
            value,
            label: `${fmt(value)}${meta.unit ? ' ' + meta.unit : ' ' + meta.name}`
        };
    }

    return fallback;
}

/* =========================================================
   统计

   结构和油猴版的 v4 完全一致，所以存出来的文件能直接被面板上的
   「📥 导入备份」吃下去：
     draws  抽奖次数
     cost   累计消耗憨豆
     gains  各类奖品累计数值
     prizes 分奖项统计 { 类别: { count, value, tiers: { 档位: 次数 } } }
     raw    原始奖品文案计数
========================================================= */

function emptyStats() {
    return {
        version: 4,
        draws: 0,
        cost: 0,
        gains: { beans: 0, magic: 0, invite: 0, rainbow: 0, vip: 0, makeup: 0, upload: 0, rename: 0 },
        prizes: {},
        raw: {},
        firstAt: null,
        lastAt: null
    };
}

function ensureBucket(stats, type) {
    if (!stats.prizes[type]) stats.prizes[type] = { count: 0, value: 0, tiers: {} };
    return stats.prizes[type];
}

/* 读进来的文件可能是手改过的、或者早期版本存的，收一遍。
   早期版本把「魔力」当独立类别存过，这里合回 beans。 */
function normalizeStats(data) {
    const stats = emptyStats();
    if (!data || typeof data !== 'object') return stats;

    stats.draws = Number(data.draws) || 0;
    stats.cost = Number(data.cost) || 0;
    stats.firstAt = data.firstAt || null;
    stats.lastAt = data.lastAt || null;

    Object.keys(stats.gains).forEach(key => {
        stats.gains[key] = Number(data.gains?.[key]) || 0;
    });
    stats.gains.beans += Number(data.gains?.magic) || 0;
    stats.gains.magic = 0;

    Object.entries(data.prizes || {}).forEach(([type, bucket]) => {
        const merged = ensureBucket(stats, type === 'magic' ? 'beans' : type);
        merged.count += Number(bucket?.count) || 0;
        merged.value += Number(bucket?.value) || 0;

        const swapped = Number(bucket?.swappedBeans) || 0;
        if (swapped) merged.swappedBeans = (merged.swappedBeans || 0) + swapped;
        Object.entries(bucket?.tiers || {}).forEach(([label, count]) => {
            merged.tiers[label] = (merged.tiers[label] || 0) + (Number(count) || 0);
        });
    });

    stats.raw = { ...(data.raw || {}) };
    return stats;
}

function applyPrize(stats, prizeText, cost, prize) {
    stats.draws += 1;
    stats.cost += cost;

    if (prize.type !== 'unknown') {
        stats.gains[prize.type] = (stats.gains[prize.type] || 0) + prize.value;
    }

    const bucket = ensureBucket(stats, prize.type);
    bucket.count += 1;
    bucket.value += prize.value;
    bucket.tiers[prize.label] = (bucket.tiers[prize.label] || 0) + 1;

    // 接口返回的文案常带尾随空格，不 trim 的话同一个奖会留下两条 key
    const rawKey = String(prizeText).trim();
    stats.raw[rawKey] = (stats.raw[rawKey] || 0) + 1;

    stats.lastAt = Date.now();
    if (!stats.firstAt) stats.firstAt = stats.lastAt;
}

/* 把刚记下的那一注 VIP 改标成「已转换为憨豆」。

   这一注仍然算在 VIP 类别里 —— 转盘确实停在 VIP 那一格，
   中奖次数和爆率统计不该少这一笔。变的只有档位和收益归属：
     · VIP 档位从「7 天」换成「已转换为憨豆 1,000,000」
     · VIP 天数扣回去（没真拿到）
     · 憨豆收入加上（盈亏要算对），单独记在 swappedBeans 上 ——
       天数和憨豆不是一个单位，不能混进 bucket.value
   抽数和消耗都不动。 */
function markVipSwapped(stats, prize, beans) {
    stats.gains.vip = (stats.gains.vip || 0) - prize.value;
    stats.gains.beans = (stats.gains.beans || 0) + beans;

    const bucket = ensureBucket(stats, 'vip');
    bucket.value -= prize.value;
    bucket.swappedBeans = (bucket.swappedBeans || 0) + beans;
    bucket.tiers[prize.label] = (bucket.tiers[prize.label] || 0) - 1;
    if (bucket.tiers[prize.label] <= 0) delete bucket.tiers[prize.label];

    const swappedLabel = `已转换为憨豆 ${fmt(beans)}`;
    bucket.tiers[swappedLabel] = (bucket.tiers[swappedLabel] || 0) + 1;
}

function statsPath() {
    if (!CONFIG.statsFile) return '';
    return path.isAbsolute(CONFIG.statsFile)
        ? CONFIG.statsFile
        : path.join(__dirname, CONFIG.statsFile);
}

function loadTotal() {
    const file = statsPath();
    if (!file || !fs.existsSync(file)) return emptyStats();

    try {
        const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
        // 备份文件和裸的统计对象都收
        return normalizeStats(payload?.total || payload?.current || payload);
    } catch (error) {
        report(`⚠️ 统计文件读不出来（${error.message}），这次从零开始记`);
        return emptyStats();
    }
}

/* 存的就是油猴版备份文件那个格式，拿去导入即可 */
function saveStats(current, total) {
    const file = statsPath();
    if (!file) return '';

    const payload = {
        kind: 'hhclub-lottery-backup',
        version: 4,
        exportedAt: new Date().toISOString(),
        source: 'qinglong',
        current,
        total
    };

    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(payload, null, 2));
        return file;
    } catch (error) {
        report(`⚠️ 统计写不进去（${error.message}）`);
        return '';
    }
}

/* =========================================================
   抽奖
========================================================= */

class Lottery {
    constructor(cookie) {
        this.cookie = cookie;
        this.origin = /^https?:\/\//.test(CONFIG.host) ? CONFIG.host : `https://${CONFIG.host}`;

        this.balance = 0;
        this.cost = 2000;

        this.current = emptyStats();
        this.total = loadTotal();

        this.errorStreak = 0;
        this.rateLimitStreak = 0;
        this.intervalMs = CONFIG.interval * 1000;
        this.deadline = Date.now() + CONFIG.maxMinutes * 60 * 1000;
    }

    headers(extra = {}) {
        return {
            'cookie': this.cookie,
            'user-agent': CONFIG.userAgent,
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'referer': `${this.origin}/lucky.php`,
            ...extra
        };
    }

    async get(urlPath) {
        const response = await fetch(`${this.origin}${urlPath}`, { headers: this.headers() });
        if (!response.ok) throw new Error(`${urlPath} 请求失败（HTTP ${response.status}）`);
        return response.text();
    }

    /* 一次请求同时拿余额、单抽消耗。站点抽完不刷新页面，这两个数只能主动来取。 */
    async snapshot() {
        const html = await this.get('/lucky.php');

        if (/takelogin\.php|name="password"/i.test(html)) {
            throw new Error('Cookie 已失效，站点把我踢回登录页了');
        }

        const balance = numberAfterClass(html, 'bean-number');
        const cost = numberAfterClass(html, 'use-bean');

        if (balance === null) throw new Error('读不到憨豆余额，站点可能改版了');

        return { balance, cost: cost && cost > 0 ? Math.round(cost) : null };
    }

    async drawOnce() {
        const response = await fetch(`${this.origin}/plugin/lucky-draw`, {
            method: 'POST',
            headers: this.headers({
                'x-requested-with': 'XMLHttpRequest',
                // 站点自己用的是 jQuery.post，对齐 Content-Type
                'content-type': 'application/x-www-form-urlencoded; charset=UTF-8'
            }),
            body: ''
        });

        const text = await response.text();
        try {
            return { ok: response.ok, status: response.status, data: JSON.parse(text) };
        } catch (error) {
            return { ok: false, status: response.status, data: null, raw: text };
        }
    }

    record(prizeText, prize) {
        applyPrize(this.current, prizeText, this.cost, prize);
        applyPrize(this.total, prizeText, this.cost, prize);
    }

    /* 抽奖页写着：「当中奖 [VIP] 时，如果用户已经是 VIP 或以上等级，
       奖励憨豆：1000000」。接口返回的文案还是 VIP，替换是发奖时做的。
       所以中到 VIP 就回服务端核一次余额，真多出一大笔就改记成憨豆。

       不用去猜用户是不是 VIP —— 余额说了算。而且要是哪天 prize_text
       本身就返回「魔力 1000000」，那笔憨豆已经记进去了、估算和实际对得上，
       这里不会重复计。 */
    async reconcileVip(prize) {
        const estimated = this.balance;

        let actual;
        try {
            actual = (await this.snapshot()).balance;
        } catch (error) {
            return;
        }

        const drift = actual - estimated;
        this.balance = actual;
        if (drift < RUNTIME.vipSwapMinBeans) return;

        const beans = Math.round(drift);
        markVipSwapped(this.current, prize, beans);
        markVipSwapped(this.total, prize, beans);

        report(`👑 你已经是 VIP，站点改发了 ${fmt(beans)} 憨豆 · 仍计为一次 VIP 中奖`);
    }

    nextDelay() {
        const jitter = 1 + (Math.random() * 2 - 1) * RUNTIME.jitter;
        return Math.max(1000, Math.round(this.intervalMs * jitter));
    }

    shouldContinue() {
        if (Date.now() > this.deadline) {
            report(`⏰ 到达单次运行时间上限（${CONFIG.maxMinutes} 分钟），收工`);
            return false;
        }
        if (CONFIG.draws > 0) return this.current.draws < CONFIG.draws;

        // 一抽到底：留够保留线
        if (this.balance - this.cost < CONFIG.reserve) {
            report(`🏁 一抽到底完成，余额 ${fmt(this.balance)}（保留线 ${fmt(CONFIG.reserve)}）`);
            return false;
        }
        return true;
    }

    async run() {
        const start = await this.snapshot();
        this.balance = start.balance;
        if (start.cost) this.cost = start.cost;

        report(`▶ 开始 · 余额 ${fmt(this.balance)} 憨豆 · 单抽 ${fmt(this.cost)}`);

        if (this.balance < this.cost) {
            report('💸 憨豆不足，跳过');
            return;
        }
        if (CONFIG.draws === 0 && this.balance - this.cost < CONFIG.reserve) {
            report('💸 余额已在保留线之下，跳过');
            return;
        }

        let firstRound = true;

        while (this.shouldContinue()) {
            // 间隔放在开头：最后一抽完就收工，不用白等；
            // 出错和限流重试也自然变成「先等再试」
            if (!firstRound) await sleep(this.nextDelay());
            firstRound = false;

            const result = await this.drawOnce();

            if (!result.data) {
                this.errorStreak++;
                log(`❌ 请求失败（HTTP ${result.status}）`);
                if (this.errorStreak >= RUNTIME.maxErrors) {
                    report(`🛑 连续 ${this.errorStreak} 次失败，停止`);
                    return;
                }
                continue;
            }

            if (result.data.ret === 0) {
                this.errorStreak = 0;
                this.rateLimitStreak = 0;
                this.intervalMs = CONFIG.interval * 1000;

                const prizeText = decodeUnicode(result.data.data?.prize_text || '未知奖品');
                const prize = parsePrizeText(prizeText);

                this.record(prizeText, prize);
                // 中的憨豆是真回血，本地结算一次，省得每抽都去要余额
                this.balance = Math.max(0, this.balance - this.cost + (prize.type === 'beans' ? prize.value : 0));

                log(`🎲 第 ${this.current.draws} 抽：${prizeText.trim()} · 余额 ${fmt(this.balance)}`);

                if (prize.type === 'vip') await this.reconcileVip(prize);
                continue;
            }

            const msg = decodeUnicode(result.data.msg || '未知错误');

            if (msg.includes('重复点击') || msg.includes('请稍后') || msg.includes('频繁')) {
                this.rateLimitStreak++;
                log(`⏳ ${msg}`);

                if (this.rateLimitStreak >= RUNTIME.backoffAfter) {
                    this.intervalMs = Math.min(this.intervalMs * RUNTIME.backoffFactor, RUNTIME.maxBackoffMs);
                    log(`🔄 间隔上调到 ${(this.intervalMs / 1000).toFixed(1)} 秒`);
                }
                if (this.rateLimitStreak >= RUNTIME.maxRateLimits) {
                    report(`🛑 连续 ${this.rateLimitStreak} 次被限流，停止`);
                    return;
                }
                continue;
            }

            // 憨豆不足 / 次数用完这类是明确的终止信号，不重试
            if (msg.includes('次数') || msg.includes('用完') || msg.includes('不足')) {
                report(`🛑 ${msg}，停止`);
                return;
            }

            this.errorStreak++;
            log(`❌ ${msg}`);
            if (this.errorStreak >= RUNTIME.maxErrors) {
                report(`🛑 连续 ${this.errorStreak} 次失败，停止`);
                return;
            }
        }
    }

    /* ---------------- 站内信清理 ---------------- */

    /* 站点每抽一次就发一封「幸运大转盘 中奖通知」，挂机一晚收件箱就被埋了。
       只删这一种，「种子被删除」之类的一封不碰。 */
    parseMailbox(html) {
        const items = [];
        const re = /viewmessage&(?:amp;)?id=(\d+)"[^>]*>([\s\S]*?)<\/a>/gi;
        let match;
        while ((match = re.exec(html)) !== null) {
            items.push({ id: match[1], subject: match[2].replace(/<[^>]*>/g, '').trim() });
        }

        // 翻页下拉框每页一个 option，直接就是总页数。
        // 不能靠「这页不满 100 封」判断 —— 每页显示多少封是用户自己设的
        const select = /<select[^>]*switchPage[^>]*>([\s\S]*?)<\/select>/i.exec(html);
        const pageCount = select ? (select[1].match(/<option/gi) || []).length : 0;

        return { items, pageCount };
    }

    async mailPage(page) {
        return this.parseMailbox(await this.get(`/messages.php?action=viewmailbox&box=1&page=${page}`));
    }

    async deleteMail(ids) {
        let done = 0;

        for (let at = 0; at < ids.length; at += RUNTIME.mailChunk) {
            const chunk = ids.slice(at, at + RUNTIME.mailChunk);
            const body = new URLSearchParams();
            body.append('action', 'moveordel');
            chunk.forEach(id => body.append('messages[]', id));
            body.append('delete', '删除');

            const response = await fetch(`${this.origin}/messages.php`, {
                method: 'POST',
                headers: this.headers({ 'content-type': 'application/x-www-form-urlencoded' }),
                body
            });
            if (!response.ok) throw new Error(`删除站内信失败（HTTP ${response.status}）`);

            done += chunk.length;
        }

        return done;
    }

    async cleanMail() {
        const isLottery = item => item.subject.includes(RUNTIME.lotteryMailKeyword);
        let removed = 0;

        try {
            // 翻完整个收件箱，把要删的 id 收齐
            const doomed = [];
            const seen = new Set();
            const first = await this.mailPage(0);
            const totalPages = first.pageCount > 0 ? first.pageCount : RUNTIME.mailMaxPages;

            for (let page = 0; page < Math.min(totalPages, RUNTIME.mailMaxPages); page++) {
                const { items } = page === 0 ? first : await this.mailPage(page);
                if (!items.length) break;
                if (items.every(item => seen.has(item.id))) break;

                items.forEach(item => {
                    if (seen.has(item.id)) return;
                    seen.add(item.id);
                    if (isLottery(item)) doomed.push(item.id);
                });

                // 下拉框读不到页数时退回长度判断，以第一页的条数为准
                if (first.pageCount <= 0 && items.length < first.items.length) break;
            }

            if (doomed.length) removed += await this.deleteMail(doomed);

            // 扫描到删完这几秒里可能又进了新通知，补扫第一页收尾
            for (let round = 0; round < RUNTIME.mailSweepRounds; round++) {
                const { items } = await this.mailPage(0);
                const ids = items.filter(isLottery).map(item => item.id);
                if (!ids.length) break;
                removed += await this.deleteMail(ids);
            }
        } catch (error) {
            report(`⚠️ 站内信清理失败：${error.message}`);
            return;
        }

        if (removed) report(`📪 清掉 ${fmt(removed)} 封抽奖通知`);
    }

    /* ---------------- 汇总 ---------------- */

    summarize(stats, title) {
        if (!stats.draws) return `${title}：一抽未成`;

        const beans = stats.gains.beans || 0;
        const profit = beans - stats.cost;
        const rate = stats.cost > 0 ? (profit / stats.cost) * 100 : 0;

        const others = Object.entries(stats.gains)
            .filter(([type, value]) => type !== 'beans' && type !== 'magic' && value > 0)
            .map(([type, value]) => `${PRIZE_META[type]?.name || type} ${fmt(value)}${PRIZE_META[type]?.unit || ''}`)
            .join(' · ');

        // 折算成憨豆的那部分和天数不是一个单位，单独说一句
        const swapped = Object.entries(stats.prizes)
            .filter(([, bucket]) => bucket.swappedBeans > 0)
            .map(([type, bucket]) =>
                `${PRIZE_META[type]?.name || type} 折算 ${fmt(bucket.swappedBeans)} 憨豆`)
            .join(' · ');

        const tiers = Object.values(stats.prizes)
            .flatMap(bucket => Object.entries(bucket.tiers))
            .sort((a, b) => b[1] - a[1])
            .map(([label, count]) => `    ${label} × ${count}`)
            .join('\n');

        return [
            `${title}：${fmt(stats.draws)} 抽`,
            `  消耗 ${fmt(stats.cost)} · 获得 ${fmt(beans)} 憨豆`,
            `  盈亏 ${profit >= 0 ? '+' : ''}${fmt(profit)}（${rate >= 0 ? '+' : ''}${rate.toFixed(1)}%）`,
            others ? `  其他：${others}` : '',
            swapped ? `  折算：${swapped}` : '',
            tiers
        ].filter(Boolean).join('\n');
    }

    summary() {
        const lines = [this.summarize(this.current, '本次')];
        if (CONFIG.statsFile && this.total.draws > this.current.draws) {
            lines.push('', this.summarize(this.total, '历史总计'));
        }
        lines.push('', `余额 ${fmt(this.balance)}`);
        return lines.join('\n');
    }
}

/* =========================================================
   入口
========================================================= */

async function notify(title, content) {
    let sender = null;
    for (const modulePath of ['./sendNotify', '/ql/data/scripts/sendNotify', '/ql/scripts/sendNotify']) {
        try {
            sender = require(modulePath);
            break;
        } catch (error) {
            // 没装通知模块就算了，日志里一样看得到
        }
    }
    if (!sender) return;

    const send = sender.sendNotify || sender;
    if (typeof send === 'function') {
        try {
            await send(title, content);
        } catch (error) {
            log(`⚠️ 通知发送失败：${error.message}`);
        }
    }
}

/* 直接在终端跑的时候 Ctrl-C 很常见，抽到一半的成绩不能就这么没了。
   青龙停任务发的也是 SIGTERM，同样接住。 */
function guardExit(lottery) {
    let bailing = false;

    const bail = signal => () => {
        if (bailing) process.exit(130);
        bailing = true;

        log(`\n⚠️ 收到 ${signal}，先把已抽到的存下来再退出`);
        if (lottery.current.draws > 0) {
            const file = saveStats(lottery.current, lottery.total);
            if (file) log(`💾 统计已存到 ${file}`);
        }
        raw(`\n${'─'.repeat(40)}\n${lottery.summary()}`);
        process.exit(130);
    };

    process.on('SIGINT', bail('Ctrl-C'));
    process.on('SIGTERM', bail('SIGTERM'));
}

async function main() {
    if (typeof fetch !== 'function') {
        log('❌ 需要 Node 18 或更高版本（脚本用的是内置 fetch）');
        process.exit(1);
    }

    normalizeConfig();

    const cookie = readCookie();
    if (!cookie) {
        log('❌ 还没填 Cookie。打开脚本，把最上面「配置区」里 cookie 那一行换成你的 Cookie：');
        log('   浏览器登录 hhanclub.net → F12 → Network → 任意请求 → 请求头里的 Cookie 整行复制');
        process.exit(1);
    }

    log('🎡 HHCLUB 幸运大转盘');
    log(CONFIG.draws > 0
        ? `   抽 ${CONFIG.draws} 次 · 间隔 ${CONFIG.interval} 秒`
        : `   一抽到底 · 保留 ${fmt(CONFIG.reserve)} 憨豆 · 间隔 ${CONFIG.interval} 秒`);

    const lottery = new Lottery(cookie);
    guardExit(lottery);

    try {
        await lottery.run();
        if (CONFIG.cleanMail) await lottery.cleanMail();
    } catch (error) {
        report(`❌ ${error.message}`);
    }

    // 抽出来的成绩不能因为后面出岔子就丢了，无论如何先落盘
    if (lottery.current.draws > 0) {
        const file = saveStats(lottery.current, lottery.total);
        if (file) report(`💾 统计已存到 ${file}（可直接在油猴面板里「导入备份」）`);
    }

    const summary = lottery.summary();
    raw(`\n${'─'.repeat(40)}\n${summary}`);

    await notify('HHCLUB 幸运大转盘', [...messages, '', summary].join('\n').trim());
}

main().catch(error => {
    log(`❌ 脚本异常：${error.stack || error.message}`);
    process.exit(1);
});
