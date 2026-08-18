// ==UserScript==
// @name         HHCLUB 自动抽奖 · 情绪价值拉满版
// @namespace    http://tampermonkey.net/
// @version      1.8.1
// @description  HHCLUB 自动抽奖增强版 · 分奖项中奖次数统计 · 官方爆率对比 · 一抽到底 · 实时余额
// @author       Timqaq, JIEDIAO
// @match        https://hhanclub.net/lucky.php
// @grant        none
// @homepageURL  https://github.com/SAGIRIxr/HH-Automatic-lottery
// @supportURL   https://github.com/SAGIRIxr/HH-Automatic-lottery/issues
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    /* =========================================================
       基础配置
    ========================================================= */

    const SITE_ORIGIN = 'https://hhanclub.net';
    const LOTTERY_PAGE = `${SITE_ORIGIN}/lucky.php`;
    const LOTTERY_API = `${SITE_ORIGIN}/plugin/lucky-draw`;

    const STATS_KEY = 'hhanclub_lottery_stats_v4';
    const LEGACY_STATS_KEY = 'hhanclub_lottery_stats_v3';
    const SETTINGS_KEY = 'hhanclub_lottery_settings_v1';

    const CONFIG = {
        // 抽奖间隔允许范围（秒）
        minInterval: 3,
        maxInterval: 300,
        // 被限流时的退避策略
        backoffAfterErrors: 3,
        backoffFactor: 1.5,
        maxBackoffMs: 30000,
        // 请求节奏抖动比例，避免固定频率特征
        jitterRatio: 0.15,
        // 连续失败多少次后自动停止，避免接口异常时无限重试
        maxConsecutiveErrors: 5,
        // 连续被限流多少次后放弃，避免退避到上限后一直空转
        maxRateLimitRetries: 12,
        // 日志保留条数
        logLimit: 50,
        // 官方爆率低于这个值的奖品算大奖，走全屏庆祝。
        // 现奖池里够格的是 VIP（0.02%）和 780,000 憨豆（0.11%），
        // 邀请（0.38%）刚好不算 —— 大奖太廉价就不叫大奖了。
        jackpotMaxRate: 0.002,
        // 读不到奖池时的兜底判定：VIP，或单笔十万以上的憨豆
        jackpotBeansFloor: 100000,
        // 每抽多少次回服务端校准一次余额，纠正本地估算的累计漂移
        balanceSyncEveryDraws: 25
    };

    /* 奖项分类元数据：决定明细列表的图标 / 名称 / 单位 */
    /* 站点奖池里 type 1001 的 typeText 写作「魔力」，但它的图标是 bean_icon，
       消耗侧也叫憨豆 —— 那就是同一种货币，NexusPHP 的默认叫法没改干净。
       所以魔力一律归到 beans。magic 只为兼容早期版本存下来的数据保留。 */
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

    const PRIZE_ORDER = ['beans', 'magic', 'invite', 'rainbow', 'vip', 'makeup', 'upload', 'rename', 'unknown'];

    /* =========================================================
       运行时状态
    ========================================================= */

    let singleCost = 2000;
    let beanBalance = 0;
    let domBalanceSeen = null;
    let domCostSeen = null;
    let running = false;
    // 限流和接口错误分开计数：以前共用一个计数器，几次限流叠上一两次网络抖动
    // 就会凑够 maxConsecutiveErrors 被误判成接口异常而提前停机。
    let errorStreak = 0;
    let rateLimitStreak = 0;
    let dynamicInterval = 7000;
    let roundStartDraws = 0;
    let sleepTimer = null;
    let sleepResolve = null;
    // 距上次服务端校准过了多少抽，用来决定什么时候再校准一次
    let drawsSinceCalibration = 0;
    let calibrating = false;

    let settings = {
        interval: 7,
        maxCount: 10,
        viewMode: 'current',
        animation: true,
        detailOpen: 'none',
        drainMode: false,
        reserveBeans: 0,
        panelLeft: null,
        panelTop: null
    };

    let currentStats = emptyStats();
    let totalStats = emptyStats();

    /* =========================================================
       小工具
    ========================================================= */

    const $ = id => document.getElementById(id);

    function setText(id, value) {
        const element = $(id);
        if (element) element.textContent = value;
    }

    function on(id, event, handler) {
        const element = $(id);
        if (element) element.addEventListener(event, handler);
    }

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    /* 数字格式化：整数加千分位，小数最多保留两位 */
    function fmt(value) {
        const number = Number(value) || 0;
        return Number.isInteger(number)
            ? number.toLocaleString()
            : number.toLocaleString(undefined, { maximumFractionDigits: 2 });
    }

    /* 从文本里取第一个数字，兼容 "1,000" 这种千分位写法 */
    function firstNumber(text) {
        const match = String(text).match(/(\d[\d,]*(?:\.\d+)?)/);
        return match ? parseFloat(match[1].replace(/,/g, '')) : null;
    }

    function decodeUnicode(str) {
        if (typeof str !== 'string') return str;
        try {
            return str.replace(/\\u[\dA-F]{4}/gi, match =>
                String.fromCharCode(parseInt(match.replace(/\\u/g, ''), 16))
            );
        } catch (error) {
            return str;
        }
    }

    /* 可中断的等待：停止抽奖时立刻唤醒，不用等满一个间隔 */
    function sleep(ms) {
        return new Promise(resolve => {
            sleepResolve = resolve;
            sleepTimer = setTimeout(() => {
                sleepTimer = null;
                sleepResolve = null;
                resolve();
            }, ms);
        });
    }

    function cancelSleep() {
        if (sleepTimer) {
            clearTimeout(sleepTimer);
            sleepTimer = null;
        }
        if (sleepResolve) {
            const resolve = sleepResolve;
            sleepResolve = null;
            resolve();
        }
    }

    /* =========================================================
       统计数据结构

       current 与 total 完全同构，渲染逻辑只需要写一份：
         draws  抽奖次数
         cost   累计消耗憨豆
         gains  各类奖品累计数值
         prizes 分奖项统计 { 类别: { count, value, tiers: { 档位: 次数 } } }
         raw    原始奖品文案计数，站点改文案时作为兜底
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

        // 早期版本把魔力当成独立奖项存过，这里合回 beans，
        // 免得同一种憨豆在明细里split成两行、盈亏还少算一半。
        Object.entries(data.prizes || {}).forEach(([type, bucket]) => {
            const target = type === 'magic' ? 'beans' : type;
            const merged = ensureBucket(stats, target);
            merged.count += Number(bucket?.count) || 0;
            merged.value += Number(bucket?.value) || 0;
            Object.entries(bucket?.tiers || {}).forEach(([label, count]) => {
                merged.tiers[label] = (merged.tiers[label] || 0) + (Number(count) || 0);
            });
        });

        stats.raw = { ...(data.raw || {}) };
        return stats;
    }

    function saveStats(stats) {
        try {
            localStorage.setItem(STATS_KEY, JSON.stringify(stats));
        } catch (error) {
            console.error('HHCLUB 保存统计失败:', error);
        }
    }

    function loadStats() {
        try {
            const raw = localStorage.getItem(STATS_KEY);
            if (raw) return normalizeStats(JSON.parse(raw));

            const migrated = migrateLegacyStats();
            if (migrated) {
                saveStats(migrated);
                return migrated;
            }
        } catch (error) {
            console.error('HHCLUB 读取统计失败:', error);
        }
        return emptyStats();
    }

    /* 把 v3 的历史数据迁移过来，原有累计值一条都不丢。
       v3 的 totalPrizeStats 是「原始文案 → 次数」，正好能重建分奖项统计。 */
    function migrateLegacyStats() {
        const raw = localStorage.getItem(LEGACY_STATS_KEY);
        if (!raw) return null;

        let old;
        try {
            old = JSON.parse(raw);
        } catch (error) {
            return null;
        }

        const stats = emptyStats();
        stats.draws = Number(old.totalLotteryCount) || 0;
        stats.cost = Number(old.totalCost) || 0;
        stats.gains.beans = Number(old.totalBeansWon) || 0;
        stats.gains.invite = Number(old.totalInvites) || 0;
        stats.gains.rainbow = Number(old.totalRainbowDays) || 0;
        stats.gains.vip = Number(old.totalVipDays) || 0;
        stats.gains.makeup = Number(old.totalMakeupCards) || 0;
        stats.gains.upload = Number(old.totalUploadGB) || 0;

        Object.entries(old.totalPrizeStats || {}).forEach(([text, count]) => {
            const times = Number(count) || 0;
            if (times <= 0) return;

            const prize = parsePrizeText(text);
            const bucket = ensureBucket(stats, prize.type);
            bucket.count += times;
            bucket.value += prize.value * times;
            bucket.tiers[prize.label] = (bucket.tiers[prize.label] || 0) + times;
            stats.raw[text] = (stats.raw[text] || 0) + times;
        });

        stats.migratedFrom = 'v3';
        console.info('HHCLUB 已从 v3 迁移历史统计');
        return stats;
    }

    function ensureBucket(stats, type) {
        if (!stats.prizes[type]) {
            stats.prizes[type] = { count: 0, value: 0, tiers: {} };
        }
        return stats.prizes[type];
    }

    /* 历史统计每次都基于 localStorage 最新值做读-改-写，
       这样多个标签页同时抽奖不会互相覆盖。 */
    function commitTotal(mutate) {
        const stats = loadStats();
        mutate(stats);
        stats.lastAt = Date.now();
        if (!stats.firstAt) stats.firstAt = stats.lastAt;
        saveStats(stats);
        totalStats = stats;
    }

    /* =========================================================
       设置持久化
    ========================================================= */

    function loadSettings() {
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            if (raw) Object.assign(settings, JSON.parse(raw));
        } catch (error) {
            console.error('HHCLUB 读取设置失败:', error);
        }

        // 存下来的值可能来自旧版本、别的合法区间，或者被手改过。
        // 不在这里收敛的话，输入框会显示一个和实际生效值不一样的数字。
        settings.interval = Math.min(
            CONFIG.maxInterval,
            Math.max(CONFIG.minInterval, parseInt(settings.interval, 10) || 7)
        );
        settings.maxCount = Math.max(1, parseInt(settings.maxCount, 10) || 10);
        if (settings.viewMode !== 'total') settings.viewMode = 'current';
        if (settings.detailOpen !== 'all') settings.detailOpen = 'none';
        settings.animation = settings.animation !== false;
    }

    function saveSettings() {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch (error) {
            console.error('HHCLUB 保存设置失败:', error);
        }
    }

    /* =========================================================
       奖品解析

       返回 { type, name, value, unit, label }
       label 是明细列表里的档位名，例如 "500 憨豆" / "3 天"
    ========================================================= */

    function parsePrizeText(text) {
        const source = String(text || '').trim();
        const compact = source.replace(/\s+/g, ' ');
        const fallback = { type: 'unknown', name: '其他奖品', value: 0, unit: '', label: compact || '未知奖品' };

        if (!compact) return fallback;

        const rules = [
            // 「魔力 5000」和「5000 憨豆」是同一件事
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
                // 上传量带单位，TB 统一折算成 GB
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
                name: meta.name,
                value,
                unit: meta.unit,
                label: `${fmt(value)}${meta.unit ? ' ' + meta.unit : ' ' + meta.name}`
            };
        }

        return fallback;
    }

    /* =========================================================
       奖池与官方爆率

       抽奖页的内联脚本里带着完整奖池，且站点自己算好了 probability_real
       （小数形式，11 项相加 ≈ 1）。读出来就能把实测爆率和官方公布值并排比，
       不用自己拿样本去猜理论值。读不到时全部功能降级，不影响抽奖。
    ========================================================= */

    let prizePool = null;

    /* 从任意一份 lucky.php 文档里抠出奖池。解析失败返回 null，
       调用方据此区分「没读到」和「读到了一个空奖池」。 */
    function parsePrizePoolFrom(doc) {
        let raw = null;
        for (const script of doc.querySelectorAll('script:not([src])')) {
            const match = script.textContent.match(/\blet\s+prizes\s*=\s*(\[[\s\S]*?\])\s*;/);
            if (match) {
                raw = match[1];
                break;
            }
        }
        if (!raw) return null;

        let list;
        try {
            list = JSON.parse(raw);
        } catch (error) {
            return null;
        }
        if (!Array.isArray(list)) return null;

        // 奖池文案拼法和接口返回的 prize_text 一致（typeText + ' ' + amountText），
        // 所以档位 label 天然对得上，可以直接按 label 匹配。
        return list.map(item => {
            const prize = parsePrizeText(`${item.typeText || ''} ${item.amountText || ''}`);
            return {
                type: prize.type,
                label: prize.label,
                value: prize.value,
                probability: Number(item.probability_real) || 0
            };
        });
    }

    function readPrizePool() {
        if (prizePool) return prizePool;
        prizePool = parsePrizePoolFrom(document) || [];
        return prizePool;
    }

    /* 奖池指纹，用来判断站点有没有偷偷调过爆率 */
    function poolFingerprint(pool) {
        return (pool || []).map(item => `${item.type}|${item.label}|${item.probability}`).sort().join(';');
    }

    /* 官方爆率查表：按类别汇总一份，按具体档位汇总一份 */
    function officialRates() {
        const byType = {};
        const byTier = {};

        readPrizePool().forEach(item => {
            byType[item.type] = (byType[item.type] || 0) + item.probability;
            const key = `${item.type}|${item.label}`;
            byTier[key] = (byTier[key] || 0) + item.probability;
        });

        return { byType, byTier };
    }

    /* 这一注算不算大奖。优先用站点公布的爆率判定，读不到奖池时退回硬规则。 */
    function isJackpot(prize) {
        const pool = readPrizePool();
        const hit = pool.find(item => item.type === prize.type && item.label === prize.label);

        if (hit) return hit.probability > 0 && hit.probability <= CONFIG.jackpotMaxRate;

        return prize.type === 'vip'
            || (prize.type === 'beans' && prize.value >= CONFIG.jackpotBeansFloor);
    }

    /* 每抽的理论期望产出，用来和实测效率对比 */
    function poolExpectation() {
        const gains = {};
        readPrizePool().forEach(item => {
            if (item.type === 'unknown') return;
            gains[item.type] = (gains[item.type] || 0) + item.value * item.probability;
        });
        return gains;
    }

    /* =========================================================
       记录一次抽奖

       抽奖次数、消耗、分奖项统计一次性写入，
       避免以前 updatePrizeStats / updateCostStats 分两步导致的中间态不一致。
    ========================================================= */

    /* 把一次中奖累加进 stats。本地抽奖和同步官方记录都走这里，
       保证两条路径算出来的结构完全一致。 */
    function applyPrize(stats, prizeText, cost, prize) {
        const parsed = prize || parsePrizeText(prizeText);

        stats.draws += 1;
        stats.cost += cost;

        if (parsed.type !== 'unknown') {
            stats.gains[parsed.type] = (stats.gains[parsed.type] || 0) + parsed.value;
        }

        const bucket = ensureBucket(stats, parsed.type);
        bucket.count += 1;
        bucket.value += parsed.value;
        bucket.tiers[parsed.label] = (bucket.tiers[parsed.label] || 0) + 1;

        // 接口返回的文案常带尾随空格，不 trim 的话同一个奖
        // 会在兜底表里留下 "魔力 100" 和 "魔力 100 " 两条 key
        const rawKey = String(prizeText).trim();
        stats.raw[rawKey] = (stats.raw[rawKey] || 0) + 1;
    }

    function recordDraw(prizeText) {
        const prize = parsePrizeText(prizeText);

        const apply = stats => applyPrize(stats, prizeText, singleCost, prize);

        apply(currentStats);
        commitTotal(apply);

        render();

        const jackpot = isJackpot(prize);
        if (jackpot) addLog(`👑 大奖！${prizeText}`, 'success');
        if (settings.animation) {
            if (jackpot) showJackpotAnimation(prizeText);
            else showWinAnimation(prizeText);
        }
    }

    /* =========================================================
       样式
    ========================================================= */

    function injectStyle() {
        const style = document.createElement('style');
        style.id = 'hhanclub-lottery-style';
        style.textContent = `
#lottery-control-panel {
    position: fixed;
    top: 24px;
    right: 24px;
    width: 380px;
    min-width: 330px;
    max-width: 560px;
    max-height: calc(100vh - 48px);
    box-sizing: border-box;
    padding: 15px;

    font-family: "PingFang SC", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 13px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    text-rendering: optimizeLegibility;
    color: #2d1f14;

    background: #fdf8f0;
    border: 1.5px solid rgba(180, 155, 125, 0.35);
    border-radius: 18px;
    box-shadow: 0 12px 40px rgba(60, 40, 20, 0.12), 0 2px 8px rgba(60, 40, 20, 0.05);

    z-index: 2147483647;
    resize: both;
    overflow: auto;
    animation: hhPanelIn .28s ease-out;
}

#lottery-control-panel * { box-sizing: border-box; }

#lottery-control-panel::-webkit-scrollbar { width: 5px; height: 5px; }
#lottery-control-panel::-webkit-scrollbar-thumb {
    background: rgba(160, 130, 100, 0.25);
    border-radius: 8px;
}

@keyframes hhPanelIn {
    from { opacity: 0; transform: translateY(10px) scale(.97); }
    to { opacity: 1; transform: translateY(0) scale(1); }
}

/* ===== 顶部装饰 ===== */
#lottery-control-panel .hh-anniversary {
    height: 4px;
    margin: -15px -15px 12px -15px;
    border-radius: 18px 18px 0 0;
    background: linear-gradient(90deg, #e94b45, #f4a340, #ffd45c, #69a84f, #5ba9c9, #e94b45);
    background-size: 200% 100%;
    animation: hhRainbow 7s linear infinite;
}
@keyframes hhRainbow {
    from { background-position: 0% 50%; }
    to { background-position: 200% 50%; }
}

/* ===== Header ===== */
#lottery-control-panel .hh-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
    cursor: move;
    user-select: none;
}
#lottery-control-panel .hh-brand { display: flex; align-items: center; gap: 10px; }
#lottery-control-panel .hh-logo {
    width: 40px;
    height: 40px;
    display: grid;
    place-items: center;
    position: relative;
    flex-shrink: 0;
    border-radius: 50%;
    background: linear-gradient(180deg, #f0524c 0%, #e3423c 47%, #5d4635 48%, #5d4635 53%, #fdf8f0 54%, #fdf8f0 100%);
    border: 2.5px solid #5d4635;
    box-shadow: 0 2px 0 rgba(93,70,53,.12);
    font-size: 17px;
}
#lottery-control-panel .hh-logo::after {
    content: "";
    position: absolute;
    width: 10px;
    height: 10px;
    left: 50%;
    top: 50%;
    transform: translate(-50%,-50%);
    border: 2.5px solid #5d4635;
    border-radius: 50%;
    background: #fdf8f0;
    box-shadow: 0 0 0 2px rgba(255,255,255,.7);
}
#lottery-control-panel .hh-title {
    font-size: 15px;
    font-weight: 700;
    color: #2d1f14;
    letter-spacing: 0.2px;
}
#lottery-control-panel .hh-subtitle {
    margin-top: 1px;
    color: #a08066;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.4px;
}
#lottery-control-panel .hh-online {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 3px 10px;
    border-radius: 20px;
    background: #eef5ea;
    color: #4d8a3a;
    border: 1px solid #d0e0c4;
    font-size: 9px;
    font-weight: 700;
}
#lottery-control-panel .hh-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #5ca84a;
    box-shadow: 0 0 6px rgba(92,168,74,.4);
    animation: hhPulse 1.7s infinite;
}
@keyframes hhPulse {
    0%,100% { opacity: 1; transform: scale(1); }
    50% { opacity: .5; transform: scale(.7); }
}

/* ===== 庆典横幅 ===== */
#lottery-control-panel .hh-anniversary-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 14px;
    margin-bottom: 10px;
    border-radius: 12px;
    background: linear-gradient(135deg, #fcf0d8, #f8e6cc);
    border: 1px solid #e8d0b0;
}
#lottery-control-panel .hh-anniversary-left { display: flex; align-items: center; gap: 8px; }
#lottery-control-panel .hh-anniversary-icon { font-size: 20px; line-height: 1; }
#lottery-control-panel .hh-anniversary-title {
    font-size: 11px;
    font-weight: 700;
    color: #6a4d32;
}
#lottery-control-panel .hh-anniversary-text {
    margin-top: 1px;
    color: #a08066;
    font-size: 8px;
    font-weight: 500;
}
#lottery-control-panel .hh-four {
    font-size: 22px;
    font-weight: 900;
    color: #d4873a;
    line-height: 1;
    text-shadow: 1px 2px 0 rgba(166,102,39,.08);
}

/* ===== 余额卡片 ===== */
#lottery-control-panel .hh-balance {
    display: grid;
    grid-template-columns: 1.3fr .8fr;
    gap: 8px;
    margin-bottom: 10px;
}
#lottery-control-panel .hh-balance-card {
    padding: 10px 14px;
    border-radius: 12px;
    background: #ffffff;
    border: 1px solid #e8ddd0;
    box-shadow: 0 2px 6px rgba(110,82,48,.04);
    transition: .15s ease;
}
#lottery-control-panel .hh-balance-card:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(110,82,48,.08);
}
#lottery-control-panel .hh-label {
    color: #a08066;
    font-size: 10px;
    font-weight: 500;
    margin-bottom: 3px;
    letter-spacing: 0.2px;
}
#lottery-control-panel .hh-balance-number {
    font-size: 23px;
    font-weight: 800;
    color: #2d1f14;
    letter-spacing: -0.3px;
}
#lottery-control-panel .hh-possible {
    color: #d4873a;
    font-size: 21px;
    font-weight: 800;
}
#lottery-control-panel .hh-unit {
    color: #a08066;
    font-size: 10px;
    font-weight: 500;
}

/* ===== 统计卡片 ===== */
#lottery-control-panel .hh-stats {
    display: grid;
    grid-template-columns: repeat(2,1fr);
    gap: 8px;
    margin-bottom: 10px;
}
#lottery-control-panel .hh-stat {
    padding: 10px 12px;
    border-radius: 12px;
    background: #ffffff;
    border: 1px solid #e8ddd0;
    box-shadow: 0 2px 6px rgba(110,82,48,.04);
}
#lottery-control-panel .hh-stat-top {
    display: flex;
    justify-content: space-between;
    color: #a08066;
    font-size: 9px;
    font-weight: 500;
    letter-spacing: 0.2px;
}
#lottery-control-panel .hh-stat-value {
    margin-top: 2px;
    font-size: 20px;
    font-weight: 800;
    color: #2d1f14;
}

/* ===== 盈亏 ===== */
#lottery-control-panel .hh-profit {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    margin-bottom: 10px;
    border-radius: 12px;
    background: linear-gradient(135deg, #fcf0d8, #f8e6cc);
    border: 1px solid #e8d0b0;
}
#lottery-control-panel .hh-profit-left {
    color: #a08066;
    font-size: 10px;
    font-weight: 500;
}
#lottery-control-panel .hh-profit-value {
    margin-top: 1px;
    font-size: 19px;
    font-weight: 800;
}
#lottery-control-panel .hh-profit-rate {
    font-size: 16px;
    font-weight: 800;
}

/* ===== 区块 ===== */
#lottery-control-panel .hh-section {
    margin-bottom: 10px;
    padding: 12px 14px;
    border-radius: 12px;
    background: #ffffff;
    border: 1px solid #e8ddd0;
    box-shadow: 0 2px 6px rgba(110,82,48,.04);
}
#lottery-control-panel .hh-section-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
    font-size: 12px;
    font-weight: 700;
    color: #4d3828;
}
#lottery-control-panel .hh-section-title > span {
    color: #a08066;
    font-weight: 500;
    font-size: 10px;
}

/* ===== 设置 ===== */
#lottery-control-panel .hh-settings {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
}
#lottery-control-panel .hh-field {
    padding: 8px 10px;
    border-radius: 10px;
    background: #f8f2ea;
    border: 1px solid #e8ddd0;
}
#lottery-control-panel .hh-field label {
    display: block;
    color: #a08066;
    font-size: 9px;
    font-weight: 500;
    margin-bottom: 3px;
}
#lottery-control-panel .hh-field input,
#lottery-control-panel .hh-mode {
    width: 100%;
    color: #2d1f14;
    background: #ffffff;
    border: 1px solid #ddd0c0;
    border-radius: 7px;
    padding: 6px 8px;
    font-size: 12px;
    font-weight: 500;
    outline: none;
    transition: border-color .2s;
}
#lottery-control-panel .hh-field input:focus,
#lottery-control-panel .hh-mode:focus {
    border-color: #d4873a;
    box-shadow: 0 0 0 3px rgba(212,135,58,.1);
}

/* ===== 按钮 ===== */
#lottery-control-panel .hh-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-top: 10px;
}
#lottery-control-panel .hh-btn {
    border: 0;
    border-radius: 10px;
    padding: 10px 8px;
    color: #fff;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    transition: .15s ease;
}
#lottery-control-panel .hh-btn:hover:not(:disabled) {
    transform: translateY(-1px);
    filter: brightness(1.05);
}
#lottery-control-panel .hh-btn:active:not(:disabled) { transform: translateY(0); }
#lottery-control-panel .hh-btn:disabled { opacity: .4; cursor: not-allowed; }
#lottery-control-panel .hh-start {
    background: linear-gradient(135deg, #f4a743, #e58c32);
    box-shadow: 0 4px 14px rgba(224,139,49,.25);
}
#lottery-control-panel .hh-stop {
    background: linear-gradient(135deg, #e95b55, #cf413d);
    box-shadow: 0 4px 14px rgba(207,65,61,.18);
}

/* ===== 小按钮 ===== */
#lottery-control-panel .hh-small-actions {
    display: flex;
    gap: 6px;
    margin-top: 10px;
}
#lottery-control-panel .hh-small-btn {
    flex: 1;
    padding: 6px 5px;
    border-radius: 8px;
    border: 1px solid #ddd0c0;
    background: #f8f2ea;
    color: #8a705a;
    font-size: 9px;
    font-weight: 600;
    cursor: pointer;
    transition: .15s ease;
}
#lottery-control-panel .hh-small-btn:hover {
    background: #f0e6da;
    color: #5a4030;
    border-color: #ccbca8;
}

/* ===== 汇总奖品格 ===== */
#lottery-control-panel .hh-prizes {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
}
#lottery-control-panel .hh-prize {
    min-width: 0;
    padding: 8px 10px;
    border-radius: 10px;
    background: #f8f2ea;
    border: 1px solid #e8ddd0;
}
#lottery-control-panel .hh-prize-name {
    color: #a08066;
    font-size: 9px;
    font-weight: 500;
}
#lottery-control-panel .hh-prize-value {
    margin-top: 2px;
    font-size: 14px;
    font-weight: 800;
    color: #2d1f14;
}

/* ===== 分奖项明细 ===== */
#lottery-control-panel .hh-detail-list {
    max-height: 260px;
    overflow-y: auto;
    padding-right: 2px;
}
#lottery-control-panel .hh-detail-empty {
    text-align: center;
    color: #b09a84;
    padding: 14px 10px;
    font-size: 10px;
    font-weight: 500;
}
#lottery-control-panel .hh-row {
    margin-bottom: 6px;
    padding: 7px 9px;
    border-radius: 10px;
    background: #f8f2ea;
    border: 1px solid #e8ddd0;
}
#lottery-control-panel .hh-row-head {
    display: flex;
    align-items: center;
    gap: 7px;
    cursor: pointer;
    user-select: none;
}
#lottery-control-panel .hh-row-icon {
    font-size: 13px;
    line-height: 1;
    flex-shrink: 0;
}
#lottery-control-panel .hh-row-name {
    flex: 1;
    min-width: 0;
    font-size: 11px;
    font-weight: 700;
    color: #4d3828;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
#lottery-control-panel .hh-row-count {
    flex-shrink: 0;
    font-size: 12px;
    font-weight: 800;
    color: #d4873a;
    white-space: nowrap;
}
#lottery-control-panel .hh-row-pct {
    flex-shrink: 0;
    width: 42px;
    text-align: right;
    font-size: 10px;
    font-weight: 600;
    color: #a08066;
    white-space: nowrap;
}
#lottery-control-panel .hh-row-caret {
    flex-shrink: 0;
    width: 12px;
    text-align: center;
    font-size: 8px;
    color: #b09a84;
    transition: transform .15s ease;
}
#lottery-control-panel .hh-row.is-open .hh-row-caret { transform: rotate(90deg); }
#lottery-control-panel .hh-row-official {
    flex-shrink: 0;
    width: 46px;
    text-align: right;
    font-size: 9px;
    font-weight: 500;
    color: #b09a84;
    white-space: nowrap;
}
#lottery-control-panel .hh-row-bar {
    position: relative;
    height: 4px;
    margin-top: 5px;
    border-radius: 3px;
    background: #ece0d2;
    overflow: hidden;
}
/* 官方爆率刻度线，和实测填充条比长短 */
#lottery-control-panel .hh-row-bar-mark {
    position: absolute;
    top: -1px;
    width: 2px;
    height: 6px;
    border-radius: 1px;
    background: #6a5240;
    opacity: .55;
}
#lottery-control-panel .hh-row-bar-fill {
    height: 100%;
    border-radius: 3px;
    background: linear-gradient(90deg, #f4a743, #e58c32);
    transition: width .3s ease;
}
#lottery-control-panel .hh-row-sum {
    margin-top: 4px;
    font-size: 9px;
    font-weight: 500;
    color: #a08066;
}
#lottery-control-panel .hh-tiers {
    display: none;
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px dashed #e0d2c0;
}
#lottery-control-panel .hh-row.is-open .hh-tiers { display: block; }
#lottery-control-panel .hh-tier {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    padding: 3px 2px 3px 20px;
    font-size: 10px;
    font-weight: 500;
    color: #6a5240;
}
#lottery-control-panel .hh-tier-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
#lottery-control-panel .hh-tier-rate {
    flex-shrink: 0;
    font-size: 9px;
    font-weight: 500;
    color: #b09a84;
    white-space: nowrap;
}
#lottery-control-panel .hh-tier-count {
    flex-shrink: 0;
    font-weight: 700;
    color: #8a705a;
    white-space: nowrap;
}

/* ===== 日志 ===== */
#lottery-control-panel .hh-log {
    display: none;
    max-height: 150px;
    overflow-y: auto;
    padding: 8px 10px;
    border-radius: 10px;
    background: #f8f2ea;
    border: 1px solid #e8ddd0;
    font-family: "SF Mono", "Menlo", "Consolas", monospace;
    font-size: 10px;
    line-height: 1.7;
    color: #2d1f14;
}


/* ===== 中奖弹窗 ===== */
.hh-win-overlay {
    position: fixed;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%) scale(.75);
    z-index: 2147483648;
    padding: 18px 25px;
    border-radius: 16px;
    background: linear-gradient(135deg, #fdf8f0, #f8e6cc);
    border: 2px solid #d4873a;
    box-shadow: 0 16px 50px rgba(60,40,20,.2), inset 0 1px 0 rgba(255,255,255,.8);
    text-align: center;
    pointer-events: none;
    opacity: 0;
    animation: hhWinPopup 1.9s ease-out forwards;
}
.hh-win-title {
    color: #d4873a;
    font-size: 20px;
    font-weight: 900;
    margin-bottom: 4px;
}
.hh-win-prize {
    color: #2d1f14;
    font-size: 14px;
    font-weight: 700;
}
@keyframes hhWinPopup {
    0% { opacity: 0; transform: translate(-50%,-50%) scale(.65); }
    15% { opacity: 1; transform: translate(-50%,-50%) scale(1.05); }
    28% { transform: translate(-50%,-50%) scale(1); }
    78% { opacity: 1; }
    100% { opacity: 0; transform: translate(-50%,-65%) scale(.95); }
}

/* ===== 粒子 ===== */
.hh-confetti {
    position: fixed;
    z-index: 2147483649;
    pointer-events: none;
    font-size: 16px;
    animation: hhConfetti 1.4s ease-out forwards;
}
@keyframes hhConfetti {
    0% { opacity: 1; transform: translate(0,0) rotate(0deg) scale(1); }
    100% { opacity: 0; transform: translate(var(--tx), var(--ty)) rotate(var(--rot)) scale(.5); }
}

/* ===== 移动端 ===== */
@media (max-width:600px) {
    #lottery-control-panel {
        right: 10px;
        top: 10px;
        width: min(380px, calc(100vw - 20px));
        min-width: 280px;
        max-height: calc(100vh - 20px);
        padding: 14px 14px;
    }
    #lottery-control-panel .hh-anniversary {
        margin: -14px -14px 12px -14px;
    }
}

/* ===== 导入方式弹窗 ===== */
.hh-modal-overlay {
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(40, 26, 12, .45);
    backdrop-filter: blur(2px);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
}
.hh-modal {
    width: min(330px, calc(100vw - 32px));
    padding: 16px;
    border-radius: 14px;
    background: linear-gradient(160deg, #fffdf8, #fdf3e4);
    border: 1px solid #e8d5bc;
    box-shadow: 0 20px 60px rgba(60, 40, 20, .3);
}
.hh-modal-title {
    font-size: 14px;
    font-weight: 800;
    color: #5a4030;
    margin-bottom: 8px;
}
.hh-modal-text {
    font-size: 11px;
    line-height: 1.7;
    color: #8a705a;
    margin-bottom: 12px;
}
.hh-modal-text b { color: #d4873a; }
.hh-modal-btn {
    display: block;
    width: 100%;
    margin-bottom: 7px;
    padding: 9px 11px;
    border-radius: 9px;
    border: 1px solid #e8d5bc;
    background: #fffdf9;
    color: #5a4030;
    font-size: 12px;
    font-weight: 700;
    text-align: left;
    cursor: pointer;
    font-family: inherit;
    transition: transform .12s ease, box-shadow .12s ease;
}
.hh-modal-btn span {
    display: block;
    margin-top: 2px;
    font-size: 9px;
    font-weight: 500;
    color: #a08066;
}
.hh-modal-btn:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(120, 80, 40, .16);
}
.hh-modal-primary {
    background: linear-gradient(135deg, #f5b555, #e09030);
    border-color: #d4873a;
    color: #fff;
}
.hh-modal-primary span { color: rgba(255, 255, 255, .85); }
.hh-modal-ghost {
    margin-bottom: 0;
    padding: 7px 11px;
    background: transparent;
    border-color: transparent;
    color: #a08066;
    font-size: 11px;
    font-weight: 600;
    text-align: center;
}
.hh-modal-ghost:hover {
    transform: none;
    box-shadow: none;
    background: rgba(160, 128, 102, .1);
}

/* ===== 一抽到底 ===== */
#lottery-control-panel .hh-drain {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: 8px;
    padding: 7px 9px;
    border-radius: 9px;
    background: linear-gradient(135deg, #fff4e2, #ffe9cc);
    border: 1px solid #f0cfa0;
}
#lottery-control-panel .hh-drain-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-weight: 700;
    color: #8a5a20;
    cursor: pointer;
    user-select: none;
}
#lottery-control-panel .hh-drain-toggle input {
    width: 13px;
    height: 13px;
    accent-color: #d4873a;
    cursor: pointer;
}
#lottery-control-panel .hh-drain-reserve {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    color: #a08066;
    font-weight: 600;
}
#lottery-control-panel .hh-drain-reserve input {
    width: 74px;
    padding: 3px 6px;
    font-size: 11px;
    font-weight: 700;
    color: #5a4030;
    border: 1px solid #e8d5bc;
    border-radius: 6px;
    background: #fffdf9;
    text-align: right;
}
#lottery-control-panel .hh-drain-hint {
    margin-top: 5px;
    font-size: 9px;
    line-height: 1.5;
    color: #a08066;
    display: none;
}
#lottery-control-panel .hh-drain-hint.is-on {
    display: block;
}

/* ===== 大奖全屏庆祝 ===== */
.hh-jackpot-overlay {
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    background: radial-gradient(ellipse at center, rgba(70, 40, 10, .55) 0%, rgba(10, 6, 2, .82) 70%);
    animation: hhJackpotFade .45s ease-out;
}
.hh-jackpot-overlay.is-out {
    animation: hhJackpotFade .5s ease-in reverse forwards;
}
/* 背后缓慢旋转的金色光芒 */
.hh-jackpot-rays {
    position: absolute;
    width: 150vmax;
    height: 150vmax;
    background: repeating-conic-gradient(
        from 0deg,
        rgba(255, 214, 110, .20) 0deg 7deg,
        transparent 7deg 14deg
    );
    animation: hhJackpotSpin 9s linear infinite;
}
.hh-jackpot-card {
    position: relative;
    text-align: center;
    padding: 0 24px;
    animation: hhJackpotPop .7s cubic-bezier(.2, 1.5, .4, 1);
}
.hh-jackpot-kicker {
    font-size: clamp(14px, 3.4vw, 22px);
    font-weight: 800;
    letter-spacing: .5em;
    text-indent: .5em;
    color: #ffe9a8;
    text-shadow: 0 0 18px rgba(255, 190, 60, .9);
}
.hh-jackpot-prize {
    margin: 10px 0 8px;
    font-size: clamp(30px, 8vw, 68px);
    font-weight: 900;
    line-height: 1.15;
    background: linear-gradient(180deg, #fff6d0 0%, #ffd166 45%, #f0a12e 100%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    filter: drop-shadow(0 4px 18px rgba(255, 160, 30, .75));
}
.hh-jackpot-sub {
    font-size: clamp(11px, 2.4vw, 15px);
    font-weight: 600;
    color: rgba(255, 233, 180, .8);
}
.hh-firework {
    position: fixed;
    z-index: 2147483647;
    pointer-events: none;
    animation: hhFirework 2.6s cubic-bezier(.15, .7, .3, 1) forwards;
}
@keyframes hhJackpotFade {
    from { opacity: 0; }
    to   { opacity: 1; }
}
@keyframes hhJackpotSpin {
    to { transform: rotate(360deg); }
}
@keyframes hhJackpotPop {
    0%   { transform: scale(.4) rotate(-6deg); opacity: 0; }
    60%  { transform: scale(1.08) rotate(1.5deg); opacity: 1; }
    100% { transform: scale(1) rotate(0); opacity: 1; }
}
@keyframes hhFirework {
    0%   { transform: translate(0, 0) rotate(0); opacity: 1; }
    70%  { opacity: 1; }
    100% { transform: translate(var(--tx), var(--ty)) rotate(var(--rot)); opacity: 0; }
}

/* ===== 降低动画偏好 ===== */
@media (prefers-reduced-motion: reduce) {
    #lottery-control-panel,
    #lottery-control-panel .hh-anniversary,
    #lottery-control-panel .hh-dot {
        animation: none;
    }
    /* 大奖仍然给看，只是不转不飞 */
    .hh-jackpot-overlay,
    .hh-jackpot-card { animation: none; }
    .hh-jackpot-rays { display: none; }
    .hh-firework { display: none; }
}
        `;
        document.head.appendChild(style);
    }

    /* =========================================================
       面板
    ========================================================= */

    function createControlPanel() {
        if ($('lottery-control-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'lottery-control-panel';

        panel.innerHTML = `
            <div class="hh-anniversary"></div>

            <!-- Header -->
            <div class="hh-header" id="hh-title-bar">
                <div class="hh-brand">
                    <div class="hh-logo">🎁</div>
                    <div>
                        <div class="hh-title">HHCLUB 自动抽奖</div>
                        <div class="hh-subtitle">🎉 4TH ANNIVERSARY · LOTTERY</div>
                    </div>
                </div>
                <div class="hh-online">
                    <i class="hh-dot"></i>
                    READY
                </div>
            </div>

            <!-- Anniversary -->
            <div class="hh-anniversary-banner">
                <div class="hh-anniversary-left">
                    <div class="hh-anniversary-icon">
                        <img src="${SITE_ORIGIN}/pic/medal/4th.svg" style="width:44px;height:44px;" alt="4th Anniversary">
                    </div>
                    <div>
                        <div class="hh-anniversary-title">HHCLUB 四周年庆典</div>
                        <div class="hh-anniversary-text">一起庆祝 · 一起抽奖 · 好运连连</div>
                    </div>
                </div>
                <div class="hh-four">4</div>
            </div>

            <!-- Balance -->
            <div class="hh-balance">
                <div class="hh-balance-card">
                    <div class="hh-label">💰 憨豆余额</div>
                    <div class="hh-balance-number" id="bean-balance">检测中...</div>
                    <div class="hh-label" style="margin:4px 0 0;display:flex;align-items:center;gap:6px;">
                        <span id="balance-freshness" style="color:#a08066;">已校准</span>
                        <button id="refresh-balance" class="hh-small-btn"
                                style="flex:0 0 auto;width:auto;padding:2px 7px;font-size:9px;">🔄</button>
                    </div>
                    <div class="hh-label" style="margin:4px 0 0;">
                        单次消耗 <b id="single-cost" style="color:#d4873a;">2000</b> 憨豆
                    </div>
                </div>
                <div class="hh-balance-card">
                    <div class="hh-label">🎯 可抽次数</div>
                    <div>
                        <span class="hh-possible" id="max-possible">-</span>
                        <span class="hh-unit">次</span>
                    </div>
                    <div class="hh-label" style="margin-top:7px;">按当前余额计算</div>
                </div>
            </div>

            <!-- Main Stats -->
            <div class="hh-stats">
                <div class="hh-stat">
                    <div class="hh-stat-top">
                        <span>🎲 抽奖次数</span>
                        <span>DRAWS</span>
                    </div>
                    <div class="hh-stat-value" id="draw-count">0</div>
                </div>
                <div class="hh-stat">
                    <div class="hh-stat-top">
                        <span>🏆 奖项种类</span>
                        <span>TYPES</span>
                    </div>
                    <div class="hh-stat-value" id="prize-type-count">0</div>
                </div>
            </div>

            <!-- Profit -->
            <div class="hh-profit">
                <div>
                    <div class="hh-profit-left" id="profit-label">🍰 憨豆盈亏</div>
                    <div class="hh-profit-value" id="profit-loss">-</div>
                </div>
                <div style="text-align:right;">
                    <div class="hh-profit-left" id="profit-rate-label">盈亏率</div>
                    <div class="hh-profit-rate" id="profit-rate">-</div>
                </div>
            </div>

            <!-- Settings -->
            <div class="hh-section">
                <div class="hh-section-title">
                    <div>⚙️ 抽奖设置</div>
                    <span id="lottery-status">等待开始</span>
                </div>

                <div class="hh-settings">
                    <div class="hh-field">
                        <label>⏱ 抽奖间隔 · 秒</label>
                        <input type="number" id="lottery-interval" value="7"
                               min="${CONFIG.minInterval}" max="${CONFIG.maxInterval}">
                    </div>
                    <div class="hh-field">
                        <label>🎯 最大抽奖次数</label>
                        <input type="number" id="max-lottery-count" value="10" min="1" max="1000">
                    </div>
                </div>

                <div class="hh-drain">
                    <label class="hh-drain-toggle">
                        <input type="checkbox" id="drain-mode">
                        <span>🔥 一抽到底</span>
                    </label>
                    <div class="hh-drain-reserve">
                        <span>保留</span>
                        <input type="number" id="reserve-beans" value="0" min="0" step="1000">
                        <span>憨豆</span>
                    </div>
                </div>
                <div id="drain-hint" class="hh-drain-hint">
                    勾选后忽略最大次数，一直抽到余额跌破保留线为止
                </div>

                <div style="display:flex;align-items:center;justify-content:space-between;margin-top:7px;">
                    <span style="font-size:10px;color:#a08066;font-weight:500;">
                        当前间隔 <b id="current-interval" style="color:#5a4030;">7</b> 秒
                    </span>
                    <button id="set-max-possible" class="hh-small-btn"
                            style="flex:0 0 auto;width:auto;padding:4px 10px;">
                        🎯 按余额设置
                    </button>
                </div>

                <div class="hh-actions">
                    <button id="start-lottery" class="hh-btn hh-start">🎁 开始抽奖</button>
                    <button id="stop-lottery" class="hh-btn hh-stop" disabled>🛑 停止抽奖</button>
                </div>
            </div>

            <!-- Data -->
            <div class="hh-section">
                <div class="hh-section-title">
                    <div>📊 数据统计</div>
                    <select id="view-mode" class="hh-mode"
                            style="width:112px;padding:5px 7px;font-size:11px;">
                        <option value="current">本次数据</option>
                        <option value="total">历史总计</option>
                    </select>
                </div>

                <div class="hh-stats">
                    <div class="hh-stat">
                        <div class="hh-stat-top">
                            <span>📉 累计消耗</span>
                            <span>COST</span>
                        </div>
                        <div class="hh-stat-value" id="cost-beans">0</div>
                    </div>
                    <div class="hh-stat">
                        <div class="hh-stat-top">
                            <span>💰 获得憨豆</span>
                            <span>BEAN</span>
                        </div>
                        <div class="hh-stat-value" id="total-beans-won">0</div>
                    </div>
                </div>

                <div class="hh-prizes">
                    <div class="hh-prize">
                        <div class="hh-prize-name">📧 邀请</div>
                        <div class="hh-prize-value" id="total-invites">0</div>
                    </div>
                    <div class="hh-prize">
                        <div class="hh-prize-name">🌈 彩虹ID</div>
                        <div class="hh-prize-value" id="total-rainbow-days">0天</div>
                    </div>
                    <div class="hh-prize">
                        <div class="hh-prize-name">⭐ VIP</div>
                        <div class="hh-prize-value" id="total-vip-days">0天</div>
                    </div>
                    <div class="hh-prize">
                        <div class="hh-prize-name">🎫 补签卡</div>
                        <div class="hh-prize-value" id="total-makeup-cards">0</div>
                    </div>
                    <div class="hh-prize">
                        <div class="hh-prize-name">⬆️ 上传量</div>
                        <div class="hh-prize-value" id="total-upload">0GB</div>
                    </div>
                    <div class="hh-prize">
                        <div class="hh-prize-name">🎯 理论盈亏率</div>
                        <div class="hh-prize-value" id="theory-rate">-</div>
                    </div>
                </div>

                <div class="hh-small-actions">
                    <button id="reset-current-data" class="hh-small-btn">↻ 重置本次</button>
                    <button id="export-stats" class="hh-small-btn">📤 导出 CSV</button>
                    <button id="backup-stats" class="hh-small-btn">💾 备份 JSON</button>
                    <button id="import-stats" class="hh-small-btn">📥 导入备份</button>
                    <button id="clear-total-data" class="hh-small-btn">🗑 清空历史</button>
                </div>
            </div>

            <!-- 分奖项明细 -->
            <div class="hh-section">
                <div class="hh-section-title">
                    <div>🎁 奖项明细</div>
                    <span id="detail-summary">共 0 抽</span>
                </div>
                <div id="detail-list" class="hh-detail-list"></div>
                <div class="hh-small-actions">
                    <button id="toggle-all-tiers" class="hh-small-btn">🔽 展开全部档位</button>
                    <button id="toggle-animation" class="hh-small-btn">🎉 中奖动画：开</button>
                </div>
            </div>

            <!-- Log -->
            <div class="hh-section" style="margin-bottom:0;">
                <div class="hh-section-title">
                    <div>📜 冒险日志</div>
                    <span>最近 ${CONFIG.logLimit} 条</span>
                </div>
                <div id="lottery-log" class="hh-log"></div>
            </div>

        `;

        document.body.appendChild(panel);
    }

    /* =========================================================
       余额 / 单次消耗
    ========================================================= */

    /* 和 getBeanBalance() 一个套路：.use-bean 不刷新页面就永远不变，
       所以只有 DOM 数字自己变过才采信。以前每次调用都无条件回读，
       校准从服务端拿回来的新价会被页面上的旧价当场冲掉。
       注意要兼容 "2,000" 这种千分位写法，否则会被截成 2。 */
    function getSingleCost() {
        const element = document.querySelector('.use-bean');
        const domValue = element ? firstNumber(element.textContent) : null;

        if (domValue !== null && domValue > 0 && domValue !== domCostSeen) {
            domCostSeen = domValue;
            singleCost = Math.round(domValue);
            setText('single-cost', fmt(singleCost));
        }

        return singleCost;
    }

    /* 站点的 lottery() 抽完只转转盘、弹窗，从不刷新 .bean-number，
       所以自动抽奖期间那个元素一直是进页面时的旧值 —— 面板上的余额和
       「最多可抽」会一路冻结。这里改成：DOM 值自己变了（刷新页面、站点
       以后加了更新）才采信，其余时间用每抽扣一次的本地估算值。 */
    function getBeanBalance() {
        const element = document.querySelector('.bean-number');
        const domValue = element ? firstNumber(element.textContent) : null;

        if (domValue !== null && domValue !== domBalanceSeen) {
            domBalanceSeen = domValue;
            beanBalance = domValue;
        }

        return beanBalance;
    }

    /* 站点抽完不刷新余额，本地估算又会随时间漂移（比如你在别的标签页手点了几抽），
       所以每隔若干抽回服务端要一次权威值。lucky.php 自己就带 .bean-number，
       不用另找接口。 */
    /* 一次请求同时拿余额和奖池。站点会不定期调整爆率
       （线上见过同一天改好几次），而奖池就在这份 HTML 里，
       顺手解析不用多发一次请求。 */
    async function fetchServerSnapshot() {
        try {
            const response = await fetch(LOTTERY_PAGE, { credentials: 'include' });
            if (!response.ok) return null;

            const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
            return {
                balance: firstNumber(doc.querySelector('.bean-number')?.textContent ?? ''),
                // .use-bean 和 .bean-number 一样，不刷新页面就永远不变。
                // 一抽到底可能挂好几个小时，中途站点调价的话，停止判断
                // 会拿旧成本去算，保留线就守不住了。
                cost: firstNumber(doc.querySelector('.use-bean')?.textContent ?? ''),
                pool: parsePrizePoolFrom(doc)
            };
        } catch (error) {
            return null;
        }
    }

    /* 单抽消耗变了就换掉。这个值影响一抽到底的停止判断和全部盈亏计算，
       挂机跑着的时候尤其不能用旧的。 */
    function adoptSingleCost(cost) {
        if (cost === null || !(cost > 0)) return false;

        const next = Math.round(cost);
        if (next === singleCost) return false;

        const before = singleCost;
        singleCost = next;
        setText('single-cost', fmt(singleCost));

        // 对齐到 DOM 当前值，理由同 calibrateBalance：
        // 不对齐的话下一次 getSingleCost() 会把这里的新价冲掉
        const element = document.querySelector('.use-bean');
        const domValue = element ? firstNumber(element.textContent) : null;
        if (domValue !== null) domCostSeen = domValue;
        addLog(`💱 站点把单次消耗从 ${fmt(before)} 调成了 ${fmt(singleCost)} 憨豆`, 'warning');
        return true;
    }

    /* 爆率变了就换掉缓存。变了要说一声 —— 理论盈亏率和大奖判定都跟着它走。 */
    function adoptPool(pool, { quiet = false } = {}) {
        if (!pool || !pool.length) return false;
        if (poolFingerprint(pool) === poolFingerprint(prizePool)) return false;

        const before = theoreticalProfitRate();
        prizePool = pool;
        const after = theoreticalProfitRate();

        if (!quiet) {
            const shift = (before !== null && after !== null && Math.abs(after - before) >= 0.05)
                ? `，理论盈亏率 ${before > 0 ? '+' : ''}${before.toFixed(1)}% → ${after > 0 ? '+' : ''}${after.toFixed(1)}%`
                : '';
            addLog(`📈 站点调整了奖池爆率${shift}`, 'warning');
        }
        return true;
    }

    async function calibrateBalance({ quiet = false } = {}) {
        if (calibrating) return false;
        calibrating = true;
        setText('balance-freshness', '校准中...');

        try {
            const snapshot = await fetchServerSnapshot();
            const value = snapshot ? snapshot.balance : null;

            // 爆率和单抽消耗都先换，后面 render() 才会用上新数据
            if (snapshot) {
                adoptPool(snapshot.pool);
                adoptSingleCost(snapshot.cost);
            }

            if (value === null) {
                if (!quiet) addLog('⚠️ 余额校准失败，继续用本地估算', 'warning');
                return false;
            }

            const drift = value - beanBalance;
            beanBalance = value;

            // 校准值必须活过紧接着的 updateBalanceDisplay()。
            // getBeanBalance() 的规则是「DOM 数字变了就采信 DOM」，所以这里要把
            // domBalanceSeen 对齐到 DOM **当前**显示的数：
            //   写成服务端值 → 和 DOM 不等，下一拍就被 DOM 冲掉；
            //   保持不动     → DOM 若真变过，同样会被冲掉。
            // 对齐之后，「DOM 变没变」照常判断，而刚拉回来的权威值不会被过期
            // 的页面数字覆盖（站点从不刷新 .bean-number，它只会越来越旧）。
            const element = document.querySelector('.bean-number');
            const domValue = element ? firstNumber(element.textContent) : null;
            if (domValue !== null) domBalanceSeen = domValue;

            drawsSinceCalibration = 0;
            updateBalanceDisplay();
            render();

            if (!quiet) {
                addLog(Math.abs(drift) >= 1
                    ? `🔄 余额已校准：${fmt(value)}（估算差 ${drift > 0 ? '+' : ''}${fmt(drift)}）`
                    : `🔄 余额已校准：${fmt(value)}`, 'info');
            }
            return true;
        } finally {
            calibrating = false;
            updateBalanceDisplay();
        }
    }

    /* 抽完一次后更新估算：扣掉本次消耗，中的憨豆当场加回来
       —— 奖池里 type 1001 就是憨豆，所以中奖是真的回血。 */
    function applyDrawToBalance(prize) {
        const won = prize.type === 'beans' ? prize.value : 0;
        beanBalance = Math.max(0, beanBalance - singleCost + won);
        drawsSinceCalibration++;
        updateBalanceDisplay();
    }

    function updateBalanceDisplay() {
        const balance = getBeanBalance();
        const cost = getSingleCost();
        const maxPossible = cost > 0 ? Math.floor(balance / cost) : 0;

        setText('bean-balance', fmt(balance));
        setText('max-possible', fmt(maxPossible));

        if (!calibrating) {
            setText('balance-freshness', drawsSinceCalibration === 0
                ? '已校准'
                : `估算 · ${drawsSinceCalibration} 抽前校准`);
        }

        const startButton = $('start-lottery');
        if (startButton && !running) {
            const insufficient = balance < cost;
            startButton.disabled = insufficient;
            startButton.textContent = insufficient ? '💸 余额不足' : '🎁 开始抽奖';
        }

        return maxPossible;
    }

    /* =========================================================
       日志
    ========================================================= */

    function addLog(message, type = 'info') {
        const container = $('lottery-log');
        if (!container) return;

        container.style.display = 'block';

        const colors = {
            info: '#8a705a',
            error: '#d94a44',
            success: '#4d8a3a',
            warning: '#c97a2e'
        };

        const entry = document.createElement('div');
        entry.style.cssText = `margin-bottom:2px;color:${colors[type] || colors.info};font-weight:500;`;
        entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;

        container.appendChild(entry);
        container.scrollTop = container.scrollHeight;

        while (container.children.length > CONFIG.logLimit) {
            container.removeChild(container.firstChild);
        }
    }

    /* =========================================================
       渲染
    ========================================================= */

    function activeStats() {
        return settings.viewMode === 'total' ? totalStats : currentStats;
    }

    function render() {
        const stats = activeStats();

        setText('draw-count', fmt(stats.draws));
        setText('prize-type-count', Object.keys(stats.prizes).length);
        setText('cost-beans', fmt(stats.cost));
        setText('total-beans-won', fmt(stats.gains.beans));
        setText('total-invites', fmt(stats.gains.invite));
        setText('total-rainbow-days', `${fmt(stats.gains.rainbow)}天`);
        setText('total-vip-days', `${fmt(stats.gains.vip)}天`);
        setText('total-makeup-cards', fmt(stats.gains.makeup));
        setText('total-upload', `${fmt(stats.gains.upload)}GB`);

        renderProfit(stats);
        renderPrizeDetail(stats);
    }

    /* 憨豆盈亏。奖池里 type 1001 就是憨豆，所以这个数字是实打实的：
       按官方爆率算，每抽期望产出 2,312 憨豆、消耗 2,000，理论盈亏率 +15.6%，
       转盘本身是正期望的。副标题把实测盈亏率和这个理论值放一起比。 */
    function renderProfit(stats) {
        const tone = value => (value > 0 ? '#4d8a3a' : value < 0 ? '#d94a44' : '#a08066');

        const profit = stats.gains.beans - stats.cost;
        const profitElement = $('profit-loss');

        if (profitElement) {
            profitElement.textContent = (profit > 0 ? '+' : '') + fmt(profit);
            profitElement.style.color = tone(profit);
        }

        const baseline = theoreticalProfitRate();
        setText('theory-rate', baseline === null
            ? '-'
            : `${baseline > 0 ? '+' : ''}${baseline.toFixed(1)}%`);

        const rateElement = $('profit-rate');
        if (!rateElement) return;

        if (stats.cost <= 0) {
            rateElement.textContent = '-';
            rateElement.style.color = '#a08066';
            rateElement.title = '';
            return;
        }

        const rate = (profit / stats.cost) * 100;
        rateElement.textContent = `${rate > 0 ? '+' : ''}${rate.toFixed(1)}%`;
        rateElement.style.color = tone(rate);

        rateElement.title = baseline === null
            ? ''
            : `理论盈亏率 ${baseline > 0 ? '+' : ''}${baseline.toFixed(1)}%（按官方爆率）`;
    }

    /* 按官方爆率算出来的期望盈亏率，读不到奖池时返回 null */
    function theoreticalProfitRate() {
        const expected = poolExpectation().beans;
        if (!expected || singleCost <= 0) return null;
        return ((expected - singleCost) / singleCost) * 100;
    }

    /* 分奖项明细：一级按类别聚合，二级展开具体档位 */
    function renderPrizeDetail(stats) {
        const list = $('detail-list');
        if (!list) return;

        const rows = Object.entries(stats.prizes)
            .filter(([, bucket]) => bucket.count > 0)
            .sort((a, b) => b[1].count - a[1].count || PRIZE_ORDER.indexOf(a[0]) - PRIZE_ORDER.indexOf(b[0]));

        const totalCount = rows.reduce((sum, [, bucket]) => sum + bucket.count, 0);
        const official = officialRates();

        setText('detail-summary', `共 ${fmt(totalCount)} 抽 · ${rows.length} 种`);

        // 重新渲染前记住哪些类别是展开的，避免抽奖刷新时折叠状态丢失
        const openTypes = new Set(
            Array.from(list.querySelectorAll('.hh-row.is-open')).map(row => row.dataset.type)
        );

        list.innerHTML = '';

        if (!totalCount) {
            const empty = document.createElement('div');
            empty.className = 'hh-detail-empty';
            empty.textContent = '暂无奖品数据，开始抽奖后这里会显示每个奖项的中奖次数';
            list.appendChild(empty);
            return;
        }

        rows.forEach(([type, bucket]) => {
            const meta = PRIZE_META[type] || PRIZE_META.unknown;
            const percentage = ((bucket.count / totalCount) * 100).toFixed(1);

            const row = document.createElement('div');
            row.className = 'hh-row';
            row.dataset.type = type;
            if (openTypes.has(type) || settings.detailOpen === 'all') {
                row.classList.add('is-open');
            }

            const tiers = Object.entries(bucket.tiers)
                .sort((a, b) => b[1] - a[1])
                .map(([label, count]) => {
                    const tierOfficial = official.byTier[`${type}|${label}`];
                    const rateLine = tierOfficial === undefined
                        ? ''
                        : `<span class="hh-tier-rate">实测 ${((count / totalCount) * 100).toFixed(2)}% · 官方 ${(tierOfficial * 100).toFixed(2)}%</span>`;
                    return `
                    <div class="hh-tier">
                        <span class="hh-tier-name">${escapeHtml(label)}</span>
                        ${rateLine}
                        <span class="hh-tier-count">${fmt(count)} 次</span>
                    </div>
                `;
                })
                .join('');

            const sumLine = bucket.value > 0
                ? `<div class="hh-row-sum">累计 ${fmt(bucket.value)}${meta.unit ? ' ' + meta.unit : ''}</div>`
                : '';

            // 官方爆率读不到时（页面结构变了 / 非抽奖页）整块降级，只显示实测
            const typeOfficial = official.byType[type];
            const officialCell = typeOfficial === undefined
                ? ''
                : `<span class="hh-row-official">官方 ${(typeOfficial * 100).toFixed(1)}%</span>`;
            const officialMark = typeOfficial === undefined
                ? ''
                : `<div class="hh-row-bar-mark" style="left:calc(${Math.min(100, typeOfficial * 100).toFixed(1)}% - 1px)" title="官方爆率 ${(typeOfficial * 100).toFixed(2)}%"></div>`;

            row.innerHTML = `
                <div class="hh-row-head">
                    <span class="hh-row-caret">▶</span>
                    <span class="hh-row-icon">${meta.icon}</span>
                    <span class="hh-row-name">${escapeHtml(meta.name)}</span>
                    <span class="hh-row-count">${fmt(bucket.count)} 次</span>
                    <span class="hh-row-pct">${percentage}%</span>
                    ${officialCell}
                </div>
                <div class="hh-row-bar">
                    <div class="hh-row-bar-fill" style="width:${percentage}%"></div>
                    ${officialMark}
                </div>
                ${sumLine}
                <div class="hh-tiers">${tiers}</div>
            `;

            row.querySelector('.hh-row-head').addEventListener('click', () => {
                row.classList.toggle('is-open');
            });

            list.appendChild(row);
        });
    }

    /* =========================================================
       中奖动画
    ========================================================= */

    function showWinAnimation(prizeText) {
        // 切到别的标签页时没人看，省掉每次 20+ 个粒子节点的创建与回收
        if (document.hidden) return;

        const old = document.querySelector('.hh-win-overlay');
        if (old) old.remove();

        const popup = document.createElement('div');
        popup.className = 'hh-win-overlay';
        popup.innerHTML = `
            <div class="hh-win-title">🎉 恭喜中奖！</div>
            <div class="hh-win-prize">🎁 ${escapeHtml(prizeText)}</div>
        `;

        document.body.appendChild(popup);
        createConfetti();

        setTimeout(() => popup.remove(), 2000);
    }

    /* 大奖专用全屏庆祝：整屏压暗 + 金色光爆 + 奖品名放大登场 + 双向礼花。
       和普通中奖动画一样受「中奖动画」开关和 document.hidden 控制，
       prefers-reduced-motion 下由 CSS 收敛成静态显示。 */
    function showJackpotAnimation(prizeText) {
        if (document.hidden) return;

        document.querySelectorAll('.hh-jackpot-overlay').forEach(node => node.remove());

        const overlay = document.createElement('div');
        overlay.className = 'hh-jackpot-overlay';
        overlay.innerHTML = `
            <div class="hh-jackpot-rays"></div>
            <div class="hh-jackpot-card">
                <div class="hh-jackpot-kicker">✨ 大 奖 ✨</div>
                <div class="hh-jackpot-prize">${escapeHtml(prizeText)}</div>
                <div class="hh-jackpot-sub">这一注值得截图</div>
            </div>
        `;

        document.body.appendChild(overlay);
        createFireworks();

        setTimeout(() => overlay.classList.add('is-out'), 3200);
        setTimeout(() => overlay.remove(), 3800);
    }

    /* 从屏幕左右下角各打一束，比普通粒子更密、更慢、带重力感 */
    function createFireworks() {
        const symbols = ['🎆', '🎇', '⭐', '✨', '🌟', '💰', '👑', '🎉'];
        const origins = [
            { x: 0.12, y: 0.92 },
            { x: 0.88, y: 0.92 },
            { x: 0.5, y: 0.15 }
        ];

        origins.forEach((origin, index) => {
            for (let i = 0; i < 26; i++) {
                const item = document.createElement('div');
                item.className = 'hh-firework';
                item.textContent = symbols[Math.floor(Math.random() * symbols.length)];

                const angle = Math.random() * Math.PI * 2;
                const distance = 180 + Math.random() * 420;

                item.style.cssText = `
                    left: ${window.innerWidth * origin.x}px;
                    top: ${window.innerHeight * origin.y}px;
                    font-size: ${14 + Math.random() * 16}px;
                    --tx: ${Math.cos(angle) * distance}px;
                    --ty: ${Math.sin(angle) * distance - 120}px;
                    --rot: ${(Math.random() - .5) * 1080}deg;
                    animation-delay: ${index * .18 + Math.random() * .3}s;
                `;

                document.body.appendChild(item);
                setTimeout(() => item.remove(), 3600);
            }
        });
    }

    function createConfetti() {
        const symbols = ['⭐', '✨', '🎉', '🎈', '🎁', '🔴', '🟡', '🌟'];

        for (let i = 0; i < 22; i++) {
            const item = document.createElement('div');
            item.className = 'hh-confetti';
            item.textContent = symbols[Math.floor(Math.random() * symbols.length)];

            item.style.cssText = `
                position: fixed;
                left: ${window.innerWidth / 2}px;
                top: ${window.innerHeight / 2}px;
                z-index: 2147483649;
                pointer-events: none;
                font-size: 16px;
                animation: hhConfetti 1.4s ease-out forwards;
                --tx: ${(Math.random() - .5) * 420}px;
                --ty: ${(Math.random() - .5) * 360}px;
                --rot: ${(Math.random() - .5) * 900}deg;
                animation-delay: ${Math.random() * .12}s;
            `;

            document.body.appendChild(item);
            setTimeout(() => item.remove(), 1700);
        }
    }

    /* =========================================================
       抽奖接口
    ========================================================= */

    async function performLottery() {
        try {
            const response = await fetch(LOTTERY_API, {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'accept': '*/*',
                    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
                    'referer': LOTTERY_PAGE,
                    'x-requested-with': 'XMLHttpRequest',
                    // 站点自己用的是 jQuery.post，带 form 类型的 Content-Type，
                    // 这里对齐，免得请求特征和正常点击不一样
                    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8'
                },
                body: ''
            });

            const resultText = await response.text();

            let parsed = null;
            try {
                parsed = JSON.parse(resultText);
            } catch (error) {
                // 非 JSON 响应，交给上层按失败处理
            }

            return { success: response.ok, status: response.status, data: resultText, parsed };
        } catch (error) {
            return { success: false, status: 0, error: error.message, data: '', parsed: null };
        }
    }

    /* =========================================================
       抽奖循环

       改为 await 完成后再排下一次的串行循环。
       以前用 setInterval 调 async 函数，请求一旦慢过间隔就会并发发起，
       既会重复扣豆，也会触发站点的重复点击风控；
       同时 setInterval 的周期是创建时固定的，退避后间隔再也降不回来。
    ========================================================= */

    function baseIntervalMs() {
        const raw = parseInt($('lottery-interval')?.value, 10);
        const seconds = Math.min(
            CONFIG.maxInterval,
            Math.max(CONFIG.minInterval, Number.isFinite(raw) ? raw : settings.interval)
        );
        return seconds * 1000;
    }

    /* 加入随机抖动，避免固定频率的请求特征 */
    function nextDelayMs() {
        const jitter = 1 + (Math.random() * 2 - 1) * CONFIG.jitterRatio;
        return Math.max(1000, Math.round(dynamicInterval * jitter));
    }

    function setCurrentIntervalDisplay() {
        setText('current-interval', (dynamicInterval / 1000).toFixed(1).replace(/\.0$/, ''));
    }

    async function runSingleDraw(maxCount) {
        const roundCount = currentStats.draws - roundStartDraws;
        // 一抽到底没有「总共几次」可言，报余额更有意义
        addLog(settings.drainMode
            ? `🎲 第 ${roundCount + 1} 次抽奖 · 余额 ${fmt(beanBalance)}`
            : `🎲 第 ${roundCount + 1}/${maxCount} 次抽奖`, 'info');

        const result = await performLottery();
        if (!running) return;

        if (!result.success || !result.parsed) {
            errorStreak++;
            addLog(`❌ 请求失败：${result.error || result.status || '未知错误'}`, 'error');
            guardErrorStreak();
            return;
        }

        const data = result.parsed;

        if (data.ret === 0) {
            errorStreak = 0;
            rateLimitStreak = 0;
            dynamicInterval = baseIntervalMs();
            setCurrentIntervalDisplay();

            const prizeText = decodeUnicode(data.data?.prize_text || '未知奖品');
            const recordId = data.data?.winning_record_id || '';

            addLog(`🎉 抽中：${prizeText}${recordId ? ` · ID ${recordId}` : ''}`, 'success');
            recordDraw(prizeText);
            applyDrawToBalance(parsePrizeText(prizeText));

            if (drawsSinceCalibration >= CONFIG.balanceSyncEveryDraws) {
                await calibrateBalance({ quiet: true });
            }
            return;
        }

        const msg = decodeUnicode(data.msg || '未知错误');

        if (msg.includes('重复点击') || msg.includes('请稍后') || msg.includes('频繁')) {
            rateLimitStreak++;
            addLog(`⏳ ${msg}`, 'warning');

            if (rateLimitStreak >= CONFIG.backoffAfterErrors) {
                dynamicInterval = Math.min(dynamicInterval * CONFIG.backoffFactor, CONFIG.maxBackoffMs);
                setCurrentIntervalDisplay();
                addLog(`🔄 请求频繁，间隔自动调整至 ${(dynamicInterval / 1000).toFixed(1)} 秒`, 'warning');
            }

            if (rateLimitStreak >= CONFIG.maxRateLimitRetries) {
                addLog(`🛑 连续 ${rateLimitStreak} 次被限流，自动停止`, 'error');
                stopLottery('🛑 持续被限流，已停止');
            }
            return;
        }

        if (msg.includes('次数') || msg.includes('用完') || msg.includes('余额不足') || msg.includes('憨豆不足')) {
            addLog(`❌ ${msg}，停止抽奖`, 'error');
            stopLottery('🛑 抽奖已停止');
            return;
        }

        errorStreak++;
        addLog(`❌ ${msg}`, 'error');
        guardErrorStreak();
    }

    /* 接口持续异常时兜底停止，避免无限重试 */
    function guardErrorStreak() {
        if (errorStreak >= CONFIG.maxConsecutiveErrors) {
            addLog(`🛑 连续 ${errorStreak} 次失败，自动停止`, 'error');
            stopLottery('🛑 接口连续异常，已停止');
        }
    }

    /* 一抽到底：抽到「再抽一次就会跌破保留线」为止，不设次数上限。
       余额用的是本地估算，所以真要停之前先回服务端校准一次，
       免得因为估算漂移多抽或少抽。 */
    async function shouldStopForReserve() {
        const reserve = Math.max(0, settings.reserveBeans);
        if (beanBalance - singleCost >= reserve) return false;

        // 估算说该停了，但可能是漂移造成的 —— 拿权威值再确认一遍
        if (drawsSinceCalibration > 0) {
            await calibrateBalance({ quiet: true });
            if (beanBalance - singleCost >= reserve) return false;
        }
        return true;
    }

    async function lotteryLoop(maxCount) {
        while (running) {
            const roundCount = currentStats.draws - roundStartDraws;

            if (settings.drainMode) {
                if (await shouldStopForReserve()) {
                    stopLottery(`🏁 一抽到底完成 · 保留 ${fmt(Math.max(0, settings.reserveBeans))} 憨豆`);
                    return;
                }
            } else if (roundCount >= maxCount) {
                stopLottery('🎯 本轮达到最大抽奖次数');
                return;
            }

            if (!running) return;

            await runSingleDraw(maxCount);
            if (!running) return;

            await sleep(nextDelayMs());
        }
    }

    function startLottery() {
        if (running) return;

        const interval = Math.min(
            CONFIG.maxInterval,
            Math.max(CONFIG.minInterval, parseInt($('lottery-interval')?.value, 10) || settings.interval)
        );
        const maxCount = Math.max(1, parseInt($('max-lottery-count')?.value, 10) || settings.maxCount);

        if ($('lottery-interval')) $('lottery-interval').value = interval;
        if ($('max-lottery-count')) $('max-lottery-count').value = maxCount;

        settings.interval = interval;
        settings.maxCount = maxCount;
        saveSettings();

        const reserve = Math.max(0, parseInt($('reserve-beans')?.value, 10) || 0);
        if ($('reserve-beans')) $('reserve-beans').value = reserve;
        settings.reserveBeans = reserve;
        saveSettings();

        if (updateBalanceDisplay() <= 0) {
            addLog('💸 憨豆不足，无法开始抽奖', 'error');
            return;
        }

        if (settings.drainMode && beanBalance - singleCost < reserve) {
            addLog(`💸 余额已在保留线（${fmt(reserve)}）之下，无需抽奖`, 'warning');
            return;
        }

        dynamicInterval = interval * 1000;
        errorStreak = 0;
        rateLimitStreak = 0;
        roundStartDraws = currentStats.draws;
        running = true;

        setCurrentIntervalDisplay();

        const status = $('lottery-status');
        if (status) {
            status.textContent = settings.drainMode ? `一抽到底 · ${interval}s` : `运行中 · ${interval}s`;
            status.style.color = '#4d8a3a';
        }

        const startButton = $('start-lottery');
        if (startButton) {
            startButton.disabled = true;
            startButton.textContent = '🎲 抽奖进行中...';
        }
        const stopButton = $('stop-lottery');
        if (stopButton) stopButton.disabled = false;

        addLog(settings.drainMode
            ? `🔥 一抽到底 · 保留 ${fmt(reserve)} 憨豆 · 间隔 ${interval} 秒`
            : `🚀 开始抽奖 · ${maxCount} 次 · 间隔 ${interval} 秒`, 'success');

        lotteryLoop(maxCount);
    }

    function stopLottery(message = '🛑 抽奖已停止') {
        if (!running) return;

        running = false;
        cancelSleep();

        const status = $('lottery-status');
        if (status) {
            status.textContent = '已停止';
            status.style.color = '#d94a44';
        }

        const stopButton = $('stop-lottery');
        if (stopButton) stopButton.disabled = true;

        addLog(message, 'warning');
        updateBalanceDisplay();
    }

    /* =========================================================
       数据操作
    ========================================================= */

    function resetCurrentData() {
        if (running) {
            addLog('⚠️ 请先停止自动抽奖', 'warning');
            return;
        }
        if (!confirm('确定要重置本次会话数据吗？（历史统计不受影响）')) return;

        currentStats = emptyStats();
        roundStartDraws = 0;
        render();
        addLog('✅ 本次数据已重置', 'success');
    }

    function clearTotalData() {
        if (!confirm('确定要清空全部历史统计吗？此操作无法撤销！')) return;

        localStorage.removeItem(STATS_KEY);
        localStorage.removeItem(LEGACY_STATS_KEY);
        totalStats = emptyStats();
        render();
        addLog('🗑 历史统计已清空', 'success');
    }

    /* 导出分奖项明细，方便自己拉表算真实爆率 */
    function exportStats() {
        const stats = activeStats();
        const scope = settings.viewMode === 'total' ? '历史总计' : '本次数据';

        const rows = Object.entries(stats.prizes)
            .filter(([, bucket]) => bucket.count > 0)
            .sort((a, b) => b[1].count - a[1].count || PRIZE_ORDER.indexOf(a[0]) - PRIZE_ORDER.indexOf(b[0]));

        const totalCount = rows.reduce((sum, [, bucket]) => sum + bucket.count, 0);

        if (!totalCount) {
            addLog('⚠️ 暂无数据可导出', 'warning');
            return;
        }

        const escapeCsv = value => `"${String(value).replace(/"/g, '""')}"`;
        const lines = ['类别,档位,次数,占比'];

        rows.forEach(([type, bucket]) => {
            const meta = PRIZE_META[type] || PRIZE_META.unknown;
            lines.push([
                escapeCsv(meta.name),
                escapeCsv('（小计）'),
                bucket.count,
                escapeCsv(`${((bucket.count / totalCount) * 100).toFixed(2)}%`)
            ].join(','));

            Object.entries(bucket.tiers)
                .sort((a, b) => b[1] - a[1])
                .forEach(([label, count]) => {
                    lines.push([
                        escapeCsv(meta.name),
                        escapeCsv(label),
                        count,
                        escapeCsv(`${((count / totalCount) * 100).toFixed(2)}%`)
                    ].join(','));
                });
        });

        lines.push('');
        lines.push([escapeCsv('抽奖次数'), '', stats.draws, ''].join(','));
        lines.push([escapeCsv('累计消耗憨豆'), '', stats.cost, ''].join(','));
        lines.push([escapeCsv('获得憨豆'), '', stats.gains.beans, ''].join(','));
        lines.push([escapeCsv('憨豆盈亏'), '', stats.gains.beans - stats.cost, ''].join(','));

        // 带 BOM，Excel 打开中文不乱码
        const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        downloadBlob(blob, `hhclub-lottery-${settings.viewMode}-${stamp}.csv`);

        addLog(`📤 已导出${scope}明细`, 'success');
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');

        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    /* 完整备份。和 CSV 不同：CSV 是给表格看的，这份是能原样导回来的。 */
    function backupStats() {
        const payload = {
            kind: 'hhclub-lottery-backup',
            version: 4,
            exportedAt: new Date().toISOString(),
            current: currentStats,
            total: loadStats()
        };

        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

        downloadBlob(blob, `hhclub-lottery-backup-${stamp}.json`);
        addLog('💾 已导出备份', 'success');
    }

    /* 两份统计相加。导入时选「合并」走这里，两边结构同构所以能逐项累加。 */
    function mergeStats(base, extra) {
        const result = normalizeStats(base);
        const other = normalizeStats(extra);

        result.draws += other.draws;
        result.cost += other.cost;
        Object.keys(result.gains).forEach(key => {
            result.gains[key] += other.gains[key] || 0;
        });

        Object.entries(other.prizes).forEach(([type, bucket]) => {
            const target = ensureBucket(result, type);
            target.count += bucket.count;
            target.value += bucket.value;
            Object.entries(bucket.tiers).forEach(([label, count]) => {
                target.tiers[label] = (target.tiers[label] || 0) + count;
            });
        });

        Object.entries(other.raw).forEach(([text, count]) => {
            result.raw[text] = (result.raw[text] || 0) + count;
        });

        const firsts = [base?.firstAt, extra?.firstAt].filter(Boolean);
        if (firsts.length) result.firstAt = Math.min(...firsts);
        result.lastAt = Math.max(base?.lastAt || 0, extra?.lastAt || 0) || null;

        return result;
    }

    /* confirm() 只有两个出口，塞不下「合并 / 覆盖 / 取消」三种意图 ——
       之前用「取消 = 合并」，既反直觉又没了真正的退出路径。改成自己弹一个。
       合并是主路径：不同设备的记录本来就不重合。 */
    function askImportMode(drawCount, currentCount) {
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.className = 'hh-modal-overlay';
            overlay.innerHTML = `
                <div class="hh-modal">
                    <div class="hh-modal-title">📥 导入备份</div>
                    <div class="hh-modal-text">
                        备份里有 <b>${fmt(drawCount)}</b> 抽记录，<br>
                        当前历史统计有 <b>${fmt(currentCount)}</b> 抽。
                    </div>
                    <button class="hh-modal-btn hh-modal-primary" data-mode="merge">
                        合并 · 共 ${fmt(drawCount + currentCount)} 抽
                        <span>换设备用这个，两边记录相加</span>
                    </button>
                    <button class="hh-modal-btn" data-mode="replace">
                        覆盖 · 只留 ${fmt(drawCount)} 抽
                        <span>丢掉当前历史，只保留备份里的</span>
                    </button>
                    <button class="hh-modal-btn hh-modal-ghost" data-mode="cancel">取消</button>
                </div>
            `;

            const done = mode => {
                overlay.remove();
                document.removeEventListener('keydown', onKey);
                resolve(mode);
            };
            const onKey = event => {
                if (event.key === 'Escape') done('cancel');
            };

            overlay.addEventListener('click', event => {
                const button = event.target.closest('[data-mode]');
                if (button) return done(button.dataset.mode);
                if (event.target === overlay) done('cancel');
            });
            document.addEventListener('keydown', onKey);

            document.body.appendChild(overlay);
        });
    }

    function importStats() {
        if (running) {
            addLog('⚠️ 请先停止自动抽奖', 'warning');
            return;
        }

        const picker = document.createElement('input');
        picker.type = 'file';
        picker.accept = 'application/json,.json';

        picker.addEventListener('change', async () => {
            const file = picker.files?.[0];
            if (!file) return;

            let payload;
            try {
                payload = JSON.parse(await file.text());
            } catch (error) {
                addLog('❌ 备份文件不是合法 JSON', 'error');
                return;
            }

            // 备份文件和裸的统计对象都收
            const incoming = payload?.total || payload?.current || payload;
            if (!incoming || typeof incoming !== 'object' || incoming.draws === undefined) {
                addLog('❌ 认不出这个文件的格式', 'error');
                return;
            }

            const parsed = normalizeStats(incoming);
            const existing = loadStats();
            const mode = await askImportMode(parsed.draws, existing.draws);

            if (mode === 'cancel') {
                addLog('📥 已取消导入', 'info');
                return;
            }

            const merged = mode === 'replace' ? parsed : mergeStats(existing, parsed);
            saveStats(merged);
            totalStats = merged;

            settings.viewMode = 'total';
            saveSettings();
            const viewSelect = $('view-mode');
            if (viewSelect) viewSelect.value = 'total';
            render();

            addLog(`📥 已${mode === 'replace' ? '覆盖' : '合并'}导入 · 历史共 ${fmt(merged.draws)} 抽`, 'success');
        });

        picker.click();
    }

    /* =========================================================
       拖动（兼容触屏）
    ========================================================= */

    function enableDragging() {
        const panel = $('lottery-control-panel');
        const title = $('hh-title-bar');
        if (!panel || !title) return;

        let dragging = false;
        let offsetX = 0;
        let offsetY = 0;

        const pointOf = event => (event.touches ? event.touches[0] : event);

        const start = event => {
            if (event.target.closest('button,input,select')) return;

            const point = pointOf(event);
            const rect = panel.getBoundingClientRect();

            dragging = true;
            offsetX = point.clientX - rect.left;
            offsetY = point.clientY - rect.top;
            event.preventDefault();
        };

        const move = event => {
            if (!dragging) return;

            // 触屏上不拦下来的话，拖面板会同时把页面滚走
            if (event.cancelable) event.preventDefault();

            const point = pointOf(event);
            const maxLeft = Math.max(5, window.innerWidth - panel.offsetWidth);
            const maxTop = Math.max(5, window.innerHeight - panel.offsetHeight);

            const left = Math.max(5, Math.min(point.clientX - offsetX, maxLeft));
            const top = Math.max(5, Math.min(point.clientY - offsetY, maxTop));

            panel.style.left = `${left}px`;
            panel.style.top = `${top}px`;
            panel.style.right = 'auto';
        };

        const end = () => {
            if (!dragging) return;
            dragging = false;

            settings.panelLeft = parseInt(panel.style.left, 10) || null;
            settings.panelTop = parseInt(panel.style.top, 10) || null;
            saveSettings();
        };

        title.addEventListener('mousedown', start);
        title.addEventListener('touchstart', start, { passive: false });
        document.addEventListener('mousemove', move);
        document.addEventListener('touchmove', move, { passive: false });
        document.addEventListener('mouseup', end);
        document.addEventListener('touchend', end);
    }

    function restorePanelPosition() {
        const panel = $('lottery-control-panel');
        if (!panel || settings.panelLeft === null || settings.panelTop === null) return;

        const left = Math.max(5, Math.min(settings.panelLeft, window.innerWidth - 100));
        const top = Math.max(5, Math.min(settings.panelTop, window.innerHeight - 100));

        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        panel.style.right = 'auto';
    }

    /* 窗口缩小后面板可能被留在视口外，标题栏都抓不到就再也拖不回来了 */
    function keepPanelInViewport() {
        const panel = $('lottery-control-panel');
        if (!panel || panel.style.left === '') return;

        const maxLeft = Math.max(5, window.innerWidth - panel.offsetWidth);
        const maxTop = Math.max(5, window.innerHeight - panel.offsetHeight);
        const left = Math.max(5, Math.min(parseInt(panel.style.left, 10) || 5, maxLeft));
        const top = Math.max(5, Math.min(parseInt(panel.style.top, 10) || 5, maxTop));

        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;

        settings.panelLeft = left;
        settings.panelTop = top;
        saveSettings();
    }

    /* =========================================================
       初始化
    ========================================================= */

    function bindEvents() {
        on('start-lottery', 'click', startLottery);
        on('stop-lottery', 'click', () => stopLottery('🛑 用户手动停止抽奖'));

        on('set-max-possible', 'click', () => {
            const max = updateBalanceDisplay();
            const input = $('max-lottery-count');
            if (input) {
                input.value = Math.max(1, max);
                settings.maxCount = Math.max(1, max);
                saveSettings();
            }
            addLog(`🎯 已将最大次数设置为 ${max}`, 'info');
        });

        on('view-mode', 'change', event => {
            settings.viewMode = event.target.value;
            saveSettings();
            render();
        });

        on('lottery-interval', 'change', event => {
            const value = Math.min(
                CONFIG.maxInterval,
                Math.max(CONFIG.minInterval, parseInt(event.target.value, 10) || settings.interval)
            );
            event.target.value = value;
            settings.interval = value;
            saveSettings();

            // 运行中改间隔立刻生效，不必重启
            if (running) {
                dynamicInterval = value * 1000;
                setCurrentIntervalDisplay();
            }
        });

        on('max-lottery-count', 'change', event => {
            const value = Math.max(1, parseInt(event.target.value, 10) || settings.maxCount);
            event.target.value = value;
            settings.maxCount = value;
            saveSettings();
        });

        on('refresh-balance', 'click', () => calibrateBalance());
        on('backup-stats', 'click', backupStats);
        on('import-stats', 'click', importStats);

        on('drain-mode', 'change', event => {
            settings.drainMode = event.target.checked;
            saveSettings();
            applyDrainUI();
        });

        on('reserve-beans', 'change', event => {
            const value = Math.max(0, parseInt(event.target.value, 10) || 0);
            event.target.value = value;
            settings.reserveBeans = value;
            saveSettings();
        });

        on('reset-current-data', 'click', resetCurrentData);
        on('clear-total-data', 'click', clearTotalData);
        on('export-stats', 'click', exportStats);

        on('toggle-all-tiers', 'click', () => {
            const rows = Array.from(document.querySelectorAll('#detail-list .hh-row'));
            const shouldOpen = rows.some(row => !row.classList.contains('is-open'));

            rows.forEach(row => row.classList.toggle('is-open', shouldOpen));
            settings.detailOpen = shouldOpen ? 'all' : 'none';
            saveSettings();

            setText('toggle-all-tiers', shouldOpen ? '🔼 收起全部档位' : '🔽 展开全部档位');
        });

        on('toggle-animation', 'click', () => {
            settings.animation = !settings.animation;
            saveSettings();
            setText('toggle-animation', `🎉 中奖动画：${settings.animation ? '开' : '关'}`);
        });

        // 其他标签页写入历史统计时同步过来
        window.addEventListener('storage', event => {
            if (event.key !== STATS_KEY) return;
            totalStats = loadStats();
            if (settings.viewMode === 'total') render();
        });

        window.addEventListener('resize', keepPanelInViewport);

        // 关页面时如果还在抽，提醒一下
        window.addEventListener('beforeunload', event => {
            if (!running) return;
            event.preventDefault();
            event.returnValue = '';
        });
    }

    function applySettingsToUI() {
        const intervalInput = $('lottery-interval');
        if (intervalInput) intervalInput.value = settings.interval;

        const maxInput = $('max-lottery-count');
        if (maxInput) maxInput.value = settings.maxCount;

        const viewSelect = $('view-mode');
        if (viewSelect) viewSelect.value = settings.viewMode;

        const drainToggle = $('drain-mode');
        if (drainToggle) drainToggle.checked = !!settings.drainMode;

        const reserveInput = $('reserve-beans');
        if (reserveInput) reserveInput.value = Math.max(0, settings.reserveBeans);

        applyDrainUI();

        setText('toggle-animation', `🎉 中奖动画：${settings.animation ? '开' : '关'}`);
        setText('toggle-all-tiers', settings.detailOpen === 'all' ? '🔼 收起全部档位' : '🔽 展开全部档位');

        dynamicInterval = settings.interval * 1000;
        setCurrentIntervalDisplay();
    }

    /* 一抽到底开着时「最大抽奖次数」不起作用，置灰，免得以为设了有用 */
    function applyDrainUI() {
        const maxInput = $('max-lottery-count');
        if (maxInput) {
            maxInput.disabled = !!settings.drainMode;
            maxInput.style.opacity = settings.drainMode ? '.45' : '';
        }

        const setMaxButton = $('set-max-possible');
        if (setMaxButton) setMaxButton.disabled = !!settings.drainMode;

        $('drain-hint')?.classList.toggle('is-on', !!settings.drainMode);
    }

    function init() {
        if ($('lottery-control-panel')) return;

        loadSettings();
        totalStats = loadStats();

        injectStyle();
        createControlPanel();

        applySettingsToUI();
        bindEvents();
        enableDragging();
        restorePanelPosition();

        updateBalanceDisplay();
        render();

        addLog('🎈 HHCLUB 自动抽奖 · 情绪价值拉满版已加载', 'success');
        addLog('🌐 当前站点：hhanclub.net', 'info');
        addLog('🎁 自动抽奖 Dashboard 已准备就绪', 'info');

        if (totalStats.migratedFrom === 'v3') {
            addLog('📦 已迁移旧版历史统计数据', 'success');
        }


        setInterval(() => {
            getSingleCost();
            updateBalanceDisplay();
        }, 10000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
