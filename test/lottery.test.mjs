/**
 * HHCLUB 自动抽奖 · 情绪价值拉满版 —— 行为测试
 *
 * 在 jsdom 里加载真实脚本，stub 掉抽奖接口，验证：
 *   - 分奖项统计的聚合结果
 *   - v3 历史数据迁移
 *   - 串行抽奖循环 / 退避 / 自动停止
 *
 * 运行：npm test（用的是真实计时器，跑完约 90 秒）
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = fs.readFileSync(path.join(ROOT, 'hhclub-auto-lottery.user.js'), 'utf8');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

function makeDom({ legacy = null, pool = null, useBean = '每次消耗 2,000 憨豆', balance = '1,234,567' } = {}) {
    // pool 传入时按抽奖页真实的内联脚本形状渲染一段 <script>，
    // 让脚本走和线上完全一样的奖池读取路径。
    const poolScript = pool
        ? `<script>
    let imgPath = 'pic/lucky';
    let prizes = ${JSON.stringify(pool)};
    let awards = [];
</script>`
        : '';

    const dom = new JSDOM(`<!doctype html><html><body>
        <div class="use-bean">${useBean}</div>
        <div class="bean-number">${balance}</div>
        ${poolScript}
    </body></html>`, {
        url: 'https://hhanclub.net/lucky.php',
        runScripts: 'outside-only',
        // 不开这个的话 jsdom 的 visibilityState 是 prerender、document.hidden 为 true，
        // 脚本会把中奖动画全部当成「页面在后台」跳过，动画相关断言就全是假阴性。
        pretendToBeVisual: true
    });

    const w = dom.window;
    w.confirm = () => true;
    w.alert = () => {};
    w.URL.createObjectURL = () => 'blob:stub';
    w.URL.revokeObjectURL = () => {};
    if (legacy) w.localStorage.setItem('hhanclub_lottery_stats_v3', JSON.stringify(legacy));
    return dom;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 固定 sleep 会白等一大截 —— 轮询到条件成立就往下走，全套能省一半时间
async function until(fn, timeoutMs = 90000, stepMs = 200) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (fn()) return true;
        await sleep(stepMs);
    }
    return false;
}
const untilStopped = (d, timeoutMs) =>
    until(() => d.getElementById('lottery-status').textContent === '已停止', timeoutMs);

// jsdom 构造完成时 readyState 可能还是 loading，脚本会等 DOMContentLoaded，
// 所以 eval 之后要让出一拍再断言。
async function run(dom) {
    dom.window.eval(SRC);
    await sleep(150);
}

/* ---------------------------------------------------------------- */
console.log('\n[1] 面板与 A1 修复（详细统计容器必须可见）');
{
    const dom = makeDom();
    await run(dom);
    const d = dom.window.document;

    check('面板已创建', !!d.getElementById('lottery-control-panel'));
    check('奖项明细容器存在', !!d.getElementById('detail-list'));

    const list = d.getElementById('detail-list');
    const hidden = list.closest('[style*="display:none"]') || list.closest('[style*="display: none"]');
    check('明细容器没有被 display:none 挡住', !hidden);
    check('空状态提示可见', list.textContent.includes('每个奖项的中奖次数'));
    check('旧的 prize-stats 隐藏容器已移除', !d.getElementById('prize-stats'));
}

/* ---------------------------------------------------------------- */
console.log('\n[2] B4 修复：千分位单次消耗解析');
{
    const dom = makeDom();
    await run(dom);
    const d = dom.window.document;

    check('单次消耗 = 2,000 而不是 2', d.getElementById('single-cost').textContent === '2,000',
        `实际 "${d.getElementById('single-cost').textContent}"`);
    check('余额正确解析千分位', d.getElementById('bean-balance').textContent === '1,234,567',
        `实际 "${d.getElementById('bean-balance').textContent}"`);
    check('可抽次数 = floor(1234567/2000) = 617',
        d.getElementById('max-possible').textContent === '617',
        `实际 "${d.getElementById('max-possible').textContent}"`);
}

/* ---------------------------------------------------------------- */
console.log('\n[3] 分奖项统计聚合（A2 核心）');
{
    const dom = makeDom();
    const w = dom.window;

    // 固定的奖池序列，便于断言
    const prizes = [
        '恭喜获得 500 憨豆', '恭喜获得 500 憨豆', '恭喜获得 1,000 憨豆',
        '恭喜获得 500 憨豆', '恭喜获得 3 天彩虹ID', '恭喜获得 1 个邀请',
        '恭喜获得 1,000 憨豆', '恭喜获得 7 天VIP', '恭喜获得 1 张补签卡',
        '恭喜获得 5GB 上传量'
    ];
    let i = 0;
    let calls = 0;
    w.fetch = async () => {
        calls++;
        const text = prizes[i % prizes.length];
        i++;
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: text, winning_record_id: 1000 + i } })
        };
    };

    await run(dom);
    const d = w.document;

    d.getElementById('lottery-interval').value = '3';
    d.getElementById('max-lottery-count').value = '10';
    d.getElementById('start-lottery').click();

    // 10 抽 × ~3s 间隔（含抖动），留足余量
    await sleep(34000);

    check(`实际发出 10 次请求（发出 ${calls} 次）`, calls === 10);

    const stats = JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4'));
    check('抽奖次数 = 10', stats.draws === 10, `实际 ${stats.draws}`);
    check('累计消耗 = 10 × 2000 = 20000', stats.cost === 20000, `实际 ${stats.cost}`);

    check('憨豆类别中奖 5 次', stats.prizes.beans?.count === 5, `实际 ${stats.prizes.beans?.count}`);
    check('憨豆档位 500 中 3 次', stats.prizes.beans?.tiers['500 憨豆'] === 3,
        JSON.stringify(stats.prizes.beans?.tiers));
    check('憨豆档位 1,000 中 2 次', stats.prizes.beans?.tiers['1,000 憨豆'] === 2,
        JSON.stringify(stats.prizes.beans?.tiers));
    check('憨豆累计数值 = 500*3 + 1000*2 = 3500', stats.gains.beans === 3500, `实际 ${stats.gains.beans}`);

    check('彩虹ID 中 1 次 / 累计 3 天',
        stats.prizes.rainbow?.count === 1 && stats.gains.rainbow === 3);
    check('VIP 中 1 次 / 累计 7 天',
        stats.prizes.vip?.count === 1 && stats.gains.vip === 7);
    check('邀请中 1 次', stats.prizes.invite?.count === 1);
    check('补签卡中 1 次', stats.prizes.makeup?.count === 1);
    check('上传量中 1 次 / 累计 5GB',
        stats.prizes.upload?.count === 1 && stats.gains.upload === 5);

    const typeTotal = Object.values(stats.prizes).reduce((s, b) => s + b.count, 0);
    check('分奖项次数之和 == 抽奖次数', typeTotal === stats.draws, `${typeTotal} vs ${stats.draws}`);

    // UI 断言
    check('面板抽奖次数显示 10', d.getElementById('draw-count').textContent === '10',
        `实际 "${d.getElementById('draw-count').textContent}"`);
    check('面板奖项种类显示 6', d.getElementById('prize-type-count').textContent === '6',
        `实际 "${d.getElementById('prize-type-count').textContent}"`);

    const rows = [...d.querySelectorAll('#detail-list .hh-row')];
    check('明细渲染出 6 行', rows.length === 6, `实际 ${rows.length}`);
    check('第一行是次数最多的憨豆', rows[0]?.dataset.type === 'beans', rows[0]?.dataset.type);
    check('憨豆行显示 "5 次"', rows[0]?.querySelector('.hh-row-count')?.textContent === '5 次',
        rows[0]?.querySelector('.hh-row-count')?.textContent);
    check('憨豆行占比 50.0%', rows[0]?.querySelector('.hh-row-pct')?.textContent === '50.0%',
        rows[0]?.querySelector('.hh-row-pct')?.textContent);
    check('憨豆行展开后有 2 个档位', rows[0]?.querySelectorAll('.hh-tier').length === 2);
    check('明细汇总文案正确',
        d.getElementById('detail-summary').textContent === '共 10 抽 · 6 种',
        d.getElementById('detail-summary').textContent);

    check('盈亏 = 3500 - 20000',
        d.getElementById('profit-loss').textContent === '-16,500',
        d.getElementById('profit-loss').textContent);

    // B1: 串行执行，任意时刻只有一个 in-flight 请求 —— 由 calls===10 且无重复扣豆间接验证
    check('达到最大次数后自动停止', d.getElementById('lottery-status').textContent === '已停止',
        d.getElementById('lottery-status').textContent);
    check('停止后开始按钮恢复可用', d.getElementById('start-lottery').disabled === false);
}

