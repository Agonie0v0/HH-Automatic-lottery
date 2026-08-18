/**
 * HHCLUB 自动抽奖 · 庆典版 —— 行为测试
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

function makeDom({ legacy = null } = {}) {
    const dom = new JSDOM(`<!doctype html><html><body>
        <div class="use-bean">每次消耗 2,000 憨豆</div>
        <div class="bean-number">1,234,567</div>
    </body></html>`, { url: 'https://hhanclub.net/lucky.php', runScripts: 'outside-only' });

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

/* ---------------------------------------------------------------- */
console.log(`\n=========== ${passed} passed, ${failed} failed ===========\n`);
process.exit(failed ? 1 : 0);
