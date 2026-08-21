/**
 * HHCLUB 幸运大转盘 · 青龙版
 *
 * new Env('HHCLUB抽奖');
 * cron: 5 9 * * *
 *
 * 用法：把下面「配置区」里的 Cookie 填上就能跑，其余按需改。
 * 也可以在同目录放一个 hh_lottery.config.json 把配置外置 ——
 * 那样更新脚本（直接覆盖）不会把配置冲掉。首次运行会替你生成模板。
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

    /* ⑧ 中了大奖立刻推一条通知（VIP，或单笔憨豆达到下面的门槛）。
          挂机跑一晚上的话，中了大奖当场就能知道 */
    notifyBigPrize: true,

    /* ⑨ 多少憨豆算大奖。填 0 就只有 VIP 才推 */
    bigPrizeMinBeans: 780000,

    /* ⑩ Telegram 直推（可选）。手动停止时优先走它 —— 路径短，
          来得及送出去。留空就不用。

          注意：青龙里已经配了 TG 推送的话这里就别填了，
          青龙的 sendNotify 会推一条，这里再推一条就是重复。
          这两项只认填在这儿的值，不会去读青龙的环境变量。 */
    tgBotToken: '',
    tgUserId: '',
    tgApiHost: 'api.telegram.org',

    /* ⑪ 通用 Webhook（可选）。填个 URL 就会 POST 一份
          {"title":"...","content":"...","text":"标题\n\n正文"} 过去。
          Bark、自建服务、n8n 之类都能接。留空就不用 */
    webhookUrl: '',

    /* ⑫ 日志时间按哪个时区显示。
          青龙容器默认常是 UTC，不设这个的话日志时间对不上 */
    timezone: 'Asia/Shanghai',

    /* ⑬ 站点域名，一般不用改 */
    host: 'hhanclub.net',

    /* ⑭ User-Agent，一般不用改 */
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
};

/* ===== 配置区结束 ===== */

/* 下面这些是内部节奏参数，除非站点风控变了，否则不用碰 */
const RUNTIME = {
    // 连续失败多少次放弃
    maxErrors: 5,
    // 连续被限流多少次放弃
    maxRateLimits: 12,
    // 被限流后的退避
    backoffAfter: 3,
    backoffFactor: 1.5,
    maxBackoffMs: 30000,
    // 读不到站点公布的折算金额时用这个兜底
    vipSwapFallbackBeans: 1000000,
    // 查不到等级时才用余额差兜底判断。容差收得比较紧 ——
    // 松了的话别人赠送一笔魔力就可能被误判成折算
    vipSwapTolerance: 20000,
    // 站内信一次提交多少个 id
    mailChunk: 100,
    // 站内信翻页上限（每页显示多少封是用户自己在站点设置里定的）
    mailMaxPages: 600,
    // 反复清第一页的轮数上限
    mailSweepRounds: 20,
    // 抽奖途中每多少抽顺手清一次（和油猴版的节奏一致）
    mailCleanEveryDraws: 25,
    lotteryMailKeyword: '幸运大转盘',
    // 停止通知最多等多久 —— 卡在推送上不退出更糟
    notifyTimeoutMs: 8000
};

/* 间隔允许填小数，但只认到两位 —— 再细没有意义，
   也免得 0.1+0.2 这类浮点尾巴写进配置里。 */
function normalizeInterval(raw, fallback) {
    const value = typeof raw === 'number' ? raw : parseFloat(raw);
    const seconds = Number.isFinite(value) ? value : fallback;
    return Math.min(300, Math.max(3, Math.round(seconds * 100) / 100));
}

/* 3 → 「3」，3.5 → 「3.5」，3.25 → 「3.25」；不留没用的 0 */
function intervalText(seconds) {
    return String(Math.round(seconds * 100) / 100);
}