/* ---------------------------------------------------------------- */
console.log('\n[4] A4：v3 历史数据迁移');
{
    const legacy = {
        totalLotteryCount: 100,
        totalWinCount: 100,
        totalCost: 200000,
        totalBeansWon: 45000,
        totalInvites: 2,
        totalRainbowDays: 10,
        totalVipDays: 7,
        totalMakeupCards: 3,
        totalUploadGB: 15,
        totalPrizeStats: {
            '恭喜获得 500 憨豆': 60,
            '恭喜获得 1,000 憨豆': 25,
            '恭喜获得 3 天彩虹ID': 8,
            '恭喜获得 1 个邀请': 2,
            '恭喜获得 7 天VIP': 1,
            '恭喜获得 5GB 上传量': 3,
            '恭喜获得 1 张补签卡': 1
        }
    };
    const dom = makeDom({ legacy });
    await run(dom);
    const w = dom.window, d = w.document;

    const stats = JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4'));
    check('迁移标记正确', stats.migratedFrom === 'v3');
    check('历史抽奖次数保留 100', stats.draws === 100, `实际 ${stats.draws}`);
    check('历史消耗保留 200000', stats.cost === 200000);
    check('历史憨豆保留 45000', stats.gains.beans === 45000);
    check('憨豆按文案重建为 85 次', stats.prizes.beans?.count === 85, `实际 ${stats.prizes.beans?.count}`);
    check('憨豆 500 档位 60 次', stats.prizes.beans?.tiers['500 憨豆'] === 60);
    check('憨豆 1,000 档位 25 次', stats.prizes.beans?.tiers['1,000 憨豆'] === 25);
    check('彩虹重建为 8 次', stats.prizes.rainbow?.count === 8);
    check('原始文案兜底保留', Object.keys(stats.raw).length === 7);

    d.getElementById('view-mode').value = 'total';
    d.getElementById('view-mode').dispatchEvent(new w.Event('change'));
    check('切到历史后抽奖次数显示 100', d.getElementById('draw-count').textContent === '100',
        d.getElementById('draw-count').textContent);
    check('切到历史后明细有 6 行',
        d.querySelectorAll('#detail-list .hh-row').length === 6,
        String(d.querySelectorAll('#detail-list .hh-row').length));
}

/* ---------------------------------------------------------------- */
console.log('\n[5] B5：接口连续失败自动停止');
{
    const dom = makeDom();
    const w = dom.window;
    let calls = 0;
    w.fetch = async () => { calls++; throw new Error('network down'); };

    await run(dom);
    const d = w.document;
    d.getElementById('lottery-interval').value = '3';
    d.getElementById('max-lottery-count').value = '100';
    d.getElementById('start-lottery').click();

    await untilStopped(d);

    check(`连续失败 5 次后停止（发出 ${calls} 次请求）`, calls === 5, `实际 ${calls}`);
    check('状态显示已停止', d.getElementById('lottery-status').textContent === '已停止');
    check('没有把失败计入抽奖次数',
        d.getElementById('draw-count').textContent === '0',
        d.getElementById('draw-count').textContent);
}

/* ---------------------------------------------------------------- */
console.log('\n[6] B3：限流退避后成功能恢复间隔');
{
    const dom = makeDom();
    const w = dom.window;
    let n = 0;
    w.fetch = async () => {
        n++;
        // 前 3 次限流，之后成功
        const body = n <= 3
            ? { ret: 1, msg: '请勿重复点击' }
            : { ret: 0, data: { prize_text: '恭喜获得 500 憨豆' } };
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };

    await run(dom);
    const d = w.document;
    d.getElementById('lottery-interval').value = '3';
    d.getElementById('max-lottery-count').value = '4';
    d.getElementById('start-lottery').click();

    // 等到第 3 次限流触发退避
    await until(() => parseFloat(d.getElementById('current-interval').textContent) > 3);
    const backedOff = parseFloat(d.getElementById('current-interval').textContent);
    check(`限流后间隔被拉长（当前 ${backedOff}s）`, backedOff > 3, `实际 ${backedOff}`);

    // 后续成功会把间隔降回基础值
    await until(() => parseFloat(d.getElementById('current-interval').textContent) === 3);
    const recovered = parseFloat(d.getElementById('current-interval').textContent);
    check(`成功后间隔降回 3s（当前 ${recovered}s）`, recovered === 3, `实际 ${recovered}`);

    // 间隔一恢复就往下走的话，后面几次还没抽 —— 等抽满再断言
    await until(() => d.getElementById('draw-count').textContent === '4');
    check('限流不计入抽奖次数，最终抽了 4 次',
        d.getElementById('draw-count').textContent === '4',
        d.getElementById('draw-count').textContent);
}

/* ---------------------------------------------------------------- */
console.log('\n[7] 停止按钮能立刻中断等待');
{
    const dom = makeDom();
    const w = dom.window;
    let calls = 0;
    w.fetch = async () => {
        calls++;
        return { ok: true, status: 200, text: async () => JSON.stringify({ ret: 0, data: { prize_text: '恭喜获得 500 憨豆' } }) };
    };

    await run(dom);
    const d = w.document;
    d.getElementById('lottery-interval').value = '300';
    d.getElementById('max-lottery-count').value = '100';
    d.getElementById('start-lottery').click();

    await sleep(1500);
    check('已抽第一次', calls === 1, `实际 ${calls}`);

    const t0 = Date.now();
    d.getElementById('stop-lottery').click();
    await sleep(500);
    check(`停止立即生效（耗时 ${Date.now() - t0}ms，没有等满 300s）`,
        d.getElementById('lottery-status').textContent === '已停止');

    await sleep(2000);
    check('停止后不再发请求', calls === 1, `实际 ${calls}`);
}

/* ---------------------------------------------------------------- */
console.log('\n[8] 设置持久化');
{
    const dom = makeDom();
    const w = dom.window;
    await run(dom);
    const d = w.document;

    const input = d.getElementById('lottery-interval');
    input.value = '15';
    input.dispatchEvent(new w.Event('change'));

    const saved = JSON.parse(w.localStorage.getItem('hhanclub_lottery_settings_v1'));
    check('间隔已持久化', saved.interval === 15, JSON.stringify(saved));
}

/* ----------------------------------------------------------------
   以下夹具直接取自 hhanclub.net/lucky.php 的线上真实数据（2026-08）：
   REAL_POOL 是抽奖页内联脚本里的 prizes 数组，REAL_BEANS 来自同期
   最近 500 抽的实际战绩。
   注意 typeText 写的「魔力」就是憨豆：站点奖池里 type 1001 用的是 bean_icon，
   消耗侧也叫憨豆，只是 NexusPHP 的默认叫法没改干净。所以它们必须归到同一类。
------------------------------------------------------------------ */
const REAL_POOL = [
    { typeText: '彩虹 ID', amountText: '7 Day(s)', probability_real: '0.0301' },
    { typeText: '魔力', amountText: '780000 ', probability_real: '0.0011' },
    { typeText: '魔力', amountText: '5000 ', probability_real: '0.1507' },
    { typeText: 'VIP', amountText: '7 Day(s)', probability_real: '0.0002' },
    { typeText: '魔力', amountText: '100 ', probability_real: '0.2261' },
    { typeText: '补签卡', amountText: '1 ', probability_real: '0.0603' },
    { typeText: '魔力', amountText: '2000 ', probability_real: '0.2261' },
    { typeText: '上传量', amountText: '2 GB', probability_real: '0.0603' },
    { typeText: '魔力', amountText: '1000 ', probability_real: '0.2261' },
    { typeText: '上传量', amountText: '5 GB', probability_real: '0.0151' },
    { typeText: '邀请', amountText: '1 ', probability_real: '0.0038' }
];

// 「魔力」档位在最近 500 抽里的憨豆总额，用作 [10] 的盈亏种子数据
const REAL_BEANS = 100 * 122 + 5000 * 67 + 2000 * 136 + 1000 * 100 + 780000 * 2;

/* ---------------------------------------------------------------- */
console.log('\n[9] 线上真实文案的归类与官方爆率对比');
{
    // 奖池每一档各中一次。这样既走完真实的解析路径，又能验证
    // 「奖池文案」和「接口文案」必须归一化成同一个 label —— 对不上号
    // 的话档位行就配不到官方爆率。
    const TEXTS = [
        '魔力 780000 ', '魔力 5000 ', '魔力 100 ', '魔力 2000 ', '魔力 1000 ',
        '上传量 2 GB', '上传量 5 GB', '彩虹 ID 7 Day(s)', 'VIP 7 Day(s)',
        '补签卡 1 ', '邀请 1 '
    ];

    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;

    let i = 0;
    w.fetch = async url => {
        if (String(url).includes('lucky.php')) {
            return { ok: true, status: 200, text: async () => '<html><body></body></html>' };
        }
        const text = TEXTS[i++] ?? TEXTS[TEXTS.length - 1];
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: text } })
        };
    };

    await run(dom);
    const d = w.document;

    check('线上写法「每次消耗憨豆： 2000」解析为 2,000',
        d.getElementById('single-cost').textContent === '2,000',
        d.getElementById('single-cost').textContent);

    d.getElementById('lottery-interval').value = '3';
    d.getElementById('max-lottery-count').value = String(TEXTS.length);
    d.getElementById('start-lottery').click();

    await untilStopped(d);

    const stats = JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4'));
    check(`抽满 ${TEXTS.length} 次`, stats.draws === TEXTS.length, `实际 ${stats.draws}`);
    check('线上 11 种文案没有一种落进「其他奖品」',
        !stats.prizes.unknown, JSON.stringify(stats.prizes.unknown));
    check('没有留下独立的 magic 类别', !stats.prizes.magic, JSON.stringify(stats.prizes.magic));

    check('五档「魔力」全部归到憨豆，共 5 次',
        stats.prizes.beans?.count === 5, `实际 ${stats.prizes.beans?.count}`);
    check('憨豆累计 = 780000+5000+100+2000+1000',
        stats.gains.beans === 788100, `实际 ${stats.gains.beans}`);
    check('上传量 2GB + 5GB = 7GB', stats.gains.upload === 7, `实际 ${stats.gains.upload}`);
    check('彩虹 ID 7 天', stats.gains.rainbow === 7, `实际 ${stats.gains.rainbow}`);
    check('VIP 7 天', stats.gains.vip === 7, `实际 ${stats.gains.vip}`);
    check('补签卡 1 张', stats.prizes.makeup?.count === 1);
    check('邀请 1 个', stats.prizes.invite?.count === 1);

    // 档位 label 必须和奖池对得上，否则这里配不到爆率
    const tierRates = Array.from(d.querySelectorAll('#detail-list .hh-tier-rate'));
    check(`档位行渲染出 ${TEXTS.length} 条爆率对比`,
        tierRates.length === TEXTS.length, `实际 ${tierRates.length}`);
    check('每个档位都配到了官方爆率',
        tierRates.every(el => /官方 \d/.test(el.textContent)),
        tierRates.map(el => el.textContent).join(' | '));

    const official = Array.from(d.querySelectorAll('#detail-list .hh-row-official'));
    check('6 个类别都显示官方爆率', official.length === 6, `实际 ${official.length}`);
    check('憨豆类别官方爆率合并为 83.0%',
        official.some(el => el.textContent === '官方 83.0%'),
        official.map(el => el.textContent).join(' | '));
    check('VIP 类别官方爆率 0.0%（0.02% 四舍五入）',
        official.some(el => el.textContent === '官方 0.0%'),
        official.map(el => el.textContent).join(' | '));
}

