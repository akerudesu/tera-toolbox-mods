(function () {
    'use strict';

    // Mirrors lib/classes.js - the demo builds players straight from class names, so it needs the
    // same class -> colour map the live meter would otherwise send down.
    const CLASS_COLORS = {
        Warrior: '#e5484d', Lancer: '#4a8fe0', Slayer: '#f39a3c', Berserker: '#ef6d3a', Sorcerer: '#aa5fe0',
        Archer: '#cdd24a', Priest: '#84cf4d', Mystic: '#33bd93', Reaper: '#7b6ce0', Gunner: '#e8b93f',
        Brawler: '#3fb2cf', Ninja: '#ec5a9e', Valkyrie: '#d05fce'
    };

    // Real per-class skill ids (from the bundled EU-EN table, icons present) so the demo shows real
    // names + icons. Damage is split across them with plausible hit/crit counts.
    const DEMO_SKILLS = { "slayer": [10100, 20100, 30100, 40100, 50100, 60100, 80100, 90100], "archer": [10100, 20100, 30100, 40100, 50100, 60100, 70100, 80100], "sorcerer": [10100, 20100, 30100, 40100, 50100, 60100, 70100, 80100], "warrior": [10100, 20100, 30100, 40100, 50100, 80100, 90100, 100100], "berserker": [10100, 20100, 30100, 40100, 50100, 60100, 70100, 80100], "reaper": [10100, 30100, 40100, 40331, 50100, 60100, 70100, 80100], "gunner": [10100, 20100, 30100, 40100, 50100, 51020, 60100, 70100], "brawler": [10100, 10101, 10102, 10103, 20100, 20101, 20103, 20104], "lancer": [10100, 20100, 30100, 40100, 50100, 70100, 80100, 90100], "mystic": [10100, 20100, 20112, 30100, 40100, 50100, 60100, 70100], "priest": [10100, 20100, 30100, 50100, 60100, 80100, 100100, 110100], "ninja": [10100, 20100, 30100, 30821, 40100, 50100, 60100, 70100], "valkyrie": [10100, 20100, 30100, 40100, 50100, 60100, 70100, 80100] };

    const demoSettings = { theme: 'tera', autoOpenOnCombat: false, alwaysOnTop: true, skillDataRegion: 'auto', combatGapSeconds: 8, endGapSeconds: 90, maxRows: 12, region: 'EU-EN' };

    // Distinct per-encounter rosters so selecting a history entry visibly reloads both table and
    // chart. Built once and memoised.
    let cached = null;
    function scenarios() {
        if (cached) return cached;
        const now = Date.now();
        const rosterA = [
            { id: '1', name: 'Ramiline', className: 'Slayer', color: '#f2a93b', isSelf: true, base: 16000, crit: 31.2, deaths: 0 },
            { id: '2', name: 'Tornado Alexandrina', className: 'Gunner', color: '#e08e3c', base: 12800, crit: 24.0, deaths: 1 },
            { id: '3', name: 'Chiffon', className: 'Archer', color: '#5fd38d', base: 12400, crit: 28.5, deaths: 0 }
        ];
        const rosterB = [
            { id: '7', name: 'Nyxaria', className: 'Sorcerer', color: '#a368dc', base: 18500, crit: 34.1, deaths: 0 },
            { id: '8', name: 'Bruiserino', className: 'Brawler', color: '#e35d4f', isSelf: true, base: 15200, crit: 22.7, deaths: 2 },
            { id: '9', name: 'Vaelor', className: 'Warrior', color: '#8fd14f', base: 14100, crit: 40.3, deaths: 0 },
            { id: '10', name: 'Lirielle', className: 'Priest', color: '#f4d35e', base: 3200, crit: 12.0, deaths: 0 }
        ];
        const rosterC = [
            { id: '1', name: 'Ramiline', className: 'Slayer', color: '#f2a93b', isSelf: true, base: 33000, crit: 35.5, deaths: 0 }
        ];
        // One player of every class, so all 13 class colours show at once.
        const rosterAll = [
            { id: 'w', name: 'Ramiline', className: 'Slayer', color: '#f2a93b', isSelf: true, base: 16400, crit: 31.2, deaths: 0 },
            { id: 'x1', name: 'Valkyrious', className: 'Valkyrie', color: '#6c5ce7', base: 16200, crit: 32.4, deaths: 0 },
            { id: 'x2', name: 'Shadowstep', className: 'Ninja', color: '#ef5da8', base: 15800, crit: 29.9, deaths: 0 },
            { id: 'x3', name: 'Chiffon', className: 'Archer', color: '#5fd38d', base: 15500, crit: 28.5, deaths: 0 },
            { id: 'x4', name: 'Nyxaria', className: 'Sorcerer', color: '#a368dc', base: 15200, crit: 34.1, deaths: 1 },
            { id: 'x5', name: 'Grukthar', className: 'Warrior', color: '#8fd14f', base: 14800, crit: 30.1, deaths: 0 },
            { id: 'x6', name: 'Bloodrage', className: 'Berserker', color: '#d9534f', base: 14400, crit: 27.0, deaths: 0 },
            { id: 'x7', name: 'Grimreap', className: 'Reaper', color: '#9b8cce', base: 13600, crit: 25.5, deaths: 1 },
            { id: 'x8', name: 'Tornado', className: 'Gunner', color: '#e08e3c', base: 13000, crit: 24.0, deaths: 0 },
            { id: 'x9', name: 'Bruiserino', className: 'Brawler', color: '#e35d4f', base: 9200, crit: 22.7, deaths: 2 },
            { id: 'x10', name: 'Shieldwall', className: 'Lancer', color: '#4a90d9', base: 7600, crit: 18.4, deaths: 0 },
            { id: 'x11', name: 'Zephyra', className: 'Mystic', color: '#36c9b0', base: 3600, crit: 14.0, deaths: 0 },
            { id: 'x12', name: 'Lirielle', className: 'Priest', color: '#f4d35e', base: 3000, crit: 12.0, deaths: 0 }
        ];
        cached = {
            // live = an ongoing fight (boss floored at 28%, not a kill) so it reads "In combat".
            live: genEncounter('live', 'Shandra Manaya', now - 90000, 90, rosterAll, 30000000, 28),
            a: genEncounter('a', 'Bladescale Naga King', now - 600000, 42, rosterA, 12500000, 0),
            b: genEncounter('b', 'Kelsaik', now - 5400000, 88, rosterB, 24000000, 0),
            c: genEncounter('c', 'Dreadspire Trash', now - 90000000, 15, rosterC, 1800000, 0)
        };
        return cached;
    }

    function genEncounter(id, boss, start, dur, roster, maxHp, minPct) {
        const tl = [], cum = {};
        roster.forEach(p => { cum[p.id] = 0; });
        for (let t = 0; t <= dur; t++) {
            let total = 0;
            const pl = {};
            roster.forEach((p, i) => {
                // Per-second burstiness (x0.5-1.5) so the chart looks like real spiky damage - lets
                // the zoom-dependent smoothing be visible (smooth zoomed out, spikier zoomed in).
                if (t > 0) cum[p.id] += Math.round((p.base + p.base * 0.6 * Math.abs(Math.sin((t + i * 2) / (3 + i)))) * (0.5 + Math.random()));
                pl[p.id] = cum[p.id];
                total += cum[p.id];
            });
            const pct = Math.max(minPct || 0, Math.round((100 - t * (100 / dur)) * 10) / 10);
            tl.push({ t, total, bossHpPct: pct, bossCurHp: Math.round(maxHp * pct / 100), bossMaxHp: maxHp, players: pl });
        }
        const players = roster.map(p => {
            const cls = (p.className || '').toLowerCase();
            return { id: p.id, name: p.name, cls, className: p.className, color: CLASS_COLORS[p.className] || p.color, isSelf: !!p.isSelf, damage: cum[p.id], dps: Math.round(cum[p.id] / dur), crit: p.crit, deaths: p.deaths || 0, skills: genSkills(cls, cum[p.id], p.crit) };
        });
        players.sort((a, b) => b.damage - a.damage);
        // Demo has no per-hit counts, so the aggregate crit is a damage-weighted approximation
        // (real telemetry uses total crits / total hits - see lib/meter.js).
        let totalDmg = 0, wCrit = 0, dths = 0;
        const deathEvents = [];
        players.forEach(p => { totalDmg += p.damage; wCrit += p.crit * p.damage; dths += p.deaths || 0; });
        roster.forEach((p, i) => { for (let k = 0; k < (p.deaths || 0); k++) deathEvents.push({ t: Math.round(dur * (0.3 + 0.5 * (((i + k) % 5) / 5))), name: p.name }); });

        // Event stream: damage dealt/taken, heals from support classes, and death/resurrection markers
        // so the Events tab shows every kind.
        const events = [];
        const healers = roster.filter(p => ['priest', 'mystic'].includes((p.className || '').toLowerCase()));
        for (let t = 1; t <= dur; t++) {
            roster.forEach((p, i) => {
                const ids = DEMO_SKILLS[(p.className || '').toLowerCase()] || [];
                if (!ids.length) return;
                events.push({ t: t - 1 + Math.random(), kind: 'dmg', sId: p.id, sName: p.name, tId: 'boss', tName: boss, skill: ids[(t + i) % ids.length], amount: Math.round(p.base * (0.35 + Math.random() * 0.9)), crit: Math.random() < p.crit / 100 });
            });
            if (t % 4 === 0) {
                const victim = roster[Math.floor(t / 4) % roster.length];
                events.push({ t: t - 1 + Math.random(), kind: 'dmg', sId: 'boss', sName: boss, tId: victim.id, tName: victim.name, skill: 0, amount: Math.round(25000 + Math.random() * 90000), crit: Math.random() < 0.18 });
            }
            if (t % 3 === 0) {
                healers.forEach((h, hi) => {
                    const tgt = roster[(t + hi) % roster.length];
                    const ids = DEMO_SKILLS[(h.className || '').toLowerCase()] || [];
                    events.push({ t: t - 1 + Math.random(), kind: 'heal', sId: h.id, sName: h.name, tId: tgt.id, tName: tgt.name, skill: ids.length ? ids[(t + hi) % ids.length] : 0, amount: Math.round(18000 + Math.random() * 45000), crit: Math.random() < 0.2 });
                });
            }
        }
        // Death + resurrection markers, derived from each player's death count.
        roster.forEach((p, i) => {
            for (let k = 0; k < (p.deaths || 0); k++) {
                const dt = Math.round(dur * (0.3 + 0.5 * (((i + k) % 5) / 5)));
                events.push({ t: dt, kind: 'death', sId: p.id, sName: p.name, tId: p.id, tName: p.name, skill: 0, amount: 0, crit: false });
                if (dt + 6 <= dur) events.push({ t: dt + 6, kind: 'res', sId: p.id, sName: p.name, tId: p.id, tName: p.name, skill: 0, amount: 0, crit: false });
            }
        });
        events.sort((a, b) => a.t - b.t);

        return {
            id, region: 'EU-EN', bossName: boss, start, end: start + dur * 1000, duration: dur,
            totalDamage: totalDmg, totalDps: Math.round(totalDmg / dur),
            totalCrit: totalDmg ? Math.round((wCrit / totalDmg) * 10) / 10 : 0, totalDeaths: dths,
            deathEvents, players, timeline: tl, events
        };
    }

    function genSkills(cls, totalDmg, critRate) {
        const ids = DEMO_SKILLS[cls] || [];
        if (!ids.length || !totalDmg) return [];
        const weights = ids.map((_, i) => Math.pow(0.72, i) * (0.6 + Math.random() * 0.8));
        const wsum = weights.reduce((a, b) => a + b, 0);
        return ids.map((id, i) => {
            const dmg = Math.round(totalDmg * weights[i] / wsum);
            const hits = Math.max(1, Math.round(3 + Math.random() * 35));
            return { id, damage: dmg, hits, crits: Math.min(hits, Math.round(hits * (critRate / 100))) };
        });
    }

    function snapshot() {
        const d = scenarios().live, total = d.totalDamage;
        const entries = d.players.map(p => ({
            id: p.id, name: p.name, className: p.className, color: p.color, isSelf: p.isSelf,
            damage: p.damage, dps: p.dps, crit: p.crit, deaths: p.deaths,
            share: total > 0 ? Math.round(p.damage / total * 1000) / 10 : 0
        }));
        entries.sort((a, b) => b.dps - a.dps);
        const last = d.timeline[d.timeline.length - 1] || {};
        return {
            enabled: true, active: true, inProgress: true, elapsed: d.duration, bossName: d.bossName,
            bossCurHp: last.bossCurHp, bossMaxHp: last.bossMaxHp, bossHpPct: last.bossHpPct,
            totalDamage: total, totalDps: d.totalDps, totalCrit: d.totalCrit, totalDeaths: d.totalDeaths, entries
        };
    }
    function encounter(id) { const d = scenarios(); return d[id] || d.live; }
    function summaries() {
        const d = scenarios();
        return [d.a, d.b, d.c].map(l => ({ id: l.id, bossName: l.bossName, start: l.start, duration: l.duration, totalDps: l.totalDps, players: [] }));
    }

    // Same interface as the live source in app.js, backed by canned data. Actions that only make
    // sense against a running game (stop/clear/window) are inert.
    window.createDemoSource = function createDemoSource() {
        return {
            expandOnBoot: true, // open straight into the expanded view so the preview shows everything
            snapshot: cb => cb(snapshot()),
            current: cb => cb(encounter(null)),
            logs: cb => cb(summaries()),
            log: (id, cb) => cb(encounter(id)),
            settings: cb => cb(demoSettings),
            setSettings: (key, value, cb) => { demoSettings[key] = value; cb(demoSettings); },
            stop: () => {},
            clearLogs: () => {},
            expand: () => {},
            minimize: () => {}
        };
    };
})();