/* 配置是手填的，收一遍边界，免得填了个负数或者字符串就跑出怪结果 */
function normalizeConfig() {
    const int = (value, fallback, min) => {
        const number = parseInt(value, 10);
        return Number.isFinite(number) ? Math.max(min, number) : fallback;
    };

    CONFIG.draws = int(CONFIG.draws, 10, 0);
    CONFIG.reserve = int(CONFIG.reserve, 0, 0);
    CONFIG.interval = normalizeInterval(CONFIG.interval, 8);
    CONFIG.maxMinutes = int(CONFIG.maxMinutes, 60, 1);
    CONFIG.cleanMail = CONFIG.cleanMail === true;
    CONFIG.notifyBigPrize = CONFIG.notifyBigPrize !== false;
    CONFIG.bigPrizeMinBeans = int(CONFIG.bigPrizeMinBeans, 780000, 0);
    // 只认填在这里的，不去读 TG_BOT_TOKEN / TG_USER_ID 环境变量 ——
    // 那两个是青龙给 sendNotify 用的，青龙自己已经会往 TG 推一条了，
    // 再拿来直连就成了同一条消息推两遍。
    CONFIG.tgBotToken = String(CONFIG.tgBotToken || '').trim();
    CONFIG.tgUserId = String(CONFIG.tgUserId || '').trim();
    CONFIG.tgApiHost = String(CONFIG.tgApiHost || 'api.telegram.org').trim()
        .replace(/^https?:\/\//, '').replace(/\/+$/, '');
    CONFIG.webhookUrl = String(CONFIG.webhookUrl || '').trim();
    CONFIG.host = String(CONFIG.host || 'hhanclub.net').trim().replace(/\/+$/, '');
    CONFIG.statsFile = String(CONFIG.statsFile || '').trim();
    CONFIG.timezone = String(CONFIG.timezone || '').trim();
}

/* 外置配置文件。有它就以它为准 ——
   这样 curl 覆盖脚本更新时，配置不会跟着被冲掉。 */
const CONFIG_FILE = 'hh_lottery.config.json';

function configPath() {
    return path.join(__dirname, CONFIG_FILE);
}

/* 返回实际生效的配置文件路径；没有 / 读不出来返回空字符串 */
function loadExternalConfig() {
    const file = configPath();
    if (!fs.existsSync(file)) return '';

    let data;
    try {
        data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        log(`⚠️ ${CONFIG_FILE} 不是合法 JSON（${error?.message || error}），改用脚本里的配置`);
        return '';
    }
    if (!data || typeof data !== 'object') return '';

    const unknown = [];
    Object.entries(data).forEach(([key, value]) => {
        if (key === '//') return;
        if (Object.prototype.hasOwnProperty.call(CONFIG, key)) CONFIG[key] = value;
        else unknown.push(key);
    });
    if (unknown.length) log(`⚠️ ${CONFIG_FILE} 里有认不出的项，已忽略：${unknown.join(', ')}`);

    const added = backfillConfigFile(file, data);
    if (added.length) {
        log(`📝 ${CONFIG_FILE} 补上了新版本才有的项：${added.join(', ')}`);
        log('   值就是当前生效的默认值，行为没变 —— 要用的话去文件里改');
    }

    return file;
}

/* 配置文件是老版本生成的话，后来新加的项它不会有 —— 不主动去翻 README
   就永远不知道有这些开关（tgBotToken 这些就是这么被漏掉的）。
   这里按当前生效的值补进去：行为一点不变，只是让人看得见。
   用户自己写的、认不出的项原样留着，不动。 */
function backfillConfigFile(file, data) {
    const missing = Object.keys(CONFIG)
        .filter(key => !Object.prototype.hasOwnProperty.call(data, key));
    if (!missing.length) return [];

    const merged = { ...data };
    missing.forEach(key => { merged[key] = CONFIG[key]; });

    try {
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(merged, null, 4));
        fs.renameSync(tmp, file);
        return missing;
    } catch (error) {
        // 只读挂载之类的，补不上就算了，不该因此跑不了
        return [];
    }
}