/* ---------------------------------------------------------------- */
console.log('\n[10] 憨豆盈亏与理论盈亏率');
{
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;

    // 盈亏只用到 cost 和 gains.beans，直接给一份 500 抽的种子数据，
    // 不必再为了造数据去跑几百次抽奖
    w.localStorage.setItem('hhanclub_lottery_stats_v4', JSON.stringify({
        version: 4, draws: 500, cost: 1000000,
        gains: { beans: REAL_BEANS, magic: 0, invite: 2, rainbow: 63, vip: 0, makeup: 0, upload: 86 },
        prizes: { beans: { count: 427, value: REAL_BEANS, tiers: { '100 憨豆': 122 } } },
        raw: {}
    }));

    await run(dom);
    const d = w.document;

    d.getElementById('view-mode').value = 'total';
    d.getElementById('view-mode').dispatchEvent(new w.Event('change'));
    await sleep(80);

    const profit = REAL_BEANS - 1000000;
    check(`盈亏 = ${REAL_BEANS} - 1,000,000`,
        d.getElementById('profit-loss').textContent === `+${profit.toLocaleString()}`,
        d.getElementById('profit-loss').textContent);

    const rate = (profit / 1000000) * 100;
    check(`实测盈亏率 ${rate.toFixed(1)}%`,
        d.getElementById('profit-rate').textContent === `+${rate.toFixed(1)}%`,
        d.getElementById('profit-rate').textContent);
}

/* ---------------------------------------------------------------- */
console.log('\n[10b] 旧版拆出来的 magic 数据会被合回憨豆');
{
    const dom = makeDom();
    const w = dom.window;
    // 模拟本脚本早期版本存下的 v4 数据：魔力被当成独立奖项
    w.localStorage.setItem('hhanclub_lottery_stats_v4', JSON.stringify({
        version: 4, draws: 3, cost: 6000,
        gains: { beans: 500, magic: 7000, invite: 0, rainbow: 0, vip: 0, makeup: 0, upload: 0 },
        prizes: {
            beans: { count: 1, value: 500, tiers: { '500 憨豆': 1 } },
            magic: { count: 2, value: 7000, tiers: { '5,000 憨豆': 1, '2,000 憨豆': 1 } }
        },
        raw: {}
    }));

    await run(dom);
    const d = w.document;
    d.getElementById('view-mode').value = 'total';
    d.getElementById('view-mode').dispatchEvent(new w.Event('change'));
    await sleep(50);

    check('憨豆累计合并为 7,500',
        d.getElementById('total-beans-won').textContent === '7,500',
        d.getElementById('total-beans-won').textContent);
    check('明细只剩一行憨豆',
        d.querySelectorAll('#detail-list .hh-row').length === 1,
        d.querySelectorAll('#detail-list .hh-row').length);
    check('憨豆合计 3 次',
        d.querySelector('#detail-list .hh-row-count')?.textContent === '3 次',
        d.querySelector('#detail-list .hh-row-count')?.textContent);
    check('三个档位都在',
        d.querySelectorAll('#detail-list .hh-tier').length === 3,
        d.querySelectorAll('#detail-list .hh-tier').length);
    check('盈亏 = 7500 - 6000 = +1,500',
        d.getElementById('profit-loss').textContent === '+1,500',
        d.getElementById('profit-loss').textContent);
}

/* ---------------------------------------------------------------- */
console.log('\n[11] 限流与接口错误分开计数');
{
    const dom = makeDom();
    const w = dom.window;
    let calls = 0;

    // 3 次限流 + 2 次网络错误。旧版两者共用一个计数器，
    // 到第 5 次就会凑够 maxConsecutiveErrors 被误判成接口异常停机。
    w.fetch = async () => {
        calls++;
        if (calls <= 3) {
            return { ok: true, status: 200, text: async () => JSON.stringify({ ret: 1, msg: '请勿重复点击' }) };
        }
        if (calls <= 5) throw new Error('network down');
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: '魔力 100 ' } })
        };
    };

    await run(dom);
    const d = w.document;
    d.getElementById('lottery-interval').value = '3';
    d.getElementById('max-lottery-count').value = '1';
    d.getElementById('start-lottery').click();

    await sleep(60000);

    check(`没有在第 5 次被误停（共发出 ${calls} 次请求）`, calls > 5, `实际 ${calls}`);
    check('最终抽到了奖', Number(d.getElementById('draw-count').textContent) === 1,
        d.getElementById('draw-count').textContent);
    check('「魔力 100」记成 100 憨豆',
        JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4')).gains.beans === 100);
}

/* ---------------------------------------------------------------- */
console.log('\n[12] 余额随抽奖本地扣减（站点不刷新 .bean-number）');
{
    const dom = makeDom();
    const w = dom.window;
    let calls = 0;
    w.fetch = async () => {
        calls++;
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: '魔力 100 ' } })
        };
    };

    await run(dom);
    const d = w.document;

    check('初始余额取自 DOM', d.getElementById('bean-balance').textContent === '1,234,567',
        d.getElementById('bean-balance').textContent);
    check('初始最多可抽 617', d.getElementById('max-possible').textContent === '617',
        d.getElementById('max-possible').textContent);

    d.getElementById('lottery-interval').value = '3';
    d.getElementById('max-lottery-count').value = '3';
    d.getElementById('start-lottery').click();
    await untilStopped(d);

    check(`抽了 3 次（实际 ${calls}）`, calls === 3);
    // 站点从不改这个元素，所以 DOM 里仍是 1,234,567
    check('DOM 里的余额确实没被站点更新',
        d.querySelector('.bean-number').textContent === '1,234,567',
        d.querySelector('.bean-number').textContent);
    // 每抽净变化 = 中的憨豆 − 单抽消耗。这一轮每次中 100 憨豆，所以是 −1,900/抽。
    check('面板余额按「扣消耗 + 中奖回血」结算',
        d.getElementById('bean-balance').textContent === (1234567 - 6000 + 300).toLocaleString(),
        d.getElementById('bean-balance').textContent);
    check('最多可抽随之减少到 614',
        d.getElementById('max-possible').textContent === '614',
        d.getElementById('max-possible').textContent);

    // 页面自己把余额改了（比如刷新后），应当重新采信 DOM
    d.querySelector('.bean-number').textContent = '900000.0';
    d.getElementById('view-mode').dispatchEvent(new w.Event('change'));
    await sleep(50);
    d.getElementById('set-max-possible').click();
    check('DOM 值变化后重新采信',
        d.getElementById('bean-balance').textContent === '900,000',
        d.getElementById('bean-balance').textContent);
}

/* ---------------------------------------------------------------- */
console.log('\n[13] 大奖全屏庆祝');
{
    // 按官方爆率判定：VIP 0.02% 和 780,000 憨豆 0.11% 够格，
    // 邀请 0.38% 和 5,000 憨豆 15.07% 不够格。
    const cases = [
        { text: '魔力 780000 ', jackpot: true, why: '780,000 憨豆（0.11%）' },
        { text: 'VIP 7 Day(s)', jackpot: true, why: 'VIP（0.02%）' },
        { text: '邀请 1 ', jackpot: false, why: '邀请（0.38%）' },
        { text: '魔力 5000 ', jackpot: false, why: '5,000 憨豆（15.07%）' }
    ];

    for (const item of cases) {
        const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
        const w = dom.window;
        w.fetch = async () => ({
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: item.text } })
        });

        await run(dom);
        const d = w.document;
        d.getElementById('lottery-interval').value = '3';
        d.getElementById('max-lottery-count').value = '1';
        d.getElementById('start-lottery').click();
        await sleep(1200);

        const jackpotShown = !!d.querySelector('.hh-jackpot-overlay');
        const normalShown = !!d.querySelector('.hh-win-overlay');

        check(`${item.why} → ${item.jackpot ? '全屏庆祝' : '普通动画'}`,
            jackpotShown === item.jackpot && normalShown === !item.jackpot,
            `jackpot=${jackpotShown} normal=${normalShown}`);

        if (item.jackpot) {
            check(`  ${item.why} 面板上打了大奖日志`,
                Array.from(d.querySelectorAll('#lottery-log div'))
                    .some(el => el.textContent.includes('大奖')),
                '未找到大奖日志');
            check(`  ${item.why} 遮罩里带奖品文案`,
                d.querySelector('.hh-jackpot-prize')?.textContent.includes(item.text.trim()),
                d.querySelector('.hh-jackpot-prize')?.textContent);
            check(`  ${item.why} 礼花已生成`,
                d.querySelectorAll('.hh-firework').length > 0,
                d.querySelectorAll('.hh-firework').length);
        }
    }
}

