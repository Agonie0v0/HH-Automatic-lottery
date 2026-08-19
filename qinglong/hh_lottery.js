/**
 * HHCLUB 幸运大转盘 · 青龙版
 *
 * new Env('HHCLUB抽奖');
 * cron: 5 9 * * *
 *
 * 只需要填 Cookie 就能跑。变量说明见同目录 README.md。
 *
 * 依赖：Node 18+（用的是内置 fetch，不需要 npm install 任何东西）
 * 仓库：https://github.com/SAGIRIxr/HH-Automatic-lottery
 * 协议：MIT
 */

'use strict';

/* =========================================================
   环境变量
========================================================= */

const CONFIG = {
    // 站点域名，一般不用改。带不带 https:// 都认
    host: (process.env.HH_HOST || 'hhanclub.net').replace(/\/+$/, ''),

    // 每次运行抽多少次。填 0 表示「一抽到底」，抽到余额跌破保留线为止
    draws: intEnv('HH_DRAWS', 10, 0),

    // 一抽到底时给自己留多少憨豆
    reserve: intEnv('HH_RESERVE', 0, 0),

    // 请求间隔（秒）。站点有重复点击风控，别设太小
    interval: intEnv('HH_INTERVAL', 8, 3),

    // 单次运行的时间上限（分钟），防止「一抽到底」把青龙任务挂死
    maxMinutes: intEnv('HH_MAX_MINUTES', 60, 1),

    // 抽完顺手清掉「幸运大转盘 中奖通知」站内信
    cleanMail: boolEnv('HH_CLEAN_MAIL', false),

    // 多账号之间的间隔（秒）
    accountGap: intEnv('HH_ACCOUNT_GAP', 10, 0)
};

const RUNTIME = {
    // 请求节奏抖动比例，避免固定频率特征
    jitter: 0.15,
    // 连续失败多少次放弃这个账号
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

function intEnv(name, fallback, min) {
    const value = parseInt(process.env[name], 10);
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, value);
}

function boolEnv(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    return /^(1|true|yes|on|是)$/i.test(String(raw).trim());
}

/* Cookie 支持多账号：用 & 或换行分隔 */
function readCookies() {
    const raw = process.env.HH_COOKIE || process.env.HHCLUB_COOKIE || '';
    return raw
        .split(/[&\n\r]+/)
        .map(item => item.trim())
        .filter(item => item.length > 0);
}

/* =========================================================
   小工具
========================================================= */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function log(...args) {
    console.log(...args);
}

