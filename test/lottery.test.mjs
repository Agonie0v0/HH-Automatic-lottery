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

function makeDom({ legacy = null, pool = null, useBean = '每次消耗 2,000 憨豆' } = {}) {
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
        <div class="bean-number">1,234,567</div>
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
   REAL_POOL 是抽奖页内联脚本里的 prizes 数组，
   REAL_COUNTS 是 winning-records 接口最近 500 条记录的文案分布。
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

const REAL_COUNTS = {
    '魔力 100 ': 122, '魔力 5000 ': 67, '魔力 2000 ': 136, '魔力 1000 ': 100,
    '上传量 2 GB': 28, '彩虹 ID 7 Day(s)': 9, '上传量 5 GB': 6,
    '补签卡 1 ': 28, '魔力 780000 ': 2, '邀请 1 ': 2
};

// 「魔力」档位的憨豆总额
const REAL_BEANS = 100 * 122 + 5000 * 67 + 2000 * 136 + 1000 * 100 + 780000 * 2;

function realRecords() {
    const rows = [];
    let id = 3900000;
    for (const [result, times] of Object.entries(REAL_COUNTS)) {
        for (let i = 0; i < times; i++) {
            rows.push({ id: id++, cost_bonus: 2000, created_at: '2026-08-18 19:30', result });
        }
    }
    return rows;
}

/* 把 winning-records 分页接口 stub 掉，返回真实记录 */
function stubRecordsApi(w, rows, onServe) {
    w.fetch = async url => {
        const u = new URL(String(url), 'https://hhanclub.net');
        const start = Number(u.searchParams.get('start'));
        const length = Number(u.searchParams.get('length'));
        const slice = rows.slice(start, start + length);
        if (onServe) onServe(slice.length);
        return { ok: true, status: 200, json: async () => ({ code: 0, data: slice, recordsTotal: rows.length }) };
    };
}

/* ---------------------------------------------------------------- */
console.log('\n[9] 同步官方记录 + 官方爆率对比（线上真实夹具）');
{
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    await run(dom);
    const d = dom.window.document;

    check('线上写法「每次消耗憨豆： 2000」解析为 2,000',
        d.getElementById('single-cost').textContent === '2,000',
        d.getElementById('single-cost').textContent);

    const rows = realRecords();
    let served = 0;
    stubRecordsApi(dom.window, rows, n => { served += n; });

    d.getElementById('sync-official').click();
    await sleep(3000);

    check(`分页拉全 ${rows.length} 条记录（实际 ${served}）`, served === rows.length);

    const stats = JSON.parse(dom.window.localStorage.getItem('hhanclub_lottery_stats_v4'));
    check('抽奖次数 = 500', stats.draws === 500, `实际 ${stats.draws}`);
    check('消耗按 cost_bonus 累加 = 1,000,000', stats.cost === 1000000, `实际 ${stats.cost}`);
    check(`「魔力」档位全部归到憨豆，累计 = ${REAL_BEANS}`,
        stats.gains.beans === REAL_BEANS, `实际 ${stats.gains.beans}`);
    check('没有留下独立的 magic 类别', !stats.prizes.magic, JSON.stringify(stats.prizes.magic));
    check('憨豆中奖 427 次', stats.prizes.beans?.count === 427, `实际 ${stats.prizes.beans?.count}`);
    check('上传量累计 = 2×28 + 5×6 = 86 GB', stats.gains.upload === 86, `实际 ${stats.gains.upload}`);
    check('彩虹 ID 累计 63 天', stats.gains.rainbow === 63, `实际 ${stats.gains.rainbow}`);
    check('补签卡 28 张', stats.prizes.makeup?.count === 28, `实际 ${stats.prizes.makeup?.count}`);
    check('线上 10 种文案没有一种落进「其他奖品」',
        !stats.prizes.unknown, JSON.stringify(stats.prizes.unknown));

    // 奖池档位和接口文案必须归一化成同一个 label，否则爆率对不上号
    const tierRates = Array.from(d.querySelectorAll('#detail-list .hh-tier-rate'));
    check('档位行渲染出爆率对比', tierRates.length === 10, `实际 ${tierRates.length}`);
    check('每个档位都配到了官方爆率',
        tierRates.every(el => /官方 \d/.test(el.textContent)),
        tierRates.map(el => el.textContent).join(' | '));

    const official = Array.from(d.querySelectorAll('#detail-list .hh-row-official'));
    // 样本里 VIP 一次没中（官方爆率 0.02%），所以只有 5 个类别成行
    check('5 个中过奖的类别都显示官方爆率', official.length === 5, `实际 ${official.length}`);
    check('憨豆类别官方爆率合并为 83.0%',
        official.some(el => el.textContent === '官方 83.0%'),
        official.map(el => el.textContent).join(' | '));
    check('憨豆实测占比 85.4%',
        d.querySelector('#detail-list .hh-row-pct').textContent === '85.4%',
        d.querySelector('#detail-list .hh-row-pct').textContent);
}

/* ---------------------------------------------------------------- */
console.log('\n[10] 憨豆盈亏与理论盈亏率');
{
    const dom = makeDom({ pool: REAL_POOL, useBean: '每次消耗憨豆： 2000' });
    await run(dom);
    const d = dom.window.document;

    // 理论盈亏率只依赖奖池，没抽过也该算得出来
    const expected = 780000 * 0.0011 + 5000 * 0.1507 + 100 * 0.2261 + 2000 * 0.2261 + 1000 * 0.2261;
    const baseline = ((expected - 2000) / 2000) * 100;
    check(`未抽奖也显示理论盈亏率 ${baseline.toFixed(1)}%`,
        d.getElementById('theory-rate').textContent === `+${baseline.toFixed(1)}%`,
        d.getElementById('theory-rate').textContent);
    check('转盘是正期望的', baseline > 0, `实际 ${baseline.toFixed(2)}%`);

    stubRecordsApi(dom.window, realRecords());
    d.getElementById('sync-official').click();
    await sleep(3000);

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
    check('面板余额已本地扣掉 3 × 2000',
        d.getElementById('bean-balance').textContent === (1234567 - 6000).toLocaleString(),
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
console.log(`\n=========== ${passed} passed, ${failed} failed ===========\n`);
process.exit(failed ? 1 : 0);