/* ---------------------------------------------------------------- */
console.log('\n[14] 读不到奖池时大奖判定退回硬规则');
{
    // 没有 pool script，isJackpot 走 VIP / 十万憨豆 的兜底分支
    const dom = makeDom();
    const w = dom.window;
    w.fetch = async () => ({
        ok: true, status: 200,
        text: async () => JSON.stringify({ ret: 0, data: { prize_text: '魔力 780000 ' } })
    });

    await run(dom);
    const d = w.document;
    d.getElementById('lottery-interval').value = '3';
    d.getElementById('max-lottery-count').value = '1';
    d.getElementById('start-lottery').click();
    await sleep(1200);

    check('无奖池时 780,000 憨豆仍判为大奖',
        !!d.querySelector('.hh-jackpot-overlay'), '未触发');
    check('无奖池时不渲染官方爆率',
        d.querySelectorAll('#detail-list .hh-row-official').length === 0,
        d.querySelectorAll('#detail-list .hh-row-official').length);
}

/* ---------------------------------------------------------------- */
console.log('\n[15] 关掉中奖动画后大奖也不弹');
{
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;
    w.fetch = async () => ({
        ok: true, status: 200,
        text: async () => JSON.stringify({ ret: 0, data: { prize_text: '魔力 780000 ' } })
    });

    await run(dom);
    const d = w.document;
    d.getElementById('toggle-animation').click();

    d.getElementById('lottery-interval').value = '3';
    d.getElementById('max-lottery-count').value = '1';
    d.getElementById('start-lottery').click();
    await sleep(1200);

    check('动画关闭时没有全屏遮罩', !d.querySelector('.hh-jackpot-overlay'));
    check('但仍然记进了统计',
        d.getElementById('draw-count').textContent === '1',
        d.getElementById('draw-count').textContent);
    check('也仍然打了大奖日志',
        Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('大奖')),
        '未找到大奖日志');
}

/* ---------------------------------------------------------------- */
console.log('\n[16] 一抽到底');
{
    // 余额 20,000、单抽 2,000、保留 6,000，每次都中 100 憨豆（几乎不回血）
    // → 大约抽到余额剩 6,000 出头就该停，而不是抽满「最大抽奖次数」10 次
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000', balance: '20000' });
    const w = dom.window;

    let calls = 0;
    w.fetch = async url => {
        // 余额校准会去拉 lucky.php，这里回一个不带 .bean-number 的空页面，
        // 让脚本继续用本地估算，把一抽到底的停止条件单独测出来
        if (String(url).includes('lucky.php')) {
            return { ok: true, status: 200, text: async () => '<html><body></body></html>' };
        }
        calls++;
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: '魔力 100 ' } })
        };
    };

    await run(dom);
    const d = w.document;

    d.getElementById('drain-mode').checked = true;
    d.getElementById('drain-mode').dispatchEvent(new w.Event('change'));

    check('勾选后最大次数输入被置灰',
        d.getElementById('max-lottery-count').disabled === true);
    check('勾选后提示可见',
        d.getElementById('drain-hint').classList.contains('is-on'));

    d.getElementById('reserve-beans').value = '6000';
    d.getElementById('reserve-beans').dispatchEvent(new w.Event('change'));
    d.getElementById('lottery-interval').value = '3';
    d.getElementById('max-lottery-count').value = '10';

    d.getElementById('start-lottery').click();
    check('状态栏显示一抽到底',
        d.getElementById('lottery-status').textContent.includes('一抽到底'),
        d.getElementById('lottery-status').textContent);

    await untilStopped(d);

    // 每抽净减 1,900，从 20,000 抽到「再抽一次就跌破 6,000」
    // → 停在余额 7,650（再抽会剩 5,750 < 6,000），共 7 抽
    check(`抽了 7 次而不是最大次数 10 次（实际 ${calls}）`, calls === 7, `实际 ${calls}`);
    check('已停止', d.getElementById('lottery-status').textContent === '已停止');
    check('停止原因是一抽到底完成',
        Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('一抽到底完成')),
        '未找到完成日志');
    check('余额停在保留线之上',
        Number(d.getElementById('bean-balance').textContent.replace(/,/g, '')) >= 6000,
        d.getElementById('bean-balance').textContent);
}

/* ---------------------------------------------------------------- */
console.log('\n[17] 余额随中奖回血（魔力就是憨豆）');
{
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000', balance: '10000' });
    const w = dom.window;
    w.fetch = async url => {
        if (String(url).includes('lucky.php')) {
            return { ok: true, status: 200, text: async () => '<html><body></body></html>' };
        }
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: '魔力 5000 ' } })
        };
    };

    await run(dom);
    const d = w.document;
    d.getElementById('lottery-interval').value = '3';
    d.getElementById('max-lottery-count').value = '2';
    d.getElementById('start-lottery').click();
    await sleep(8000);

    // 10,000 - 2×2,000 + 2×5,000 = 16,000
    check('中的憨豆当场加回余额',
        d.getElementById('bean-balance').textContent === '16,000',
        d.getElementById('bean-balance').textContent);
    check('校准状态显示是估算值',
        d.getElementById('balance-freshness').textContent.includes('估算'),
        d.getElementById('balance-freshness').textContent);
}

/* ---------------------------------------------------------------- */
console.log('\n[18] 手动校准余额');
{
    const dom = makeDom({ useBean: '每次消耗憨豆： 2000', balance: '10000' });
    const w = dom.window;
    w.fetch = async url => {
        if (String(url).includes('lucky.php')) {
            // 服务端的权威值和本地估算不一样
            return {
                ok: true, status: 200,
                text: async () => '<html><body><div class="bean-number">88888.0</div></body></html>'
            };
        }
        return { ok: false, status: 500, text: async () => '' };
    };

    await run(dom);
    const d = w.document;
    check('初始读的是页面上的值',
        d.getElementById('bean-balance').textContent === '10,000',
        d.getElementById('bean-balance').textContent);

    d.getElementById('refresh-balance').click();
    await sleep(600);

    check('校准后采用服务端值',
        d.getElementById('bean-balance').textContent === '88,888',
        d.getElementById('bean-balance').textContent);
    check('校准后状态是已校准',
        d.getElementById('balance-freshness').textContent === '已校准',
        d.getElementById('balance-freshness').textContent);
    check('最多可抽随之更新',
        d.getElementById('max-possible').textContent === '44',
        d.getElementById('max-possible').textContent);
}

/* ---------------------------------------------------------------- */
console.log('\n[19] 备份导出与导入');
{
    const dom = makeDom();
    const w = dom.window;

    // jsdom 的 Blob 没有 .text()，包一层把写进去的内容截下来
    const NativeBlob = w.Blob;
    let blobParts = null, blobType = null;
    w.Blob = function (parts, options) {
        blobParts = parts;
        blobType = options?.type;
        return new NativeBlob(parts, options);
    };
    w.URL.createObjectURL = () => 'blob:stub';

    const seed = {
        version: 4, draws: 10, cost: 20000,
        gains: { beans: 3000, magic: 0, invite: 1, rainbow: 0, vip: 0, makeup: 0, upload: 0 },
        prizes: {
            beans: { count: 9, value: 3000, tiers: { '500 憨豆': 9 } },
            invite: { count: 1, value: 1, tiers: { '1 邀请': 1 } }
        },
        raw: { '魔力 500': 9 }
    };
    w.localStorage.setItem('hhanclub_lottery_stats_v4', JSON.stringify(seed));

    await run(dom);
    const d = w.document;

    d.getElementById('backup-stats').click();
    await sleep(80);

    check('点备份产生了 JSON blob', blobType === 'application/json', String(blobType));
    const payload = JSON.parse(blobParts[0]);
    check('备份带识别标记', payload.kind === 'hhclub-lottery-backup', payload.kind);
    check('备份含历史统计 10 抽', payload.total.draws === 10, payload.total.draws);
    check('备份含分奖项明细', payload.total.prizes.beans.count === 9);

    // 真正走一遍 importStats：拦下它 new 出来的 file input，塞个假文件再触发 change
    const backupJson = blobParts[0];
    const nativeCreate = d.createElement.bind(d);
    let picker = null;
    d.createElement = tag => {
        const el = nativeCreate(tag);
        if (tag === 'input') picker = el;
        return el;
    };

    // mode: 'merge' | 'replace' | 'cancel'，对应弹窗上的三个按钮
    const feed = async (json, mode) => {
        picker = null;
        d.getElementById('import-stats').click();
        Object.defineProperty(picker, 'files', {
            configurable: true,
            get: () => [{ name: 'backup.json', text: async () => json }]
        });
        picker.dispatchEvent(new w.Event('change'));
        await sleep(150);

        const dialog = d.querySelector('.hh-modal-overlay');
        if (!dialog) return null;

        const button = dialog.querySelector(`[data-mode="${mode}"]`);
        button.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
        await sleep(150);
        return button.textContent;
    };

    // 合并：把同一份备份再叠加一次
    const mergeLabel = await feed(backupJson, 'merge');
    check('弹窗把合并后的总抽数算给用户看',
        /共 20 抽/.test(mergeLabel || ''), mergeLabel);
    check('选完之后弹窗关掉了', !d.querySelector('.hh-modal-overlay'));
    let stored = JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4'));
    check('合并导入：抽数相加为 20', stored.draws === 20, stored.draws);
    check('合并导入：消耗相加为 40,000', stored.cost === 40000, stored.cost);
    check('合并导入：档位次数相加为 18',
        stored.prizes.beans.tiers['500 憨豆'] === 18, stored.prizes.beans.tiers['500 憨豆']);
    check('合并导入：兜底文案相加为 18', stored.raw['魔力 500'] === 18, stored.raw['魔力 500']);

    d.getElementById('view-mode').value = 'total';
    d.getElementById('view-mode').dispatchEvent(new w.Event('change'));
    await sleep(50);
    check('合并后面板同步刷新',
        d.getElementById('draw-count').textContent === '20',
        d.getElementById('draw-count').textContent);

    // 覆盖：回到备份里的 10 抽
    await feed(backupJson, 'replace');
    stored = JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4'));
    check('覆盖导入：抽数回到 10', stored.draws === 10, stored.draws);
    check('覆盖导入：档位次数回到 9',
        stored.prizes.beans.tiers['500 憨豆'] === 9, stored.prizes.beans.tiers['500 憨豆']);

    // 取消必须真的什么都不做
    await feed(backupJson, 'cancel');
    stored = JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4'));
    check('取消导入不改动任何数据', stored.draws === 10, stored.draws);
    check('取消打了对应日志',
        Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('已取消导入')),
        '未找到取消日志');

    // 垃圾文件不能把已有数据搞坏
    await feed('{ not json', 'merge');
    stored = JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4'));
    check('非法 JSON 被拒绝且不动已有数据', stored.draws === 10, stored.draws);
    check('非法 JSON 打了错误日志',
        Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('不是合法 JSON')),
        '未找到错误日志');

    await feed(JSON.stringify({ hello: 'world' }), 'merge');
    stored = JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4'));
    check('认不出的结构被拒绝', stored.draws === 10, stored.draws);

    d.createElement = nativeCreate;
}

