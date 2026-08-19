/**
 * 青龙版行为测试
 *
 * 起一个本地 mock 站点，把 HH_HOST 指过去，然后真的把脚本当子进程跑起来，
 * 断言它发出的请求和最后打印的汇总。抽奖接口是要花憨豆的，没法拿线上验证，
 * 所以这层测试是它唯一的安全网。
 *
 * 运行：npm run test:ql
 */
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'qinglong', 'hh_lottery.js');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

/* ---------------------------------------------------------------- */

const luckyPage = (balance, cost = 2000) => `<!doctype html><html><body>
    <div class="header-bean flex"><span class="bean-number text-[14px]">${balance}.0</span></div>
    <div class="use-bean text-center">每次消耗憨豆： ${cost}</div>
    <script>let prizes = [{"type":1001,"typeText":"\\u9b54\\u529b","amountText":"100 ","priority":99}];</script>
</body></html>`;

const loginPage = () => `<!doctype html><html><body>
    <form action="takelogin.php" method="post">
        <input name="username"><input type="password" name="password">
    </form></body></html>`;

const mailboxPage = (items, pageCount) => {
    const rows = items.map(item => `
        <div class="grid grid-cols-[10%_5%_60%_10%_15%]">
            <div class="act-checkbox"><input type="checkbox" name="messages[]" value="${item.id}"></div>
            <div><a href="messages.php?action=viewmessage&amp;id=${item.id}">${item.subject}</a></div>
            <div>系统</div>
        </div>`).join('');
    const pager = `<select onchange="switchPage(this)">${
        Array.from({ length: Math.max(1, pageCount) }, (_, n) => `<option value="${n}">${n + 1}</option>`).join('')
    }</select>`;
    return `<html><body><form method="post" action="messages.php">
        <input type="hidden" name="action" value="moveordel">${pager}${rows}</form></body></html>`;
};

/**
 * mock 站点。
 *   prizes    抽奖接口按顺序返回的中奖文案，用完循环
 *   balance   起始余额；每抽自动扣消耗、憨豆奖自动加回
 *   onDraw    每抽回调，可以自己改 state（用来模拟 VIP 换憨豆）
 *   mail      收件箱内容
 *   pageSize  收件箱每页显示多少封
 */
function startSite({ prizes = ['魔力 100 '], balance = 100000, cost = 2000, onDraw = null,
                     mail = [], pageSize = 100, loggedOut = false } = {}) {
    const state = {
        balance, cost, draws: 0, deleted: [], mailPageHits: [],
        mail: [...mail], drawn: []
    };

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = new URLSearchParams(Buffer.concat(chunks).toString());

        const send = (code, text, type = 'text/html; charset=utf-8') => {
            res.writeHead(code, { 'content-type': type });
            res.end(text);
        };

        if (loggedOut) return send(200, loginPage());

        if (url.pathname === '/lucky.php') {
            return send(200, luckyPage(state.balance, state.cost));
        }

        if (url.pathname === '/plugin/lucky-draw') {
            const text = prizes[state.draws % prizes.length];
            state.draws++;
            state.drawn.push(text);
            state.balance -= state.cost;
            if (/魔力|憨豆/.test(text)) {
                const won = Number(String(text).match(/(\d[\d,]*)/)?.[1].replace(/,/g, '')) || 0;
                state.balance += won;
            }
            onDraw?.(state, text);
            return send(200, JSON.stringify({ ret: 0, data: { prize_text: text, winning_record_id: 900 + state.draws } }),
                'application/json');
        }

        if (url.pathname === '/messages.php' && req.method === 'POST') {
            const ids = body.getAll('messages[]');
            state.deleted.push({ ids, action: body.get('action'), del: body.get('delete') });
            state.mail = state.mail.filter(item => !ids.includes(item.id));
            return send(200, '');
        }

        if (url.pathname === '/messages.php') {
            const page = Number(url.searchParams.get('page')) || 0;
            state.mailPageHits.push(page);
            const pageCount = Math.max(1, Math.ceil(state.mail.length / pageSize));
            return send(200, mailboxPage(state.mail.slice(page * pageSize, (page + 1) * pageSize), pageCount));
        }

        send(404, 'not found');
    });

    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => {
            state.origin = `http://127.0.0.1:${server.address().port}`;
            resolve({ server, state, close: () => new Promise(r => server.close(r)) });
        });
    });
}

