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

    await sleep(22000);

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
    await sleep(9000);
    const backedOff = parseFloat(d.getElementById('current-interval').textContent);
    check(`限流后间隔被拉长（当前 ${backedOff}s）`, backedOff > 3, `实际 ${backedOff}`);

    await sleep(26000);
    const recovered = parseFloat(d.getElementById('current-interval').textContent);
    check(`成功后间隔降回 3s（当前 ${recovered}s）`, recovered === 3, `实际 ${recovered}`);
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

    for (let n = 0; n < 60 && d.getElementById('lottery-status').textContent !== '已停止'; n++) {
        await sleep(1000);
    }

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

    // 理论盈亏率只依赖奖池，没抽过也该算得出来
    const expected = 780000 * 0.0011 + 5000 * 0.1507 + 100 * 0.2261 + 2000 * 0.2261 + 1000 * 0.2261;
    const baseline = ((expected - 2000) / 2000) * 100;
    check(`显示理论盈亏率 ${baseline.toFixed(1)}%`,
        d.getElementById('theory-rate').textContent === `+${baseline.toFixed(1)}%`,
        d.getElementById('theory-rate').textContent);
    check('转盘是正期望的', baseline > 0, `实际 ${baseline.toFixed(2)}%`);

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
    check('悬停提示带理论盈亏率',
        /理论盈亏率 \+[\d.]+%/.test(d.getElementById('profit-rate').title),
        d.getElementById('profit-rate').title);
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
    await sleep(20000);

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
    check('无奖池时理论盈亏率显示 -',
        d.getElementById('theory-rate').textContent === '-',
        d.getElementById('theory-rate').textContent);
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

    for (let i = 0; i < 40 && d.getElementById('lottery-status').textContent !== '已停止'; i++) {
        await sleep(1000);
    }

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

    const feed = async (json, replace) => {
        picker = null;
        w.confirm = () => replace;
        d.getElementById('import-stats').click();
        Object.defineProperty(picker, 'files', {
            configurable: true,
            get: () => [{ name: 'backup.json', text: async () => json }]
        });
        picker.dispatchEvent(new w.Event('change'));
        await sleep(200);
    };

    // 取消 = 合并：把同一份备份再叠加一次
    await feed(backupJson, false);
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

    // 确定 = 覆盖：回到备份里的 10 抽
    await feed(backupJson, true);
    stored = JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4'));
    check('覆盖导入：抽数回到 10', stored.draws === 10, stored.draws);
    check('覆盖导入：档位次数回到 9',
        stored.prizes.beans.tiers['500 憨豆'] === 9, stored.prizes.beans.tiers['500 憨豆']);

    // 垃圾文件不能把已有数据搞坏
    await feed('{ not json', false);
    stored = JSON.parse(w.localStorage.getItem('hhanclub_lottery_stats_v4'));
    check('非法 JSON 被拒绝且不动已有数据', stored.draws === 10, stored.draws);
    check('非法 JSON 打了错误日志',
        Array.from(d.querySelectorAll('#lottery-log div')).some(el => el.textContent.includes('不是合法 JSON')),
        '未找到错误日志');

    await feed(JSON.stringify({ hello: 'world' }), false);
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
console.log(`\n=========== ${passed} passed, ${failed} failed ===========\n`);
process.exit(failed ? 1 : 0);