/* ---------------------------------------------------------------- */
console.log('\n[20] 面板底部横幅已移除');
{
    const dom = makeDom();
    await run(dom);
    const d = dom.window.document;

    check('没有 .hh-footer 节点', !d.querySelector('#lottery-control-panel .hh-footer'));
    check('面板里不再出现 4TH ANNIVERSARY 底栏文案',
        !d.getElementById('lottery-control-panel').textContent.includes('HHCLUB 4TH ANNIVERSARY'));
}

/* ---------------------------------------------------------------- */
console.log('\n[21] 校准值必须压过过期的页面数字');
{
    // 这条是线上实测逼出来的：校准拿到服务端值之后，紧接着的
    // updateBalanceDisplay() 会重新读 DOM，一旦 DOM 数字和上次记录的不同，
    // 「DOM 变了就采信 DOM」的规则就会把刚校准好的值冲掉。
    const dom = makeDom({ useBean: '每次消耗憨豆： 2000', balance: '10000' });
    const w = dom.window;
    w.fetch = async url => {
        if (String(url).includes('lucky.php')) {
            return {
                ok: true, status: 200,
                text: async () => '<html><body><div class="bean-number">1741668.0</div></body></html>'
            };
        }
        return { ok: false, status: 500, text: async () => '' };
    };

    await run(dom);
    const d = w.document;

    // 页面上的数字换成另一个过期值（模拟站点自己动过、或者别处改过）
    d.querySelector('.bean-number').textContent = '12345.0';

    d.getElementById('refresh-balance').click();
    await sleep(700);

    check('校准后显示服务端值而不是页面上的旧数字',
        d.getElementById('bean-balance').textContent === '1,741,668',
        d.getElementById('bean-balance').textContent);

    // 「按余额设置」会走一遍 updateBalanceDisplay，正好用来确认校准值稳得住
    d.getElementById('set-max-possible').click();
    await sleep(120);
    d.getElementById('set-max-possible').click();
    await sleep(120);

    check('后续刷新不会把校准值冲回去',
        d.getElementById('bean-balance').textContent === '1,741,668',
        d.getElementById('bean-balance').textContent);
    check('最多可抽按校准值算',
        d.getElementById('max-possible').textContent === '870',
        d.getElementById('max-possible').textContent);

    // 但页面数字如果之后又变了（比如用户刷新了页面），仍然要重新采信
    d.querySelector('.bean-number').textContent = '500000.0';
    d.getElementById('set-max-possible').click();
    await sleep(120);

    check('DOM 之后再变化时仍然重新采信',
        d.getElementById('bean-balance').textContent === '500,000',
        d.getElementById('bean-balance').textContent);
}

/* ---------------------------------------------------------------- */
console.log('\n[22] 站点调整爆率后奖池会跟着刷新');
{
    // 站点把 780,000 憨豆的爆率从 0.11% 调到 0.30%，
    // 理论盈亏率和大奖判定都该跟着变
    const TUNED = REAL_POOL.map(item =>
        (item.typeText === '魔力' && item.amountText === '780000 ')
            ? { ...item, probability_real: '0.0030' }
            : item);

    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000', balance: '100000' });
    const w = dom.window;

    w.fetch = async url => {
        if (String(url).includes('lucky.php')) {
            // 抓回来的页面带的是调整后的奖池
            return {
                ok: true, status: 200,
                text: async () => `<html><body>
                    <div class="bean-number">100000.0</div>
                    <script>let prizes = ${JSON.stringify(TUNED)};</script>
                </body></html>`
            };
        }
        return { ok: false, status: 500, text: async () => '' };
    };

    await run(dom);
    const d = w.document;

    d.getElementById('refresh-balance').click();
    await until(() => Array.from(d.querySelectorAll('#lottery-log div'))
        .some(el => el.textContent.includes('调整了奖池爆率')), 5000);

    check('日志提示了爆率变动',
        Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('调整了奖池爆率')),
        '未找到爆率变动日志');

    // 抽一注 780,000，档位行上的官方爆率应该已经是调整后的 0.30%
    w.fetch = async () => ({
        ok: true, status: 200,
        text: async () => JSON.stringify({ ret: 0, data: { prize_text: '魔力 780000 ' } })
    });
    d.getElementById('lottery-interval').value = '3';
    d.getElementById('max-lottery-count').value = '1';
    d.getElementById('start-lottery').click();
    await untilStopped(d);

    check('明细里的官方爆率换成了调整后的 0.30%',
        Array.from(d.querySelectorAll('#detail-list .hh-tier-rate'))
            .some(el => el.textContent.includes('官方 0.30%')),
        Array.from(d.querySelectorAll('#detail-list .hh-tier-rate')).map(el => el.textContent).join(' | '));
}

/* ---------------------------------------------------------------- */
console.log('\n[23] 爆率没变时不重复打扰');
{
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000', balance: '100000' });
    const w = dom.window;
    w.fetch = async url => {
        if (String(url).includes('lucky.php')) {
            return {
                ok: true, status: 200,
                text: async () => `<html><body>
                    <div class="bean-number">100000.0</div>
                    <script>let prizes = ${JSON.stringify(REAL_POOL)};</script>
                </body></html>`
            };
        }
        return { ok: false, status: 500, text: async () => '' };
    };

    await run(dom);
    const d = w.document;

    d.getElementById('refresh-balance').click();
    await sleep(600);
    d.getElementById('refresh-balance').click();
    await sleep(600);

    check('奖池没变就不打爆率变动日志',
        !Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('调整了奖池爆率')),
        '不该出现的日志');
    check('也不会误报站点撤掉了爆率',
        !Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('不再公布')),
        '不该出现的日志');
}

/* ---------------------------------------------------------------- */
console.log('\n[24] 抓回来的页面读不到奖池时保留原有爆率');
{
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000', balance: '100000' });
    const w = dom.window;
    w.fetch = async url => {
        if (String(url).includes('lucky.php')) {
            // 站点改版 / 返回了不带奖池的页面
            return {
                ok: true, status: 200,
                text: async () => '<html><body><div class="bean-number">777777.0</div></body></html>'
            };
        }
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: '魔力 100 ' } })
        };
    };

    await run(dom);
    const d = w.document;

    // 先抽一注，明细里才有行可看
    d.getElementById('lottery-interval').value = '3';
    d.getElementById('max-lottery-count').value = '1';
    d.getElementById('start-lottery').click();
    await untilStopped(d);

    d.getElementById('refresh-balance').click();
    await until(() => d.getElementById('bean-balance').textContent === '777,777', 5000);

    check('余额照常校准', d.getElementById('bean-balance').textContent === '777,777',
        d.getElementById('bean-balance').textContent);
    check('奖池读不到时沿用原有爆率，不清空',
        Array.from(d.querySelectorAll('#detail-list .hh-row-official'))
            .some(el => el.textContent === '官方 83.0%'),
        Array.from(d.querySelectorAll('#detail-list .hh-row-official')).map(el => el.textContent).join(' | '));
    check('也不会误报站点撤掉了爆率',
        !Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('不再公布')),
        '不该出现的日志');
}