function runScript(env) {
    return new Promise(resolve => {
        const child = spawn(process.execPath, [SCRIPT], {
            env: { ...process.env, HH_COOKIE: 'c_secure_uid=test', ...env },
            cwd: ROOT
        });

        let out = '';
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { out += d; });
        child.on('close', code => resolve({ code, out }));
    });
}

/* ---------------------------------------------------------------- */
console.log('\n[1] 填上 Cookie 就能跑：按次数抽，汇总正确');
{
    const site = await startSite({
        prizes: ['魔力 100 ', '魔力 5000 ', '\\u9b54\\u529b 1000 '],
        balance: 100000
    });

    const { code, out } = await runScript({
        HH_HOST: site.state.origin, HH_DRAWS: '3', HH_INTERVAL: '3'
    });

    check('正常退出', code === 0, `exit ${code}`);
    check('刚好抽了 3 次', site.state.draws === 3, `实际 ${site.state.draws}`);
    check('汇总里写了 3 抽', /账号 1：3 抽/.test(out), out.slice(-400));
    check('消耗算的是 3 × 2000', /消耗 6,000/.test(out), out.slice(-400));
    check('憨豆合计 100 + 5000 + 1000 = 6,100', /获得 6,100 憨豆/.test(out), out.slice(-400));
    check('盈亏 +100', /盈亏 \+100（\+1\.7%）/.test(out), out.slice(-400));
    check('\\u 转义的文案解码成了中文档位',
        /1,000 憨豆 × 1/.test(out) && !/\\u9b54/.test(out.split('─')[1] || ''), out.slice(-400));
    check('带上了 Cookie 才认', !/Cookie 已失效/.test(out));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[2] 一抽到底：抽到保留线就停');
{
    // 每抽净亏 1900，余额 30000、保留 20000 → 抽 5 次后剩 20500，
    // 再抽一次会跌到 18600 < 20000，所以停在 5 抽
    const site = await startSite({ prizes: ['魔力 100 '], balance: 30000 });

    const { out } = await runScript({
        HH_HOST: site.state.origin, HH_DRAWS: '0', HH_RESERVE: '20000', HH_INTERVAL: '3'
    });

    check('抽了 5 次就停', site.state.draws === 5, `实际 ${site.state.draws}`);
    check('日志说明是按保留线停的', /一抽到底完成/.test(out), out.slice(-500));
    check('余额守在保留线之上', site.state.balance >= 20000, `实际 ${site.state.balance}`);
}

/* ---------------------------------------------------------------- */
console.log('\n[3] 已是 VIP 时站点改发憨豆，要按憨豆记账');
{
    const site = await startSite({
        prizes: ['VIP 7 Day(s)'],
        balance: 500000,
        // 服务端在发奖时把 VIP 换成 1,000,000 憨豆
        onDraw: state => { state.balance += 1000000; }
    });

    const { out } = await runScript({
        HH_HOST: site.state.origin, HH_DRAWS: '1', HH_INTERVAL: '3'
    });

    check('识别出了换发', /已是 VIP，站点改发 1,000,000 憨豆/.test(out), out.slice(-500));
    check('憨豆记了 1,000,000', /获得 1,000,000 憨豆/.test(out), out.slice(-500));
    check('档位记成憨豆而不是 VIP 天数',
        /1,000,000 憨豆 × 1/.test(out) && !/7 天 × 1/.test(out), out.slice(-500));
    check('抽数还是 1', site.state.draws === 1, `实际 ${site.state.draws}`);

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[4] 不是 VIP 的用户中 VIP，照常记 VIP 天数');
{
    const site = await startSite({ prizes: ['VIP 7 Day(s)'], balance: 500000 });

    const { out } = await runScript({
        HH_HOST: site.state.origin, HH_DRAWS: '1', HH_INTERVAL: '3'
    });

    check('不会误报换发', !/站点改发/.test(out), out.slice(-500));
    check('记的是 VIP 7 天', /7 天 × 1/.test(out), out.slice(-500));
    check('其他奖里列出了 VIP', /VIP 7天/.test(out), out.slice(-500));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[5] 站内信清理：每页只有 10 封也要翻完，别的信一封不碰');
{
    const KEEP = [
        { id: '9001', subject: '种子被删除' },
        { id: '9002', subject: '憨豆 改变' }
    ];
    const mail = [
        ...Array.from({ length: 34 }, (_, i) => ({ id: String(1000 + i), subject: '幸运大转盘 中奖通知' })),
        ...KEEP
    ];

    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000, mail, pageSize: 10 });

    const { out } = await runScript({
        HH_HOST: site.state.origin, HH_DRAWS: '1', HH_INTERVAL: '3', HH_CLEAN_MAIL: 'true'
    });

    const deletedIds = site.state.deleted.flatMap(item => item.ids);

    check('34 封抽奖通知全清了', deletedIds.length === 34, `实际 ${deletedIds.length}`);
    check('翻页翻到了第 4 页，不是只翻第一页',
        site.state.mailPageHits.includes(3), site.state.mailPageHits.join(','));
    check('两封该留的还在',
        site.state.mail.length === 2 && KEEP.every(k => !deletedIds.includes(k.id)),
        site.state.mail.map(m => m.subject).join(' | '));
    check('提交的是 action=moveordel + delete',
        site.state.deleted.every(item => item.action === 'moveordel' && item.del === '删除'),
        JSON.stringify(site.state.deleted.map(i => [i.action, i.del])));
    check('日志报了清理结果', /清掉 34 封抽奖通知/.test(out), out.slice(-500));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[6] 不开清理开关就完全不碰收件箱');
{
    const site = await startSite({
        prizes: ['魔力 100 '], balance: 100000,
        mail: [{ id: '1', subject: '幸运大转盘 中奖通知' }]
    });

    await runScript({ HH_HOST: site.state.origin, HH_DRAWS: '1', HH_INTERVAL: '3' });

    check('一次收件箱都没读', site.state.mailPageHits.length === 0, site.state.mailPageHits.join(','));
    check('一封都没删', site.state.deleted.length === 0, JSON.stringify(site.state.deleted));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[7] Cookie 失效要说人话，别闷头抽');
{
    const site = await startSite({ loggedOut: true });

    const { out } = await runScript({
        HH_HOST: site.state.origin, HH_DRAWS: '5', HH_INTERVAL: '3'
    });

    check('点出了 Cookie 失效', /Cookie 已失效/.test(out), out.slice(-500));
    check('一次都没抽', site.state.draws === 0, `实际 ${site.state.draws}`);

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[8] 没填 Cookie 直接报错退出');
{
    const { code, out } = await runScript({ HH_COOKIE: '' });

    check('非零退出码', code === 1, `exit ${code}`);
    check('提示去哪儿填', /HH_COOKIE/.test(out), out.slice(-300));
}

/* ---------------------------------------------------------------- */
console.log('\n[9] 多账号按顺序各跑各的');
{
    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000 });

    const { out } = await runScript({
        HH_HOST: site.state.origin,
        HH_COOKIE: 'c_secure_uid=aaa&c_secure_uid=bbb',
        HH_DRAWS: '2', HH_INTERVAL: '3', HH_ACCOUNT_GAP: '0'
    });

    check('两个账号一共抽了 4 次', site.state.draws === 4, `实际 ${site.state.draws}`);
    check('汇总里两个账号都在',
        /账号 1：2 抽/.test(out) && /账号 2：2 抽/.test(out), out.slice(-600));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[10] 站点跟着改单抽消耗');
{
    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000, cost: 4000 });

    const { out } = await runScript({
        HH_HOST: site.state.origin, HH_DRAWS: '2', HH_INTERVAL: '3'
    });

    check('单抽消耗按页面上的 4,000 算', /消耗 8,000/.test(out), out.slice(-400));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log(`\n=========== ${passed} passed, ${failed} failed ===========\n`);
process.exit(failed ? 1 : 0);
