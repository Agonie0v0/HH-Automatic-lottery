/**
 * 青龙版行为测试
 *
 * 起一个本地 mock 站点，复制一份脚本、把顶部配置区整块换掉指过去，
 * 再当子进程真跑一遍 —— 和用户实际的用法一致。
 * 断言它发出的请求和最后打印的汇总。抽奖接口是要花憨豆的，没法拿线上验证，
 * 所以这层测试是它唯一的安全网。
 *
 * 运行：npm run test:ql
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'qinglong', 'hh_lottery.js');
// git 的 autocrlf 可能把脚本换成 CRLF，统一成 LF 再找标记
// git 的 autocrlf 可能把脚本换成 CRLF，统一成 LF 再找标记
const SOURCE = fs.readFileSync(SCRIPT, 'utf8').replace(/\r\n/g, '\n');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-ql-'));

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

/* 配置写在脚本顶部，所以测试就照用户的方式来：
   复制一份源码、把「配置区」整块换掉，再当子进程跑。
   顺带也就验证了那两个标记还在、配置块还能被整块替换。 */
let copyIndex = 0;
function runScript(config) {
    const head = 'const CONFIG = {';
    const foot = '\n};\n\n/* ===== 配置区结束 ===== */';

    const start = SOURCE.indexOf(head);
    const end = SOURCE.indexOf(foot);
    if (start < 0 || end < 0) throw new Error('配置区标记不见了，测试没法注入配置');

    const merged = {
        cookie: 'c_secure_uid=test',
        statsFile: '',
        draws: 10,
        reserve: 0,
        interval: 3,
        maxMinutes: 60,
        cleanMail: false,
        host: 'hhanclub.net',
        timezone: 'Asia/Shanghai',
        userAgent: 'test-agent',
        ...config
    };

    const patched = SOURCE.slice(0, start)
        + `const CONFIG = ${JSON.stringify(merged, null, 4)};`
        + SOURCE.slice(end + foot.length - '\n\n/* ===== 配置区结束 ===== */'.length);

    const file = path.join(TMP, `run-${copyIndex++}.js`);
    fs.writeFileSync(file, patched);

    return new Promise(resolve => {
        const child = spawn(process.execPath, [file], { cwd: ROOT });

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

    const { code, out } = await runScript({ host: site.state.origin, draws: 3 });

    check('正常退出', code === 0, `exit ${code}`);
    check('刚好抽了 3 次', site.state.draws === 3, `实际 ${site.state.draws}`);
    check('汇总里写了 3 抽', /本次：3 抽/.test(out), out.slice(-400));
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

    const { out } = await runScript({ host: site.state.origin, draws: 0, reserve: 20000 });

    check('抽了 5 次就停', site.state.draws === 5, `实际 ${site.state.draws}`);
    check('日志说明是按保留线停的', /一抽到底完成/.test(out), out.slice(-500));
    check('余额守在保留线之上', site.state.balance >= 20000, `实际 ${site.state.balance}`);
}

/* ---------------------------------------------------------------- */
console.log('\n[3] 已是 VIP 时站点改发憨豆：憨豆照记，但仍算一次 VIP 中奖');
{
    const site = await startSite({
        prizes: ['VIP 7 Day(s)'],
        balance: 500000,
        // 服务端在发奖时把 VIP 换成 1,000,000 憨豆
        onDraw: state => { state.balance += 1000000; }
    });

    const { out } = await runScript({ host: site.state.origin, draws: 1 });

    check('识别出了换发',
        /已经是 VIP，站点改发了 1,000,000 憨豆 · 仍计为一次 VIP 中奖/.test(out), out.slice(-500));
    check('憨豆记了 1,000,000', /获得 1,000,000 憨豆/.test(out), out.slice(-500));
    check('档位换成「已转换为憨豆」，不再是 7 天',
        /已转换为憨豆 1,000,000 × 1/.test(out) && !/7 天 × 1/.test(out), out.slice(-500));
    check('汇总里单列了折算的憨豆',
        /折算：VIP 折算 1,000,000 憨豆/.test(out), out.slice(-500));
    check('抽数还是 1', site.state.draws === 1, `实际 ${site.state.draws}`);

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[4] 不是 VIP 的用户中 VIP，照常记 VIP 天数');
{
    const site = await startSite({ prizes: ['VIP 7 Day(s)'], balance: 500000 });

    const { out } = await runScript({ host: site.state.origin, draws: 1 });

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

    const { out } = await runScript({ host: site.state.origin, draws: 1, cleanMail: true });

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

    await runScript({ host: site.state.origin, draws: 1 });

    check('一次收件箱都没读', site.state.mailPageHits.length === 0, site.state.mailPageHits.join(','));
    check('一封都没删', site.state.deleted.length === 0, JSON.stringify(site.state.deleted));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[7] Cookie 失效要说人话，别闷头抽');
{
    const site = await startSite({ loggedOut: true });

    const { out } = await runScript({ host: site.state.origin, draws: 5 });

    check('点出了 Cookie 失效', /Cookie 已失效/.test(out), out.slice(-500));
    check('一次都没抽', site.state.draws === 0, `实际 ${site.state.draws}`);

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[8] 没填 Cookie（还是占位文字）直接报错退出');
{
    const { code, out } = await runScript({ cookie: '在这里粘贴你的 Cookie' });

    check('非零退出码', code === 1, `exit ${code}`);
    check('占位文字不会被当成真 Cookie', /还没填 Cookie/.test(out), out.slice(-300));
    check('提示了去哪儿填', /配置区/.test(out) && /F12/.test(out), out.slice(-300));
}

/* ---------------------------------------------------------------- */
console.log('\n[9] 站点跟着改单抽消耗');
{
    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000, cost: 4000 });

    const { out } = await runScript({ host: site.state.origin, draws: 2 });

    check('单抽消耗按页面上的 4,000 算', /消耗 8,000/.test(out), out.slice(-400));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[10] 统计导出：格式和油猴版备份一模一样');
{
    const site = await startSite({
        prizes: ['魔力 100 ', '补签卡 1 ', '魔力 100 '],
        balance: 100000
    });
    const statsFile = path.join(TMP, 'stats-format.json');

    await runScript({ host: site.state.origin, draws: 3, statsFile });

    const payload = JSON.parse(fs.readFileSync(statsFile, 'utf8'));

    check('外层是备份文件的信封', payload.kind === 'hhclub-lottery-backup' && payload.version === 4,
        JSON.stringify({ kind: payload.kind, version: payload.version }));
    check('带 current 和 total 两份', !!payload.current && !!payload.total);
    check('标了来源是青龙', payload.source === 'qinglong', payload.source);

    const t = payload.total;
    check('抽数 / 消耗对得上', t.draws === 3 && t.cost === 6000, `${t.draws} 抽 / ${t.cost}`);
    check('gains 八个字段齐全',
        ['beans', 'magic', 'invite', 'rainbow', 'vip', 'makeup', 'upload', 'rename']
            .every(k => typeof t.gains[k] === 'number'),
        JSON.stringify(t.gains));
    check('憨豆合计 200', t.gains.beans === 200, `实际 ${t.gains.beans}`);
    check('补签卡 1 个', t.gains.makeup === 1, `实际 ${t.gains.makeup}`);
    check('prizes 是「类别 → { count, value, tiers }」',
        t.prizes.beans?.count === 2 && t.prizes.beans?.value === 200
        && t.prizes.beans?.tiers['100 憨豆'] === 2,
        JSON.stringify(t.prizes));
    check('档位名和油猴版一致（100 憨豆 / 1 个）',
        Object.keys(t.prizes.makeup.tiers)[0] === '1 个',
        Object.keys(t.prizes.makeup.tiers).join(' | '));
    check('raw 保留原始文案且已 trim',
        t.raw['魔力 100'] === 2 && t.raw['补签卡 1'] === 1, JSON.stringify(t.raw));
    check('带上了首末时间戳', typeof t.firstAt === 'number' && typeof t.lastAt === 'number',
        `${t.firstAt} / ${t.lastAt}`);
    check('日志里给出了文件路径', true);

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[11] 跨次运行累计：total 累加，current 只记本次');
{
    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000 });
    const statsFile = path.join(TMP, 'stats-accumulate.json');

    await runScript({ host: site.state.origin, draws: 3, statsFile });
    const { out } = await runScript({ host: site.state.origin, draws: 2, statsFile });

    const payload = JSON.parse(fs.readFileSync(statsFile, 'utf8'));

    check('total 累到 5 抽', payload.total.draws === 5, `实际 ${payload.total.draws}`);
    check('total 消耗累到 10,000', payload.total.cost === 10000, `实际 ${payload.total.cost}`);
    check('current 只记这一次的 2 抽', payload.current.draws === 2, `实际 ${payload.current.draws}`);
    check('档位次数也在累加', payload.total.prizes.beans.tiers['100 憨豆'] === 5,
        JSON.stringify(payload.total.prizes.beans.tiers));
    check('汇总里同时报了本次和历史总计',
        /本次：2 抽/.test(out) && /历史总计：5 抽/.test(out), out.slice(-600));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[12] VIP 折算要落进导出的统计里');
{
    const site = await startSite({
        prizes: ['VIP 7 Day(s)'],
        balance: 500000,
        onDraw: state => { state.balance += 1000000; }
    });
    const statsFile = path.join(TMP, 'stats-vip.json');

    await runScript({ host: site.state.origin, draws: 1, statsFile });

    const t = JSON.parse(fs.readFileSync(statsFile, 'utf8')).total;

    check('憨豆记了 1,000,000', t.gains.beans === 1000000, `实际 ${t.gains.beans}`);
    check('VIP 天数被扣回去了（没真拿到）', !t.gains.vip, `实际 ${t.gains.vip}`);
    check('仍然算一次 VIP 中奖，爆率统计不少这一笔',
        t.prizes.vip?.count === 1, JSON.stringify(t.prizes.vip));
    check('没有凭空多出一个憨豆类别的中奖', !t.prizes.beans, JSON.stringify(t.prizes.beans));
    check('VIP 档位换成「已转换为憨豆 1,000,000」',
        Object.keys(t.prizes.vip.tiers).join() === '已转换为憨豆 1,000,000',
        Object.keys(t.prizes.vip.tiers).join(' | '));
    check('折算的憨豆单独记在 swappedBeans 上（天数和憨豆不是一个单位）',
        t.prizes.vip.swappedBeans === 1000000 && t.prizes.vip.value === 0,
        `swappedBeans=${t.prizes.vip.swappedBeans} value=${t.prizes.vip.value}`);
    check('原始文案照实保留 VIP', t.raw['VIP 7 Day(s)'] === 1, JSON.stringify(t.raw));
    check('抽数和消耗没被重复计', t.draws === 1 && t.cost === 2000, `${t.draws} 抽 / ${t.cost}`);

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[13] 统计文件坏了不能把这次的成绩带走');
{
    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000 });
    const statsFile = path.join(TMP, 'stats-broken.json');
    fs.writeFileSync(statsFile, '{ 这不是合法 JSON');

    const { out } = await runScript({ host: site.state.origin, draws: 2, statsFile });

    check('提示了文件读不出来', /统计文件读不出来/.test(out), out.slice(-600));
    check('这次的 2 抽照样存下来了',
        JSON.parse(fs.readFileSync(statsFile, 'utf8')).total.draws === 2,
        fs.readFileSync(statsFile, 'utf8').slice(0, 120));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[14] statsFile 留空就不落文件');
{
    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000 });
    const before = fs.readdirSync(TMP).filter(f => f.startsWith('stats-')).length;

    const { out } = await runScript({ host: site.state.origin, draws: 1, statsFile: '' });

    const after = fs.readdirSync(TMP).filter(f => f.startsWith('stats-')).length;
    check('没多出统计文件', after === before, `${before} → ${after}`);
    check('也不会提示存到哪儿', !/统计已存到/.test(out), out.slice(-400));
    check('汇总照常打印', /本次：1 抽/.test(out), out.slice(-400));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[15] 折算的憨豆跨次运行不能丢');
{
    // 第一次中 VIP 被折算，第二次正常抽 —— 读回来时 swappedBeans 得还在
    let drawn = 0;
    const site = await startSite({
        prizes: ['VIP 7 Day(s)'],
        balance: 500000,
        onDraw: state => { if (++drawn === 1) state.balance += 1000000; }
    });
    const statsFile = path.join(TMP, 'stats-swap-keep.json');

    await runScript({ host: site.state.origin, draws: 1, statsFile });

    site.state.prizes = null;   // 后面这次换成普通奖
    await site.close();

    const site2 = await startSite({ prizes: ['魔力 100 '], balance: 500000 });
    const { out } = await runScript({ host: site2.state.origin, draws: 1, statsFile });

    const t = JSON.parse(fs.readFileSync(statsFile, 'utf8')).total;

    check('两次累计 2 抽', t.draws === 2, `实际 ${t.draws}`);
    check('折算的 1,000,000 还在 swappedBeans 上',
        t.prizes.vip?.swappedBeans === 1000000, JSON.stringify(t.prizes.vip));
    check('憨豆总数 = 折算 1,000,000 + 这次 100',
        t.gains.beans === 1000100, `实际 ${t.gains.beans}`);
    check('VIP 中奖次数还是 1', t.prizes.vip?.count === 1, JSON.stringify(t.prizes.vip));
    check('历史总计里也报了折算',
        /折算：VIP 折算 1,000,000 憨豆/.test(out), out.slice(-700));

    await site2.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[16] 日志带时间戳，汇总块不带');
{
    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000 });

    const { out } = await runScript({ host: site.state.origin, draws: 2 });

    const [before, after] = out.split('─'.repeat(40));
    const logLines = before.split('\n').filter(line => line.trim());

    check('日志每一行都带 [MM/DD HH:MM:SS]',
        logLines.every(line => /^\[\d\d\/\d\d \d\d:\d\d:\d\d\] /.test(line)),
        logLines.find(line => !/^\[\d\d\/\d\d \d\d:\d\d:\d\d\] /.test(line)));
    check('抽奖那几行也带上了', logLines.some(line => /\] 🎲 第 1 抽/.test(line)),
        logLines.join(' | ').slice(0, 200));
    check('汇总块不套时间戳，免得没法看',
        (after || '').split('\n').filter(l => l.trim()).every(line => !/^\[\d\d\/\d\d/.test(line)),
        (after || '').slice(0, 200));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[17] 时区按配置走 —— 容器里多半是 UTC，不设就对不上');
{
    const site = await startSite({ prizes: ['魔力 100 '], balance: 100000 });

    const hourOf = out => {
        const match = out.match(/^\[\d\d\/\d\d (\d\d):\d\d:\d\d\]/m);
        return match ? Number(match[1]) : null;
    };

    const utc = await runScript({ host: site.state.origin, draws: 1, timezone: 'UTC' });
    const shanghai = await runScript({ host: site.state.origin, draws: 1, timezone: 'Asia/Shanghai' });

    const a = hourOf(utc.out);
    const b = hourOf(shanghai.out);

    check('两种时区都打出了时间', a !== null && b !== null, `${a} / ${b}`);
    check('上海比 UTC 快 8 小时', ((b - a) + 24) % 24 === 8, `UTC ${a} 时 / 上海 ${b} 时`);

    const bad = await runScript({ host: site.state.origin, draws: 1, timezone: '瞎写的时区' });
    check('时区写错不会崩，退回 ISO 格式',
        /^\[\d\d-\d\d \d\d:\d\d:\d\d\] /m.test(bad.out), bad.out.slice(0, 200));

    await site.close();
}

/* ---------------------------------------------------------------- */
console.log('\n[18] 在仓库里直接 node qinglong/hh_lottery.js 也能跑');
{
    // 仓库根目录的 package.json 是 type:module，会把这个目录下的 .js
    // 当 ESM 解析，直接跑就崩在 require 上 —— qinglong/package.json 钉回
    // commonjs 才行。这条就是防它被误删。
    const { code, out } = await new Promise(resolve => {
        const child = spawn(process.execPath, [SCRIPT], { cwd: ROOT });
        let text = '';
        child.stdout.on('data', d => { text += d; });
        child.stderr.on('data', d => { text += d; });
        child.on('close', c => resolve({ code: c, out: text }));
    });

    check('不会因为 type:module 崩掉',
        !/require is not defined|ERR_REQUIRE_ESM/.test(out), out.slice(0, 300));
    check('走到了「还没填 Cookie」这一步', /还没填 Cookie/.test(out), out.slice(0, 300));
    check('退出码是 1', code === 1, `exit ${code}`);
}

/* ---------------------------------------------------------------- */
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n=========== ${passed} passed, ${failed} failed ===========\n`);
process.exit(failed ? 1 : 0);