function writeConfigTemplate() {
    const file = configPath();
    const template = {
        '//': '配置放这里，更新脚本时不会被覆盖。各项含义见 qinglong/README.md',
        ...CONFIG
    };
    // 已经有了就别动，免得把用户改过的覆盖回去
    if (fs.existsSync(file)) return '';

    try {
        fs.writeFileSync(file, JSON.stringify(template, null, 4));
        return file;
    } catch (error) {
        return '';
    }
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
   所以按 CONFIG.timezone 显示；时区名写错就退回 ISO。

   自己拼而不是直接用 toLocaleString 的返回值 —— 那个的分隔符跟平台的
   ICU 版本走：Windows 上是「08/19 09:05:01」，Linux 上会变成
   「08/21, 10:30:27」，多个逗号。日志格式不该看跑在哪台机器上。 */
function stamp() {
    const now = new Date();
    try {
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: CONFIG.timezone || undefined,
            hourCycle: 'h23',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        }).formatToParts(now).reduce((acc, part) => {
            acc[part.type] = part.value;
            return acc;
        }, {});

        return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
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
    return number.toLocaleString('en-US', { maximumFractionDigits: 2 });
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
    beans: { name: '憨豆', icon: '💰', unit: '' },
    magic: { name: '憨豆（旧魔力）', icon: '💰', unit: '' },
    invite: { name: '邀请', icon: '📧', unit: '' },
    rainbow: { name: '彩虹ID', icon: '🌈', unit: '天' },
    vip: { name: 'VIP', icon: '⭐', unit: '天' },
    makeup: { name: '补签卡', icon: '🎫', unit: '个' },
    upload: { name: '上传量', icon: '⬆️', unit: 'GB' },
    rename: { name: '改名卡', icon: '📛', unit: '张' },
    unknown: { name: '其他奖品', icon: '🎁', unit: '' }
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

/* 收件箱里只有主题带这几个字的会被删。同一个收件箱里还混着
   「种子被删除」「憨豆 改变」这类真要看的通知，宁可漏删也不能误删。 */
const isLotteryMail = item => item.subject.includes(RUNTIME.lotteryMailKeyword);

/* 折算金额是站点明文印在抽奖页上的：
     「当中奖 [VIP] 时，如果用户已经是 VIP 或以上等级，奖励憨豆： 1000000」
   必须读它，不能拿余额差当金额 —— 憨豆还会因为做种持续增长，
   两次读数之间涨的那几十点会被当成中奖收入记进去
   （线上真出现过「1,000,060 憨豆」这种不存在的档位）。 */
function parseVipSwapBeansFrom(html) {
    const text = String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    const match = text.match(/当中奖\s*\[?\s*VIP\s*\]?[^当]{0,80}?奖励憨豆[：:]\s*([\d,]+)/i);
    if (!match) return 0;

    const value = Number(match[1].replace(/,/g, ''));
    return Number.isFinite(value) && value > 0 ? value : 0;
}

/* 「VIP 或以上等级」说的是 NexusPHP 的 class。站点可以把等级名字改得
   面目全非（本站叫「俺不中类」），但等级图标用的还是标准文件名，
   所以按图标判。只要判出 class ≥ VIP，折算与否就是确定的事实，
   不用再去猜余额 —— 别人赠送魔力、做种收益统统影响不到。 */
const CLASS_RANK = {
    user: 1, power: 2, elite: 3, crazy: 4, insane: 5, veteran: 6,
    extreme: 7, ultimate: 8, nexusmaster: 9, vip: 10, retiree: 11,
    uploader: 12, moderator: 13, coadministrator: 14,
    administrator: 15, sysop: 16, staffleader: 17
};

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

/* 所有类别里被折算成憨豆的总额。目前只有 VIP 会产生，
   写成通用的，以后站点再加别的折算规则不用改这里。 */
function swappedBeansTotal(stats) {
    return Object.values(stats.prizes)
        .reduce((sum, bucket) => sum + (Number(bucket.swappedBeans) || 0), 0);
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
        report(`⚠️ 统计文件读不出来（${error?.message || error}），这次从零开始记`);
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

        // 先写临时文件再改名。直接往目标文件写的话，写到一半断电 / 被 SIGKILL
        // 就会留下半截 JSON，下次读不出来 —— 攒了几千抽的统计不能这么丢
        const temp = `${file}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(payload, null, 2));
        fs.renameSync(temp, file);

        return file;
    } catch (error) {
        report(`⚠️ 统计写不进去（${error?.message || error}）`);
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

        // 站点公布的折算金额，开跑时从抽奖页读
        this.vipSwapBeans = 0;
        // true = 是 VIP 或以上，false = 不是，null = 没查出来
        this.vipOrAbove = null;
        this.vipClassChecked = false;

        this.mailCleaned = 0;
        this.startedAt = Date.now();

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

        // 折算金额和单抽消耗一样是站点随时能改的，顺手刷新
        const swapBeans = parseVipSwapBeansFrom(html);
        if (swapBeans > 0) this.vipSwapBeans = swapBeans;

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
    readVipSwapBeans() {
        return this.vipSwapBeans || RUNTIME.vipSwapFallbackBeans;
    }

    async fetchSelfUserId() {
        const match = (await this.get('/usercp.php')).match(/userdetails\.php\?id=(\d+)/);
        return match ? match[1] : null;
    }

    /* 查一次就记住。读不到返回 null —— 「没查出来」和「不是 VIP」
       得分开，前者要退回余额差兜底，后者直接就能定。 */
    async checkVipOrAbove() {
        if (this.vipClassChecked) return this.vipOrAbove;

        try {
            const id = await this.fetchSelfUserId();
            if (!id) return null;

            const html = await this.get(`/userdetails.php?id=${id}`);
            const match = html.match(/等级[：:][\s\S]{0,300}?pic\/(\w+)\.(?:gif|png|svg|webp)/i);
            if (!match) return null;

            const rank = CLASS_RANK[match[1].toLowerCase()];
            if (!rank) return null;

            this.vipOrAbove = rank >= CLASS_RANK.vip;
            // 只在真查出来时才记住。查失败（网络抖一下、502）就别记 ——
            // 记了的话整个进程都不会再试，后面再中 VIP 只能退回余额差去猜。
            this.vipClassChecked = true;
            return this.vipOrAbove;
        } catch (error) {
            return null;
        }
    }

    async reconcileVip(prize) {
        const estimated = this.balance;

        let actual;
        try {
            actual = (await this.snapshot()).balance;
        } catch (error) {
            // 这里悄悄放过去最要命：VIP 五千抽才碰一次，漏一次就是一百万
            report('⚠️ 中了 VIP 但余额没核成 —— 你若本来就是 VIP，这一注的憨豆没记上');
            return;
        }

        const drift = actual - estimated;
        this.balance = actual;

        const beans = this.readVipSwapBeans();

        // 先按等级判 —— 这是确定的事实，不受赠送魔力 / 做种收益干扰
        const eligible = await this.checkVipOrAbove();

        if (eligible === false) return;                 // 不是 VIP，真拿到了天数
        if (eligible === null) {
            // 等级读不到才退回余额差，而且要求落在公布金额附近的窄带里。
            // 放宽的话，抽奖期间有人赠送一笔魔力就会被误判成折算。
            if (Math.abs(drift - beans) > RUNTIME.vipSwapTolerance) {
                if (drift > RUNTIME.vipSwapTolerance) {
                    report(`⚠️ 中了 VIP 且余额变动 ${drift > 0 ? '+' : ''}${fmt(Math.round(drift))}，`
                        + '但读不到你的等级，无法确认是否折算 —— 这一注按 VIP 记');
                }
                return;
            }
        }

        // 金额一律按站点公布的来。drift 里混着做种收益、赠送、别的标签页的
        // 开销，当金额用会记出「1,000,060 憨豆」这种奖池里根本没有的档位。
        markVipSwapped(this.current, prize, beans);
        markVipSwapped(this.total, prize, beans);

        report(`👑 你已经是 VIP，站点改发了 ${fmt(beans)} 憨豆 · 仍计为一次 VIP 中奖`);

        const extra = Math.round(drift - beans);
        if (Math.abs(extra) >= 1) {
            report(`ℹ️ 同期余额另有 ${extra > 0 ? '+' : ''}${fmt(extra)}（做种收益 / 赠送等），未计入中奖`);
        }
    }

    /* 说多久就是多久 —— 以前会在设定值上下浮动 15%，
       填 3 秒实际可能跑成 2.55 或 3.45 秒，对不上账。 */
    /* 挂机跑一晚上，中了大奖当场推一条 —— 不然要等跑完才知道。
       口径和油猴版的全屏庆祝一致：VIP，或单笔憨豆到门槛。
       推送失败不能影响抽奖，吞掉就是了。 */
    async pushBigPrize(prize, prizeText) {
        if (!CONFIG.notifyBigPrize) return;

        const big = prize.type === 'vip'
            || (CONFIG.bigPrizeMinBeans > 0
                && prize.type === 'beans'
                && prize.value >= CONFIG.bigPrizeMinBeans);
        if (!big) return;

        const body = [
            `第 ${fmt(this.current.draws)} 抽中了：${String(prizeText).trim()}`,
            `当前余额 ${fmt(this.balance)} 憨豆`,
            `已跑 ${formatDuration(Date.now() - this.startedAt)}`
        ].join('\n');

        try {
            await notify('👑 HHCLUB 幸运大转盘 · 中大奖了', body);
        } catch (error) {
            log(`⚠️ 大奖通知发送失败：${error?.message || error}`);
        }
    }

    nextDelay() {
        return Math.max(1000, Math.round(this.intervalMs));
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
                await this.pushBigPrize(prize, prizeText);

                // 和油猴版一个节奏：每 25 抽顺手清一次。挂机跑几百抽的话，
                // 收件箱整场都在涨，等到最后才清没道理
                if (CONFIG.cleanMail
                    && this.current.draws % RUNTIME.mailCleanEveryDraws === 0) {
                    await this.sweepDuringRun();
                }
                continue;
            }

            const msg = decodeUnicode(result.data.msg || '未知错误');

            if (msg.includes('重复点击') || msg.includes('请稍后') || msg.includes('频繁')) {
                this.rateLimitStreak++;
                log(`⏳ ${msg}`);

                if (this.rateLimitStreak >= RUNTIME.backoffAfter) {
                    this.intervalMs = Math.min(this.intervalMs * RUNTIME.backoffFactor, RUNTIME.maxBackoffMs);
                    log(`🔄 间隔上调到 ${intervalText(this.intervalMs / 1000)} 秒`);
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

    /* 反复清第一页，直到第一页不再有抽奖通知。
       新信都排在最前面，所以抽奖途中用这个就够，一次请求的事。
       一页可能只有 10 封，清一次远不够，所以要循环。 */
    async sweepFirstPage() {
        let removed = 0;

        for (let round = 0; round < RUNTIME.mailSweepRounds; round++) {
            const { items } = await this.mailPage(0);
            const ids = items.filter(isLotteryMail).map(item => item.id);
            if (!ids.length) break;
            removed += await this.deleteMail(ids);
        }

        return removed;
    }

    /* 抽奖途中顺手清。清信失败不该把抽奖带停，记一行就算了。 */
    async sweepDuringRun() {
        try {
            const removed = await this.sweepFirstPage();
            if (!removed) return;

            this.mailCleaned += removed;
            log(`📪 清掉 ${fmt(removed)} 封抽奖通知 · 本次累计 ${fmt(this.mailCleaned)} 封`);
        } catch (error) {
            log(`⚠️ 站内信清理失败：${error?.message || error}`);
        }
    }

    /* 收尾时翻一遍整个收件箱。

       途中那种只扫第一页的清法会漏：要是第一页被「种子被删除」这类
       通知占满了，埋在下面的抽奖通知就够不着。翻全本才收得干净。 */
    async cleanMailbox() {
        let removed = 0;

        try {
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
                    if (isLotteryMail(item)) doomed.push(item.id);
                });

                // 下拉框读不到页数时退回长度判断，以第一页的条数为准
                if (first.pageCount <= 0 && items.length < first.items.length) break;
            }

            if (doomed.length) removed += await this.deleteMail(doomed);

            // 扫描到删完这几秒里可能又进了新通知，补扫第一页收尾
            removed += await this.sweepFirstPage();
        } catch (error) {
            report(`⚠️ 站内信清理失败：${error?.message || error}`);
            return;
        }

        this.mailCleaned += removed;
        if (this.mailCleaned) report(`📪 本次共清掉 ${fmt(this.mailCleaned)} 封抽奖通知`);
    }

    /* ---------------- 汇总 ---------------- */

    /* 档位得挂在类别下面。之前把所有档位拍平成一串，出来就是
       「7 天 × 1」「1 个 × 2」—— 根本看不出是彩虹 ID 还是补签卡。 */
    summarize(stats, title) {
        if (!stats.draws) return `${title}：一抽未成`;

        const beans = stats.gains.beans || 0;
        const profit = beans - stats.cost;
        const rate = stats.cost > 0 ? (profit / stats.cost) * 100 : 0;

        const detail = Object.entries(stats.prizes)
            .filter(([, bucket]) => bucket.count > 0)
            .sort((a, b) => b[1].count - a[1].count)
            .flatMap(([type, bucket]) => {
                const meta = PRIZE_META[type] || PRIZE_META.unknown;

                // 累计可能有两截：本类别自己的单位一截，被折算成憨豆的另算
                const sums = [];
                if (bucket.value > 0) {
                    sums.push(`${fmt(bucket.value)}${meta.unit ? ' ' + meta.unit : ''}`);
                }
                if (bucket.swappedBeans > 0) {
                    sums.push(`另折算 ${fmt(bucket.swappedBeans)} 憨豆`);
                }

                const head = `  ${meta.icon} ${meta.name} ${fmt(bucket.count)} 次`
                    + (sums.length ? ` · ${sums.join(' · ')}` : '');

                const tiers = Object.entries(bucket.tiers)
                    .sort((a, b) => b[1] - a[1])
                    .map(([label, count]) => `      ${label} × ${count}`);

                return [head, ...tiers];
            });

        // 折算来的憨豆不在憨豆档位里，不点这一句的话，拿各档位乘开
        // 去对「获得憨豆」会差出一大截，看着像 bug
        const swapped = swappedBeansTotal(stats);
        const beansLine = `  消耗 ${fmt(stats.cost)} · 获得 ${fmt(beans)} 憨豆`
            + (swapped > 0 ? `（其中 ${fmt(swapped)} 来自 VIP 折算）` : '');

        return [
            `${title}：${fmt(stats.draws)} 抽`,
            beansLine,
            `  盈亏 ${profit >= 0 ? '+' : ''}${fmt(profit)}（${rate >= 0 ? '+' : ''}${rate.toFixed(1)}%）`,
            ...detail
        ].join('\n');
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

/* sendNotify 在不同青龙版本 / 不同装法下位置差挺多，挨个试。
   自己下下来在 Debian 上跑的话一个都找不到，那就走 Telegram 兜底。 */
const NOTIFY_PATHS = [
    // 新版青龙自己 preload 进来的通知模块，签名是 sendNotify(text, desp)。
    // 放第一个：/ql/data/scripts 下经常躺着别的脚本留下的 sendNotify.js，
    // 依赖没装的话 require 会直接抛（实机上就是 Cannot find module 'got'）
    '/ql/shell/preload/__ql_notify__.js',
    path.join(__dirname, 'sendNotify.js'),
    path.join(__dirname, 'sendNotify'),
    path.join(__dirname, '..', 'sendNotify.js'),
    path.join(__dirname, '..', 'sendNotify'),
    path.join(process.cwd(), 'sendNotify.js'),
    path.join(process.cwd(), 'sendNotify'),
    '/ql/data/scripts/sendNotify.js',
    '/ql/data/scripts/sendNotify',
    '/ql/scripts/sendNotify.js',
    '/ql/scripts/sendNotify',
    '/ql/shell/sendNotify.js',
    '/ql/shell/sendNotify'
];

function loadNotifyModule() {
    for (const modulePath of NOTIFY_PATHS) {
        try {
            const sender = require(modulePath);
            const send = sender?.sendNotify || sender;
            if (typeof send === 'function') return send;
        } catch (error) {
            // 这个路径没有、或者它自己的依赖缺了，换下一个
        }
    }

    // 都不行的话看看青龙注入的全局 API
    const api = globalThis.QLAPI;
    if (api && typeof api.systemNotify === 'function') {
        return (title, content) => api.systemNotify({ title, content });
    }

    return null;
}

/* Telegram 直推。青龙的 sendNotify 找不到 / 发失败时兜底，
   手动停止时也优先走它 —— 少绕一圈，来得及送出去。 */
async function sendTelegramDirect(title, content) {
    if (!CONFIG.tgBotToken || !CONFIG.tgUserId) return false;

    try {
        const response = await fetch(`https://${CONFIG.tgApiHost}/bot${CONFIG.tgBotToken}/sendMessage`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                chat_id: CONFIG.tgUserId,
                text: `${title}\n\n${content}`,
                disable_web_page_preview: true
            })
        });
        if (!response.ok) {
            log(`⚠️ Telegram 推送失败（HTTP ${response.status}）`);
            return false;
        }
        return true;
    } catch (error) {
        log(`⚠️ Telegram 推送异常：${error?.message || error}`);
        return false;
    }
}