/* ---------------------------------------------------------------- */
console.log('\n[25] 挂机期间站点调价：跟进但不打断');
{
    // 一抽到底是挂机用的。中途站点把单抽消耗从 2,000 调到 4,000，
    // 脚本要跟上新成本，但不能弹窗、不能停。
    const TUNED_POOL = REAL_POOL.map(item =>
        (item.typeText === '魔力' && item.amountText === '780000 ')
            ? { ...item, probability_real: '0.0030' }
            : item);

    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000', balance: '30000' });
    const w = dom.window;

    // 任何弹窗都算打断挂机
    let interrupted = 0;
    w.confirm = () => { interrupted++; return true; };
    w.alert = () => { interrupted++; };

    let draws = 0;
    w.fetch = async url => {
        if (String(url).includes('lucky.php')) {
            return {
                ok: true, status: 200,
                text: async () => `<html><body>
                    <div class="bean-number">${30000 - draws * 1900}.0</div>
                    <div class="use-bean">每次消耗憨豆： 4000</div>
                    <script>let prizes = ${JSON.stringify(TUNED_POOL)};</script>
                </body></html>`
            };
        }
        draws++;
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: '魔力 100 ' } })
        };
    };

    await run(dom);
    const d = w.document;

    check('起步用页面上的 2,000', d.getElementById('single-cost').textContent === '2,000',
        d.getElementById('single-cost').textContent);

    d.getElementById('drain-mode').checked = true;
    d.getElementById('drain-mode').dispatchEvent(new w.Event('change'));
    d.getElementById('reserve-beans').value = '12000';
    d.getElementById('reserve-beans').dispatchEvent(new w.Event('change'));
    d.getElementById('lottery-interval').value = '3';
    d.getElementById('start-lottery').click();

    // 第一次校准发生在余额估算逼近保留线时，会带回新的成本和爆率
    await until(() => d.getElementById('single-cost').textContent === '4,000', 90000);
    check('跟进了站点的新单次消耗 4,000',
        d.getElementById('single-cost').textContent === '4,000',
        d.getElementById('single-cost').textContent);

    await untilStopped(d);

    check('挂机全程没有弹出任何对话框', interrupted === 0, `弹了 ${interrupted} 次`);
    check('调价日志有记录',
        Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('单次消耗')),
        '未找到调价日志');
    check('爆率变动日志也有记录',
        Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('调整了奖池爆率')),
        '未找到爆率日志');
    check('是按一抽到底的条件停的，不是被打断的',
        Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('一抽到底完成')),
        '未按保留线停止');

    // 用新成本判断，余额必须停在保留线之上
    const finalBalance = Number(d.getElementById('bean-balance').textContent.replace(/,/g, ''));
    check(`按新成本守住保留线 12,000（余额 ${finalBalance}）`,
        finalBalance >= 12000, `实际 ${finalBalance}`);
}

/* ---------------------------------------------------------------- */
console.log('\n[26] 单次消耗没变时不打扰');
{
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000', balance: '100000' });
    const w = dom.window;
    w.fetch = async url => {
        if (String(url).includes('lucky.php')) {
            return {
                ok: true, status: 200,
                text: async () => `<html><body>
                    <div class="bean-number">100000.0</div>
                    <div class="use-bean">每次消耗憨豆： 2000</div>
                </body></html>`
            };
        }
        return { ok: false, status: 500, text: async () => '' };
    };

    await run(dom);
    const d = w.document;

    d.getElementById('refresh-balance').click();
    await sleep(600);

    check('消耗没变就不打日志',
        !Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('单次消耗')),
        '不该出现的日志');
    check('单次消耗保持 2,000',
        d.getElementById('single-cost').textContent === '2,000',
        d.getElementById('single-cost').textContent);
}

/* ---------------------------------------------------------------- */
console.log('\n[27] 站点撤掉 probability_real 时改用原始权重');
{
    // 线上 2026-08-19 的奖池：只剩 probability（原始权重），没有算好的概率
    const WEIGHT_POOL = [
        { typeText: '彩虹 ID', amountText: '7 Day(s)', probability: 400 },
        { typeText: '魔力', amountText: '780000 ', probability: 14 },
        { typeText: '魔力', amountText: '5000 ', probability: 2039 },
        { typeText: 'VIP', amountText: '7 Day(s)', probability: 3 },
        { typeText: '魔力', amountText: '100 ', probability: 3961 },
        { typeText: '补签卡', amountText: '1 ', probability: 800 },
        { typeText: '魔力', amountText: '2000 ', probability: 3000 },
        { typeText: '上传量', amountText: '2 GB', probability: 800 },
        { typeText: '魔力', amountText: '1000 ', probability: 3500 },
        { typeText: '上传量', amountText: '5 GB', probability: 200 },
        { typeText: '邀请', amountText: '1 ', probability: 50 }
    ];

    const dom = makeDom({ pool: WEIGHT_POOL, useBean: '每次消耗憨豆： 2000', balance: '100000' });
    const w = dom.window;
    w.fetch = async url => {
        if (String(url).includes('lucky.php')) {
            return { ok: true, status: 200, text: async () => '<html><body></body></html>' };
        }
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: '魔力 100 ' } })
        };
    };

    await run(dom);
    const d = w.document;

    d.getElementById('lottery-interval').value = '3';
    d.getElementById('max-lottery-count').value = '1';
    d.getElementById('start-lottery').click();
    await untilStopped(d);

    const official = Array.from(d.querySelectorAll('#detail-list .hh-row-official'));
    check('官方爆率照常显示，不是 0.00%',
        official.length === 1 && official[0].textContent === '官方 84.7%',
        official.map(el => el.textContent).join(' | '));

    const tierRates = Array.from(d.querySelectorAll('#detail-list .hh-tier-rate'));
    check('档位爆率也配得上（100 憨豆 26.82%）',
        tierRates.some(el => el.textContent.includes('官方 26.82%')),
        tierRates.map(el => el.textContent).join(' | '));
}

/* ---------------------------------------------------------------- */
console.log('\n[28] 两个爆率字段都没有时整块降级，不摆 0.00%');
{
    const BLIND_POOL = REAL_POOL.map(({ typeText, amountText }) => ({ typeText, amountText }));

    const dom = makeDom({ pool: BLIND_POOL, useBean: '每次消耗憨豆： 2000', balance: '100000' });
    const w = dom.window;
    w.fetch = async url => {
        if (String(url).includes('lucky.php')) {
            return { ok: true, status: 200, text: async () => '<html><body></body></html>' };
        }
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: '魔力 100 ' } })
        };
    };

    await run(dom);
    const d = w.document;

    check('日志说明了爆率为什么没了',
        Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('不再公布')),
        '未找到说明日志');

    d.getElementById('lottery-interval').value = '3';
    d.getElementById('max-lottery-count').value = '1';
    d.getElementById('start-lottery').click();
    await untilStopped(d);

    check('类别行不显示官方爆率',
        d.querySelectorAll('#detail-list .hh-row-official').length === 0,
        Array.from(d.querySelectorAll('#detail-list .hh-row-official')).map(el => el.textContent).join(' | '));
    check('档位行也不显示官方爆率',
        d.querySelectorAll('#detail-list .hh-tier-rate').length === 0,
        Array.from(d.querySelectorAll('#detail-list .hh-tier-rate')).map(el => el.textContent).join(' | '));
    check('实测数据照常统计',
        d.getElementById('draw-count').textContent === '1',
        d.getElementById('draw-count').textContent);
}


/* 收件箱页面夹具：照站点的 grid 行结构渲染，外加那个翻页下拉框 —— 脚本靠它读总页数 */
function mailPage(items, pageCount = 1) {
    const rows = items.map(item => `
        <div class="grid grid-cols-[10%_5%_60%_10%_15%]">
            <div class="flex flex-row act-checkbox">
                <input type="checkbox" name="messages[]" value="${item.id}">
            </div>
            <div><img src="icon-unread.svg"></div>
            <div><a href="messages.php?action=viewmessage&id=${item.id}">${item.subject}</a></div>
            <div>系统</div>
            <div>2026-08-19 11:35:52</div>
        </div>`).join('');
    const pager = `<select onchange="switchPage(this)">${
        Array.from({ length: Math.max(1, pageCount) }, (_, n) => `<option value="${n}">${n + 1}</option>`).join('')
    }</select>`;
    return `<html><body><form method="post" action="messages.php">
        <input type="hidden" name="action" value="moveordel">${pager}${rows}</form></body></html>`;
}

const lotteryMail = (from, count) =>
    Array.from({ length: count }, (_, i) => ({ id: String(from + i), subject: '幸运大转盘 中奖通知' }));

/* 一个会真的少信的收件箱：删掉的信从后续分页里消失。
   pageSize 可调 —— 站点上每页显示多少封是用户自己设的，默认 100，见过 10 的。 */
function makeMailbox(items, pageSize = 100) {
    let inbox = [...items];
    let size = pageSize;
    return {
        setPageSize(n) { size = n; },
        get pageCount() { return Math.max(1, Math.ceil(inbox.length / size)); },
        page(n) { return inbox.slice(n * size, (n + 1) * size); },
        remove(ids) { inbox = inbox.filter(item => !ids.includes(item.id)); },
        add(item) { inbox = [item, ...inbox]; },
        get all() { return inbox; }
    };
}

