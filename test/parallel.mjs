/**
 * 把 lottery.test.mjs 切成几片并行跑。
 *
 * 用例块之间没有共享状态 —— 每块自己 makeDom()，自己的 window 和
 * localStorage，所以按块切开分给几个进程跑，结果和顺序跑一模一样。
 *
 * 之所以值得这么干：套件用的是真实计时器（[50]~[57] 那批节奏用例
 * 要量出「实际等了几毫秒」，换成假计时器就测不了了），一个用例动辄
 * 等十几秒，顺序跑要八到十分钟，其中 99% 的时间是在 setTimeout 里干等。
 *
 * 用法：
 *   node test/parallel.mjs            # 默认 4 片
 *   node test/parallel.mjs --shards=6
 *   node test/parallel.mjs --seq      # 退回顺序跑，用来比对
 *
 * 每块的真实耗时会记在 test/.timings.json，下次据此做贪心装箱，
 * 越跑越均衡。删掉那个文件就退回轮转分配。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITE = path.join(HERE, 'lottery.test.mjs');
const TIMINGS = path.join(HERE, '.timings.json');

const args = process.argv.slice(2);
const shardCount = Number((args.find(a => a.startsWith('--shards=')) || '').split('=')[1]) || 4;
const sequential = args.includes('--seq');

/* ---------------------------------------------------------------- */
/* 切块                                                              */