/* 通用 Webhook。不在青龙里跑、又不想配 Telegram 的话走这个 ——
   Bark、自建服务、n8n 之类都能接。 */
async function sendWebhook(title, content) {
    if (!CONFIG.webhookUrl) return false;

    try {
        const response = await fetch(CONFIG.webhookUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title, content, text: `${title}\n\n${content}` })
        });
        if (!response.ok) {
            log(`⚠️ Webhook 推送失败（HTTP ${response.status}）`);
            return false;
        }
        return true;
    } catch (error) {
        log(`⚠️ Webhook 推送异常：${error?.message || error}`);
        return false;
    }
}

/* 返回是否真送出去了。preferTelegram 用于手动停止那条路径。

   渠道是「谁行谁上」而不是只挑一个：青龙里有 sendNotify 就用它，
   自己在 Debian / NAS 上跑没有那个模块，就走 Telegram / Webhook。 */
async function notify(title, content, { preferTelegram = false } = {}) {
    // 青龙内置的 notify 默认会去请求「一言」，在正文末尾追加一句随机标语，
    // 还得多等一次外部请求。临时关掉，跑完还原，不动用户的全局设置。
    const hadHitokoto = Object.prototype.hasOwnProperty.call(process.env, 'HITOKOTO');
    const originalHitokoto = process.env.HITOKOTO;
    process.env.HITOKOTO = 'false';

    try {
        const done = [];
        let telegramSent = false;

        // 手动停止时先走 Telegram：路径最短，来得及送出去
        if (preferTelegram && CONFIG.tgBotToken && CONFIG.tgUserId) {
            telegramSent = await sendTelegramDirect(title, content);
            done.push(`Telegram ${telegramSent ? '✓' : '✗'}`);
        }

        // 青龙的 sendNotify：一个渠道都没配的时候它也不会报错、也不返回状态，
        // 所以这里只能说「调用了」，不能当成「送达了」—— 实测遇到过日志写着
        // 通知已发出、实际什么都没收到。
        const send = loadNotifyModule();
        if (send) {
            try {
                await send(title, content);
                done.push('青龙 sendNotify（已调用，送达与否取决于你在青龙里配了哪些渠道）');
            } catch (error) {
                log(`⚠️ sendNotify 发送失败：${error?.message || error}`);
            }
        }

        // 自己配在这个脚本里的渠道一律照发 —— 配了就是想用，
        // 不能因为 sendNotify 没报错就跳过。不想重复推的话别两边都配。
        if (!telegramSent && CONFIG.tgBotToken && CONFIG.tgUserId) {
            done.push(`Telegram ${await sendTelegramDirect(title, content) ? '✓' : '✗'}`);
        }
        if (CONFIG.webhookUrl) {
            done.push(`Webhook ${await sendWebhook(title, content) ? '✓' : '✗'}`);
        }

        if (done.length) log(`📤 通知：${done.join(' · ')}`);
        return done.length > 0;
    } finally {
        if (hadHitokoto) process.env.HITOKOTO = originalHitokoto;
        else delete process.env.HITOKOTO;
    }
}