/* 把一个 makeMailbox 接到 window.fetch 上，顺带记账 */
function serveMailbox(w, box, { onDelete } = {}) {
    const log = { deleted: [], pageHits: [], posts: 0, actions: [], flags: [] };
    w.fetch = async (url, init = {}) => {
        const target = String(url);
        if (init.method === 'POST') {
            log.posts++;
            log.actions.push(init.body.get('action'));
            log.flags.push(init.body.get('delete'));

            const ids = init.body.getAll('messages[]');
            log.deleted.push(...ids);
            box.remove(ids);
            onDelete?.(log.posts);
            return { ok: true, status: 200, text: async () => '' };
        }
        if (target.includes('messages.php')) {
            const page = Number(new URL(target, 'https://hhanclub.net').searchParams.get('page'));
            log.pageHits.push(page);
            return { ok: true, status: 200, text: async () => mailPage(box.page(page), box.pageCount) };
        }
        return { ok: true, status: 200, text: async () => '<html><body></body></html>' };
    };
    return log;
}

/* ---------------------------------------------------------------- */
console.log('\n[29] 只删抽奖通知：别的信一封不碰，中途新到的也扫干净');
{
    const KEEP = [
        { id: '9001', subject: '种子被删除' },
        { id: '9002', subject: '种子被删除' },
        { id: '9003', subject: '憨豆 改变' }
    ];
    const box = makeMailbox([
        ...lotteryMail(1000, 100),
        ...lotteryMail(2000, 98), KEEP[0], KEEP[1],
        ...lotteryMail(3000, 15), KEEP[2]
    ]);
    const TOTAL_LOTTERY = 100 + 98 + 15;

    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;

    // 第一批删完的当口又中了一次奖，新通知这时才进收件箱 ——
    // 它不在扫描时的 id 清单里，只能靠扫尾那一步收掉
    const log = serveMailbox(w, box, {
        onDelete: posts => { if (posts === 1) box.add({ id: '4242', subject: '幸运大转盘 中奖通知' }); }
    });

    await run(dom);
    const d = w.document;

    d.getElementById('purge-mail').click();
    await until(() => !!d.querySelector('.hh-modal-overlay [data-mode="lottery"]'), 10000);

    const modalText = (d.querySelector('.hh-modal-text')?.textContent || '').replace(/\s+/g, ' ').trim();
    check(`确认框写明收件箱共 ${TOTAL_LOTTERY + 3} 封`, modalText.includes(String(TOTAL_LOTTERY + 3)), modalText);
    check(`确认框写明抽奖通知 ${TOTAL_LOTTERY} 封`, modalText.includes(String(TOTAL_LOTTERY)), modalText);
    check('确认框给了「全部删除」这个选项',
        !!d.querySelector('.hh-modal-overlay [data-mode="all"]'), '没有全部删除按钮');

    d.querySelector('.hh-modal-overlay [data-mode="lottery"]').click();
    await until(() => log.deleted.includes('4242'), 10000);
    await sleep(400);

    check('每次提交都带 action=moveordel',
        log.actions.every(a => a === 'moveordel'), log.actions.join(','));
    check('每次提交按的都是删除键',
        log.flags.every(f => f === '删除'), log.flags.join(','));
    check('先按翻页框翻完三页，删完再补扫第一页到干净',
        log.pageHits.join(',') === '0,1,2,0,0', log.pageHits.join(','));
    check(`删掉 ${TOTAL_LOTTERY} 封 + 中途新到的 1 封`,
        log.deleted.length === TOTAL_LOTTERY + 1, `实际 ${log.deleted.length}`);
    check('中途新到的那封也删了', log.deleted.includes('4242'), '没删掉');
    check('一封非抽奖通知都没被删',
        KEEP.every(item => !log.deleted.includes(item.id)),
        KEEP.filter(item => log.deleted.includes(item.id)).map(item => item.subject).join(' | '));
    check('收件箱里只剩那 3 封该留的',
        box.all.length === 3 && box.all.every(item => !item.subject.includes('幸运大转盘')),
        box.all.map(item => item.subject).join(' | '));
    check('日志写明了删了多少、留了多少',
        Array.from(d.querySelectorAll('#lottery-log div'))
            .some(el => el.textContent.includes('已删除') && el.textContent.includes('原样保留')),
        '未找到结果日志');
}

/* ---------------------------------------------------------------- */
console.log('\n[30] 每页只显示 10 封时也要翻完整个收件箱');
{
    // 每页显示多少封是用户在站点设置里自己定的。早先的实现写死「不满 100 封
    // 就是最后一页」，每页 10 封的人翻一页就以为到底了，第 11 封往后全删不掉。
    const KEEP = [
        { id: '9001', subject: '种子被删除' },
        { id: '9002', subject: '憨豆 改变' }
    ];
    const box = makeMailbox([...lotteryMail(1000, 40), ...KEEP], 10);

    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;
    const log = serveMailbox(w, box);

    await run(dom);
    const d = w.document;

    d.getElementById('purge-mail').click();
    await until(() => !!d.querySelector('.hh-modal-overlay [data-mode="lottery"]'), 10000);

    const modalText = (d.querySelector('.hh-modal-text')?.textContent || '').replace(/\s+/g, ' ').trim();
    check('确认框认出了全部 40 封抽奖通知', modalText.includes('40'), modalText);

    check('扫描翻了全部 5 页，不是只翻第一页',
        log.pageHits.slice(0, 5).join(',') === '0,1,2,3,4', log.pageHits.join(','));

    d.querySelector('.hh-modal-overlay [data-mode="lottery"]').click();
    await until(() => log.deleted.length >= 40, 10000);
    await sleep(400);

    check('40 封抽奖通知一封不剩', log.deleted.length === 40, `实际 ${log.deleted.length}`);
    check('第 11 封往后的也删掉了',
        log.deleted.includes('1010') && log.deleted.includes('1039'), '有漏网的');
    check('两封该留的还在',
        box.all.length === 2 && KEEP.every(item => !log.deleted.includes(item.id)),
        box.all.map(item => item.subject).join(' | '));
}

/* ---------------------------------------------------------------- */
console.log('\n[31] 取消确认框时一封都不删');
{
    const box = makeMailbox(lotteryMail(5000, 12));

    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;
    const log = serveMailbox(w, box);

    await run(dom);
    const d = w.document;

    d.getElementById('purge-mail').click();
    await until(() => !!d.querySelector('.hh-modal-overlay [data-mode="cancel"]'), 10000);
    d.querySelector('.hh-modal-overlay [data-mode="cancel"]').click();
    await sleep(400);

    check('取消后没有发出任何删除请求', log.posts === 0, `实际 ${log.posts}`);
    check('收件箱一封没少', box.all.length === 12, `实际 ${box.all.length}`);
    check('日志说明了已取消',
        Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('一封都没删')),
        '未找到取消日志');
    check('按钮恢复可用',
        d.getElementById('purge-mail').disabled === false
        && d.getElementById('purge-mail').textContent.includes('立即清空'),
        d.getElementById('purge-mail').textContent);
}

/* ---------------------------------------------------------------- */
console.log('\n[32] 全部删除：连别的站内信一起清，但不补扫');
{
    const box = makeMailbox([
        ...lotteryMail(1000, 8),
        { id: '9001', subject: '种子被删除' },
        { id: '9002', subject: '憨豆 改变' }
    ]);

    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;
    // 删的当口又到了一封正经站内信，全部删除模式不该把它带走
    const log = serveMailbox(w, box, {
        onDelete: () => box.add({ id: '7777', subject: '种子被删除' })
    });

    await run(dom);
    const d = w.document;

    d.getElementById('purge-mail').click();
    await until(() => !!d.querySelector('.hh-modal-overlay [data-mode="all"]'), 10000);
    d.querySelector('.hh-modal-overlay [data-mode="all"]').click();
    await until(() => log.deleted.length >= 10, 10000);
    await sleep(400);

    check('10 封全删了', log.deleted.length === 10, `实际 ${log.deleted.length}`);
    check('非抽奖通知这次也删了',
        log.deleted.includes('9001') && log.deleted.includes('9002'), log.deleted.join(','));
    check('一页装得下就只读一页', log.pageHits.join(',') === '0', log.pageHits.join(','));
    check('全部删除不补扫，删除期间新到的正经站内信没被带走',
        !log.deleted.includes('7777') && box.all.some(item => item.id === '7777'),
        box.all.map(item => item.id).join(','));
    check('日志说的是清空收件箱',
        Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('已清空收件箱')),
        '未找到结果日志');
}