const messages = [];
function report(line) {
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
   一个账号
========================================================= */

class Account {
    constructor(cookie, index) {
        this.cookie = cookie;
        this.index = index;
        this.origin = /^https?:\/\//.test(CONFIG.host) ? CONFIG.host : `https://${CONFIG.host}`;
        this.name = `账号 ${index + 1}`;

        this.balance = 0;
        this.cost = 2000;
        this.draws = 0;
        this.spent = 0;
        this.gains = {};
        this.tiers = {};

        this.errorStreak = 0;
        this.rateLimitStreak = 0;
        this.intervalMs = CONFIG.interval * 1000;
        this.deadline = Date.now() + CONFIG.maxMinutes * 60 * 1000;
    }

    headers(extra = {}) {
        return {
            'cookie': this.cookie,
            'user-agent': process.env.HH_UA
                || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                 + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'referer': `${this.origin}/lucky.php`,
            ...extra
        };
    }

    async get(path) {
        const response = await fetch(`${this.origin}${path}`, { headers: this.headers() });
        if (!response.ok) throw new Error(`${path} 请求失败（HTTP ${response.status}）`);
        return response.text();
    }

    /* 一次请求同时拿余额、单抽消耗。站点抽完不刷新页面，
       这两个数只能主动来取。 */
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

    record(prize) {
        this.draws += 1;
        this.spent += this.cost;
        this.gains[prize.type] = (this.gains[prize.type] || 0) + prize.value;
        this.tiers[prize.label] = (this.tiers[prize.label] || 0) + 1;
    }

    /* 抽奖页写着：「当中奖 [VIP] 时，如果用户已经是 VIP 或以上等级，
       奖励憨豆：1000000」。接口返回的文案还是 VIP，替换是发奖时做的。
       所以中到 VIP 就回服务端核一次余额，真多出一大笔就改记成憨豆。 */
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

        // 撤掉按 VIP 记的那一笔，改记成憨豆
        this.gains.vip = (this.gains.vip || 0) - prize.value;
        if (this.gains.vip <= 0) delete this.gains.vip;
        this.tiers[prize.label] -= 1;
        if (this.tiers[prize.label] <= 0) delete this.tiers[prize.label];

        const swapped = parsePrizeText(`魔力 ${Math.round(drift)}`);
        this.gains.beans = (this.gains.beans || 0) + swapped.value;
        this.tiers[swapped.label] = (this.tiers[swapped.label] || 0) + 1;

        report(`👑 ${this.name} 已是 VIP，站点改发 ${fmt(swapped.value)} 憨豆，已按憨豆记账`);
    }

    nextDelay() {
        const jitter = 1 + (Math.random() * 2 - 1) * RUNTIME.jitter;
        return Math.max(1000, Math.round(this.intervalMs * jitter));
    }

    /* 该不该再抽一次 */
    shouldContinue() {
        if (Date.now() > this.deadline) {
            report(`⏰ ${this.name} 到达单次运行时间上限（${CONFIG.maxMinutes} 分钟），收工`);
            return false;
        }
        if (CONFIG.draws > 0) return this.draws < CONFIG.draws;

        // 一抽到底：留够保留线
        if (this.balance - this.cost < CONFIG.reserve) {
            report(`🏁 ${this.name} 一抽到底完成，余额 ${fmt(this.balance)}（保留线 ${fmt(CONFIG.reserve)}）`);
            return false;
        }
        return true;
    }

    async run() {
        const start = await this.snapshot();
        this.balance = start.balance;
        if (start.cost) this.cost = start.cost;

        report(`\n▶ ${this.name} 开始 · 余额 ${fmt(this.balance)} 憨豆 · 单抽 ${fmt(this.cost)}`);

        if (this.balance < this.cost) {
            report(`💸 ${this.name} 憨豆不足，跳过`);
            return;
        }
        if (CONFIG.draws === 0 && this.balance - this.cost < CONFIG.reserve) {
            report(`💸 ${this.name} 余额已在保留线之下，跳过`);
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
                log(`❌ ${this.name} 请求失败（HTTP ${result.status}）`);
                if (this.errorStreak >= RUNTIME.maxErrors) {
                    report(`🛑 ${this.name} 连续 ${this.errorStreak} 次失败，停止`);
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

                this.record(prize);
                // 中的憨豆是真回血，本地结算一次，省得每抽都去要余额
                this.balance = Math.max(0, this.balance - this.cost + (prize.type === 'beans' ? prize.value : 0));

                log(`🎲 ${this.name} 第 ${this.draws} 抽：${prizeText.trim()} · 余额 ${fmt(this.balance)}`);

                if (prize.type === 'vip') await this.reconcileVip(prize);
                continue;
            }

            const msg = decodeUnicode(result.data.msg || '未知错误');

            if (msg.includes('重复点击') || msg.includes('请稍后') || msg.includes('频繁')) {
                this.rateLimitStreak++;
                log(`⏳ ${this.name} ${msg}`);

                if (this.rateLimitStreak >= RUNTIME.backoffAfter) {
                    this.intervalMs = Math.min(this.intervalMs * RUNTIME.backoffFactor, RUNTIME.maxBackoffMs);
                    log(`🔄 ${this.name} 间隔上调到 ${(this.intervalMs / 1000).toFixed(1)} 秒`);
                }
                if (this.rateLimitStreak >= RUNTIME.maxRateLimits) {
                    report(`🛑 ${this.name} 连续 ${this.rateLimitStreak} 次被限流，停止`);
                    return;
                }
                continue;
            }

            // 憨豆不足 / 次数用完这类是明确的终止信号，不重试
            if (msg.includes('次数') || msg.includes('用完') || msg.includes('不足')) {
                report(`🛑 ${this.name} ${msg}，停止`);
                return;
            }

            this.errorStreak++;
            log(`❌ ${this.name} ${msg}`);
            if (this.errorStreak >= RUNTIME.maxErrors) {
                report(`🛑 ${this.name} 连续 ${this.errorStreak} 次失败，停止`);
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
            let first = await this.mailPage(0);
            let totalPages = first.pageCount > 0 ? first.pageCount : RUNTIME.mailMaxPages;

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
            report(`⚠️ ${this.name} 站内信清理失败：${error.message}`);
            return;
        }

        if (removed) report(`📪 ${this.name} 清掉 ${fmt(removed)} 封抽奖通知`);
    }

    summary() {
        if (!this.draws) return `${this.name}：一抽未成`;

        const beans = this.gains.beans || 0;
        const profit = beans - this.spent;
        const rate = this.spent > 0 ? (profit / this.spent) * 100 : 0;

        const others = Object.entries(this.gains)
            .filter(([type]) => type !== 'beans' && type !== 'unknown')
            .map(([type, value]) => `${PRIZE_META[type]?.name || type} ${fmt(value)}${PRIZE_META[type]?.unit || ''}`)
            .join(' · ');

        const tierLines = Object.entries(this.tiers)
            .sort((a, b) => b[1] - a[1])
            .map(([label, count]) => `    ${label} × ${count}`)
            .join('\n');

        return [
            `${this.name}：${this.draws} 抽`,
            `  消耗 ${fmt(this.spent)} · 获得 ${fmt(beans)} 憨豆`,
            `  盈亏 ${profit >= 0 ? '+' : ''}${fmt(profit)}（${rate >= 0 ? '+' : ''}${rate.toFixed(1)}%）`,
            `  余额 ${fmt(this.balance)}`,
            others ? `  其他：${others}` : '',
            tierLines
        ].filter(Boolean).join('\n');
    }
}

/* =========================================================
   入口
========================================================= */

async function notify(title, content) {
    let sender = null;
    for (const path of ['./sendNotify', '/ql/data/scripts/sendNotify', '/ql/scripts/sendNotify']) {
        try {
            sender = require(path);
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

async function main() {
    if (typeof fetch !== 'function') {
        log('❌ 需要 Node 18 或更高版本（脚本用的是内置 fetch）');
        process.exit(1);
    }

    const cookies = readCookies();
    if (!cookies.length) {
        log('❌ 没读到 HH_COOKIE。去青龙「环境变量」里加一条 HH_COOKIE，值是站点的完整 Cookie');
        log('   多账号用 & 或换行分隔');
        process.exit(1);
    }

    log(`🎡 HHCLUB 幸运大转盘 · 共 ${cookies.length} 个账号`);
    log(CONFIG.draws > 0
        ? `   每个账号抽 ${CONFIG.draws} 次 · 间隔 ${CONFIG.interval} 秒`
        : `   一抽到底 · 保留 ${fmt(CONFIG.reserve)} 憨豆 · 间隔 ${CONFIG.interval} 秒`);

    const accounts = [];

    for (let i = 0; i < cookies.length; i++) {
        const account = new Account(cookies[i], i);
        accounts.push(account);

        try {
            await account.run();
            if (CONFIG.cleanMail) await account.cleanMail();
        } catch (error) {
            report(`❌ ${account.name} 出错：${error.message}`);
        }

        if (i < cookies.length - 1 && CONFIG.accountGap > 0) {
            await sleep(CONFIG.accountGap * 1000);
        }
    }

    const summary = accounts.map(account => account.summary()).join('\n\n');
    log(`\n${'─'.repeat(40)}\n${summary}`);

    await notify('HHCLUB 幸运大转盘', [...messages, '', summary].join('\n').trim());
}

main().catch(error => {
    log(`❌ 脚本异常：${error.stack || error.message}`);
    process.exit(1);
});