function formatDuration(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;

    if (hours) return `${hours} 小时 ${minutes} 分`;
    if (minutes) return `${minutes} 分 ${seconds} 秒`;
    return `${seconds} 秒`;
}

/* 直接在终端跑的时候 Ctrl-C 很常见，抽到一半的成绩不能就这么没了。
   青龙里点「停止」发的是 SIGTERM，同样要接住。 */
function guardExit(lottery) {
    let stopping = null;

    const handleExit = signal => {
        // 连着来两个信号就别重复跑一遍保存和推送了
        if (stopping) return stopping;

        stopping = (async () => {
            const reason = `收到 ${signal}，手动停止`;
            log(`⚠️ ${reason} —— 先保存再退出`);

            if (lottery.current.draws > 0) {
                const file = saveStats(lottery.current, lottery.total);
                if (file) log(`💾 统计已存到 ${file}`);
            }

            const summary = lottery.summary();
            raw(`\n${'─'.repeat(40)}\n${summary}`);

            // 推送卡住的话宁可不推也要退出去，不能挂在这儿
            const watchdog = setTimeout(() => {
                log('⚠️ 停止通知等太久了，不等了，数据已经存好');
                process.exit(130);
            }, RUNTIME.notifyTimeoutMs);

            try {
                const body = [
                    reason,
                    `已跑 ${formatDuration(Date.now() - lottery.startedAt)}`,
                    '',
                    summary
                ].join('\n');

                const sent = await notify('🛑 HHCLUB 幸运大转盘 · 手动停止', body, { preferTelegram: true });
                if (!sent) log('ℹ️ 没有可用的通知渠道，数据已存好，直接退出');
            } catch (error) {
                log(`⚠️ 停止通知发送异常：${error?.message || error}`);
            } finally {
                clearTimeout(watchdog);
            }

            process.exit(130);
        })();

        return stopping;
    };

    // 青龙通过 NODE_OPTIONS 预加载自己的脚本，会比业务脚本更早注册 SIGTERM，
    // 里面直接 process.exit()。EventEmitter 按注册顺序调，不把它摘掉的话
    // 上面那些保存和推送根本轮不到执行 —— 点一下「停止」成绩就没了。
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const inherited = signals.reduce((sum, signal) => sum + process.listenerCount(signal), 0);
    signals.forEach(signal => process.removeAllListeners(signal));

    // 不能用 once：青龙的 task.sh 可能连着转发好几个同类信号
    signals.forEach(signal => process.on(signal, () => { handleExit(signal); }));

    if (inherited > 0) log(`🛡️ 已接管退出信号（替换了 ${inherited} 个预注册的立即退出处理器）`);
}