/* ---------------------------------------------------------------- */
console.log('\n[33] 自动删站内信：关着不动，开着一路清到第一页干净');
{
    // 每页 10 封，但两次校准之间会攒 25 封 —— 一次只清一页永远追不上，
    // 所以自动清理必须循环清到第一页没有抽奖通知为止
    const KEEP = { id: '9001', subject: '种子被删除' };
    const box = makeMailbox([...lotteryMail(7000, 30), KEEP], 10);

    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000', balance: '10000000' });
    const w = dom.window;

    const deleted = [];
    const pageHits = [];
    w.fetch = async (url, init = {}) => {
        const target = String(url);
        if (init.method === 'POST' && target.includes('messages.php')) {
            const ids = init.body.getAll('messages[]');
            deleted.push(...ids);
            box.remove(ids);
            return { ok: true, status: 200, text: async () => '' };
        }
        if (target.includes('messages.php')) {
            const page = Number(new URL(target, 'https://hhanclub.net').searchParams.get('page'));
            pageHits.push(page);
            return { ok: true, status: 200, text: async () => mailPage(box.page(page), box.pageCount) };
        }
        if (target.includes('lucky.php')) {
            return {
                ok: true, status: 200,
                text: async () => '<html><body><div class="bean-number">10000000.0</div></body></html>'
            };
        }
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ ret: 0, data: { prize_text: '魔力 100 ' } })
        };
    };

    await run(dom);
    const d = w.document;

    check('默认不开', d.getElementById('auto-clean-mail').checked === false);

    d.getElementById('lottery-interval').value = '3';
    d.getElementById('max-lottery-count').value = '3';
    d.getElementById('start-lottery').click();
    await untilStopped(d);

    check('没开时一次都不去读收件箱', pageHits.length === 0, pageHits.join(','));

    d.getElementById('auto-clean-mail').checked = true;
    d.getElementById('auto-clean-mail').dispatchEvent(new w.Event('change'));
    check('开关状态存进了设置',
        JSON.parse(w.localStorage.getItem('hhanclub_lottery_settings_v1')).autoCleanMail === true,
        w.localStorage.getItem('hhanclub_lottery_settings_v1'));
    check('提示文案跟着显示',
        d.getElementById('mail-hint').classList.contains('is-on'));

    d.getElementById('max-lottery-count').value = '26';
    d.getElementById('start-lottery').click();
    await until(() => deleted.length >= 30, 150000);
    await untilStopped(d, 150000);

    check('自动清理只读第一页', pageHits.every(page => page === 0), pageHits.join(','));
    check('30 封抽奖通知全清掉，没有因为一页只有 10 封就停',
        deleted.length === 30, `实际 ${deleted.length}`);
    check('自动清理也不碰其他站内信',
        !deleted.includes(KEEP.id) && box.all.length === 1, box.all.map(item => item.subject).join(' | '));
    check('日志记了一行',
        Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('封抽奖通知')),
        '未找到清理日志');
}

/* 网站设定页夹具：照 usercp 的样子给一堆各类字段，用来验证「只改 pmnum」 */
function usercpPage(pmnum) {
    return `<html><body>
        <form action="usercp.php" method="post">
            <input type="hidden" name="action" value="tracker">
            <input type="hidden" name="type" value="save">
            <input type="checkbox" name="cat401" value="yes" checked>
            <input type="checkbox" name="cat402" value="yes">
            <input type="checkbox" name="cat403" value="yes" checked>
            <input type="checkbox" name="showcomnum" value="yes" checked>
            <input type="radio" name="timetype" value="added">
            <input type="radio" name="timetype" value="last" checked>
            <select name="stylesheet">
                <option value="1">默认</option><option value="7" selected>HHan</option>
            </select>
            <select name="fontsize">
                <option value="small">小</option><option value="medium" selected>中</option>
            </select>
            <input type="text" name="pmnum" value="${pmnum}">
            <input type="text" name="sbnum" value="70">
            <input type="text" name="torrentsperpage" value="0">
            <button type="submit">保存</button>
        </form>
    </body></html>`;
}

/* ---------------------------------------------------------------- */
console.log('\n[34] 每页条数太小时提议改站点设置，且只改这一项');
{
    const KEEP = { id: '9001', subject: '种子被删除' };
    const box = makeMailbox([...lotteryMail(1000, 44), KEEP], 10);   // 45 封 / 每页 10 = 5 页

    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;

    let pmnum = 10;
    let savedBody = null;
    const pageHits = [];
    const deleted = [];

    w.fetch = async (url, init = {}) => {
        const target = String(url);

        if (target.includes('usercp.php') && init.method === 'POST') {
            savedBody = init.body;
            pmnum = Number(init.body.get('pmnum')) || pmnum;
            box.setPageSize(pmnum);
            return { ok: true, status: 200, text: async () => '' };
        }
        if (target.includes('usercp.php')) {
            return { ok: true, status: 200, text: async () => usercpPage(pmnum) };
        }
        if (init.method === 'POST') {
            const ids = init.body.getAll('messages[]');
            deleted.push(...ids);
            box.remove(ids);
            return { ok: true, status: 200, text: async () => '' };
        }
        if (target.includes('messages.php')) {
            const page = Number(new URL(target, 'https://hhanclub.net').searchParams.get('page'));
            pageHits.push(page);
            return { ok: true, status: 200, text: async () => mailPage(box.page(page), box.pageCount) };
        }
        return { ok: true, status: 200, text: async () => '<html><body></body></html>' };
    };

    await run(dom);
    const d = w.document;

    d.getElementById('purge-mail').click();
    await until(() => !!d.querySelector('.hh-modal-overlay [data-mode="bump"]'), 10000);

    const askText = (d.querySelector('.hh-modal-text')?.textContent || '').replace(/\s+/g, ' ').trim();
    check('提示里写明了当前每页 10 封、要翻 5 页',
        askText.includes('10') && askText.includes('5'), askText);

    d.querySelector('.hh-modal-overlay [data-mode="bump"]').click();
    await until(() => !!savedBody, 10000);

    check('提交的是 action=tracker / type=save',
        savedBody.get('action') === 'tracker' && savedBody.get('type') === 'save',
        `${savedBody.get('action')} / ${savedBody.get('type')}`);
    check('pmnum 改成了 100', savedBody.get('pmnum') === '100', savedBody.get('pmnum'));
    check('pmnum 只提交一次，不是追加',
        savedBody.getAll('pmnum').length === 1, `实际 ${savedBody.getAll('pmnum').length} 个`);
    check('勾着的复选框原样回填',
        savedBody.getAll('cat401').join() === 'yes'
        && savedBody.getAll('cat403').join() === 'yes'
        && savedBody.getAll('showcomnum').join() === 'yes',
        [...savedBody.keys()].join(','));
    check('没勾的复选框不会被凭空勾上',
        !savedBody.has('cat402'), 'cat402 被提交了');
    check('单选按当前选中的那个提交',
        savedBody.get('timetype') === 'last', savedBody.get('timetype'));
    check('下拉框按当前选中项提交',
        savedBody.get('stylesheet') === '7' && savedBody.get('fontsize') === 'medium',
        `${savedBody.get('stylesheet')} / ${savedBody.get('fontsize')}`);
    check('其余文本框原样回填',
        savedBody.get('sbnum') === '70' && savedBody.get('torrentsperpage') === '0',
        `${savedBody.get('sbnum')} / ${savedBody.get('torrentsperpage')}`);
    check('提交按钮不会被当成字段',
        ![...savedBody.keys()].some(k => k === ''), [...savedBody.keys()].join(','));

    check('日志报了改动结果',
        Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('每页站内信条数已改成')),
        '未找到结果日志');

    // 改完之后按新的每页 100 封扫，44 封抽奖通知照样一封不漏
    await until(() => !!d.querySelector('.hh-modal-overlay [data-mode="lottery"]'), 10000);
    d.querySelector('.hh-modal-overlay [data-mode="lottery"]').click();
    await until(() => deleted.length >= 44, 10000);
    await sleep(400);

    check('改完后按新页大小扫，44 封全删了', deleted.length === 44, `实际 ${deleted.length}`);
    check('该留的那封还在', !deleted.includes(KEEP.id) && box.all.length === 1,
        box.all.map(item => item.subject).join(' | '));

    // 问过一次就不再问
    box.add({ id: '8001', subject: '幸运大转盘 中奖通知' });
    d.getElementById('purge-mail').click();
    await until(() => !!d.querySelector('.hh-modal-overlay [data-mode="lottery"]'), 10000);
    check('答过一次就不再打扰',
        !d.querySelector('.hh-modal-overlay [data-mode="bump"]'), '又弹了一次');
    d.querySelector('.hh-modal-overlay [data-mode="cancel"]').click();
    await sleep(200);
}

/* ---------------------------------------------------------------- */
console.log('\n[35] 页数不多时不提这茬');
{
    const box = makeMailbox(lotteryMail(1000, 15), 10);   // 15 封 / 每页 10 = 2 页

    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    const w = dom.window;

    let usercpHits = 0;
    w.fetch = async (url, init = {}) => {
        const target = String(url);
        if (target.includes('usercp.php')) {
            usercpHits++;
            return { ok: true, status: 200, text: async () => usercpPage(10) };
        }
        if (init.method === 'POST') {
            box.remove(init.body.getAll('messages[]'));
            return { ok: true, status: 200, text: async () => '' };
        }
        if (target.includes('messages.php')) {
            const page = Number(new URL(target, 'https://hhanclub.net').searchParams.get('page'));
            return { ok: true, status: 200, text: async () => mailPage(box.page(page), box.pageCount) };
        }
        return { ok: true, status: 200, text: async () => '<html><body></body></html>' };
    };

    await run(dom);
    const d = w.document;

    d.getElementById('purge-mail').click();
    await until(() => !!d.querySelector('.hh-modal-overlay [data-mode="lottery"]'), 10000);

    check('只有两页时不弹改设置的提示',
        !d.querySelector('.hh-modal-overlay [data-mode="bump"]'), '弹了');
    check('也没去碰网站设定页', usercpHits === 0, `实际请求了 ${usercpHits} 次`);

    d.querySelector('.hh-modal-overlay [data-mode="cancel"]').click();
    await sleep(200);
}

/* ---------------------------------------------------------------- */
console.log(`\n=========== ${passed} passed, ${failed} failed ===========\n`);
process.exit(failed ? 1 : 0);