const SEPARATOR = /^\/\* -{10,} \*\/$/;
const CASE_START = /^console\.log\('\\n\[/;

/* 两段分隔线之间不一定只有一个用例 —— 夹具（REAL_POOL、makeMailbox
   这些）就散落在用例的前后，后面的用例还要用。所以每段再拆一次：
   `console.log('\n[N] …')` 加紧跟的那个顶格大括号块是用例本身，
   其余都是公共代码，得原样发给每一片。 */
function splitSuite(source) {
    const lines = source.split('\n');
    const marks = [];
    lines.forEach((line, i) => {
        if (SEPARATOR.test(line.trim())) marks.push(i);
    });
    if (marks.length < 2) throw new Error('认不出用例块的分隔线，套件结构变了？');

    const header = lines.slice(0, marks[0]).join('\n');
    // 最后一段是汇总输出，不是用例
    const footer = lines.slice(marks[marks.length - 1]).join('\n');

    const blocks = [];
    const shared = [];

    for (let i = 0; i < marks.length - 1; i++) {
        const segment = lines.slice(marks[i], marks[i + 1]);
        const caseAt = segment.findIndex(line => CASE_START.test(line));

        if (caseAt < 0) {
            shared.push(segment.join('\n'));
            continue;
        }

        // 用例主体是顶格的 `{` … `}`，中间的缩进行不会误判
        const open = segment.findIndex((line, j) => j > caseAt && line.trim() === '{');
        const close = open < 0 ? -1 : segment.findIndex((line, j) => j > open && line === '}');
        if (open < 0 || close < 0) throw new Error(`第 ${i + 1} 段用例的大括号对不上`);

        const before = segment.slice(1, caseAt).join('\n').trim();
        const after = segment.slice(close + 1).join('\n').trim();
        if (before) shared.push(before);
        if (after) shared.push(after);

        blocks.push(segment.slice(caseAt, close + 1).join('\n'));
    }

    return { header, blocks, footer, shared: shared.join('\n\n') };
}

/* ---------------------------------------------------------------- */
/* 分配：有历史耗时就贪心装箱，没有就轮转                              */

function assign(blocks, count) {
    let timings = {};
    try {
        timings = JSON.parse(fs.readFileSync(TIMINGS, 'utf8'));
    } catch { /* 首次运行，没有历史 */ }

    const shards = Array.from({ length: count }, () => ({ load: 0, indexes: [] }));
    const order = blocks.map((_, i) => i);

    if (Object.keys(timings).length) {
        // 长的先放，短的填缝 —— 经典的最长处理时间优先
        order.sort((a, b) => (timings[b] || 0) - (timings[a] || 0));
    }

    order.forEach(index => {
        const target = shards.reduce((min, s) => (s.load < min.load ? s : min), shards[0]);
        target.indexes.push(index);
        target.load += timings[index] || 1000;
    });

    // 片内恢复原顺序，输出好读
    shards.forEach(s => s.indexes.sort((a, b) => a - b));
    return shards;
}

/* ---------------------------------------------------------------- */
/* 生成分片文件                                                      */

function writeShard(id, header, shared, footer, blocks, indexes) {
    // 分片文件必须放在 test/ 下：套件靠 dirname(dirname(import.meta.url))
    // 算项目根，换个目录层级就找不到脚本和 node_modules 了
    const file = path.join(HERE, `.shard-${id}.mjs`);
    const body = indexes.map(index =>
        `${blocks[index]}\nconsole.log(\`##BLOCK ${index} \${Date.now() - __blockAt}\`);\n__blockAt = Date.now();\n`
    ).join('');

    fs.writeFileSync(file,
        `${header}\n${shared}\nlet __blockAt = Date.now();\n${body}${footer}\n`, 'utf8');
    return file;
}

/* ---------------------------------------------------------------- */

function runNode(file) {
    return new Promise(resolve => {
        const child = spawn(process.execPath, [file], { cwd: path.dirname(HERE) });
        let out = '';
        child.stdout.on('data', chunk => { out += chunk; });
        child.stderr.on('data', chunk => { out += chunk; });
        child.on('close', code => resolve({ out, code }));
    });
}

/* 把 ##BLOCK 标记摘出来，剩下的才是给人看的输出 */
function harvest(out) {
    const timings = {};
    const lines = [];
    out.split('\n').forEach(line => {
        const match = line.match(/^##BLOCK (\d+) (\d+)$/);
        if (match) timings[match[1]] = Number(match[2]);
        else lines.push(line);
    });
    return { timings, text: lines.join('\n') };
}

const started = Date.now();

if (sequential) {
    const { code } = await runNode(SUITE).then(r => (process.stdout.write(r.out), r));
    console.log(`\n顺序跑完，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
    process.exit(code);
}

const source = fs.readFileSync(SUITE, 'utf8').replace(/\r\n/g, '\n');
const { header, blocks, footer, shared } = splitSuite(source);
const shards = assign(blocks, Math.min(shardCount, blocks.length));

console.log(`切成 ${shards.length} 片跑 ${blocks.length} 个用例块`
    + `（每片 ${shards.map(s => s.indexes.length).join(' / ')} 块）\n`);

const files = shards.map((shard, i) => writeShard(i + 1, header, shared, footer, blocks, shard.indexes));
const results = await Promise.all(files.map(runNode));

let passed = 0, failed = 0;
const timings = {};

results.forEach(({ out }, i) => {
    const harvested = harvest(out);
    Object.assign(timings, harvested.timings);

    const tally = harvested.text.match(/=+\s*(\d+) passed, (\d+) failed\s*=+/);
    if (tally) {
        passed += Number(tally[1]);
        failed += Number(tally[2]);
    } else {
        // 分片整个崩了 —— 原样打出来，别让它悄悄消失
        failed += 1;
        console.log(`\n💥 第 ${i + 1} 片没跑出结果：\n${harvested.text}`);
        return;
    }

    // 汇总行由这里统一打，分片自己那行去掉
    console.log(harvested.text.replace(/\n?=+\s*\d+ passed, \d+ failed\s*=+\n?/, ''));
});

files.forEach(file => { try { fs.unlinkSync(file); } catch { /* 已经没了 */ } });
try {
    fs.writeFileSync(TIMINGS, JSON.stringify(timings), 'utf8');
} catch { /* 记不下就下次轮转分配，不影响结果 */ }

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n=========== ${passed} passed, ${failed} failed · ${seconds}s ===========\n`);
process.exit(failed ? 1 : 0);