async function main() {
    if (typeof fetch !== 'function') {
        log('❌ 需要 Node 18 或更高版本（脚本用的是内置 fetch）');
        process.exit(1);
    }

    const configFile = loadExternalConfig();
    normalizeConfig();

    const cookie = readCookie();
    if (!cookie) {
        if (!configFile) {
            const created = writeConfigTemplate();
            if (created) {
                log(`📝 已生成配置文件 ${created}`);
                log('   把里面的 cookie 换成你的，再跑一次就行 —— 以后更新脚本不会覆盖它');
            }
        }
        log('❌ 还没填 Cookie：');
        log('   浏览器登录 hhanclub.net → F12 → Network → 任意请求 → 请求头里的 Cookie 整行复制');
        log(configFile
            ? `   填到 ${configFile} 的 cookie 里`
            : '   填到脚本最上面「配置区」的 cookie 里');
        process.exit(1);
    }

    log('🎡 HHCLUB 幸运大转盘');
    if (configFile) {
        log(`⚙️ 配置来自 ${configFile}`);
    } else {
        // 老用户的设置是直接写在脚本里的，更新脚本（ql raw / curl 覆盖）
        // 就全丢了。头一次跑先把当前生效的设置固化成配置文件 ——
        // 之后再覆盖脚本，设置照样在。
        const created = writeConfigTemplate();
        if (created) {
            log(`📝 已把当前设置存成 ${created}`);
            log('   以后更新脚本直接覆盖就行，设置不会丢；要改设置改这个文件');
        }
    }
    log(CONFIG.draws > 0
        ? `   抽 ${CONFIG.draws} 次 · 间隔 ${intervalText(CONFIG.interval)} 秒`
        : `   一抽到底 · 保留 ${fmt(CONFIG.reserve)} 憨豆 · 间隔 ${intervalText(CONFIG.interval)} 秒`);

    const lottery = new Lottery(cookie);
    guardExit(lottery);

    try {
        await lottery.run();
    } catch (error) {
        report(`❌ ${error?.message || error}`);
    }

    // 成绩先落盘再干别的。清信可能要上百个请求，卡在那儿被 kill 的话，
    // 这一轮抽到的就全没了
    if (lottery.current.draws > 0) {
        const file = saveStats(lottery.current, lottery.total);
        if (file) report(`💾 统计已存到 ${file}（可直接在油猴面板里「导入备份」）`);
    }

    if (CONFIG.cleanMail) {
        try {
            await lottery.cleanMailbox();
        } catch (error) {
            report(`⚠️ 站内信清理失败：${error?.message || error}`);
        }
    }

    const summary = lottery.summary();
    raw(`\n${'─'.repeat(40)}\n${summary}`);

    const body = [
        ...messages,
        '',
        `本次运行 ${formatDuration(Date.now() - lottery.startedAt)}`,
        '',
        summary
    ].join('\n').trim();

    const sent = await notify('🎡 HHCLUB 幸运大转盘', body);
    if (!sent) log('ℹ️ 没有可用的通知渠道，本次只写了日志');
}

main().catch(error => {
    log(`❌ 脚本异常：${error?.stack || error?.message || error}`);
    process.exit(1);
});
