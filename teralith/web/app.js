(function () {
    'use strict';

    const POLL_MS = 300;
    // demo.js registers window.createDemoSource; it's only present when the dev preview is served.
    const DEMO = window.location.search.includes('demo') && typeof window.createDemoSource === 'function';
    // Set by OverlayWindow when the page runs inside the Electron overlay window. Only there do
    // window.close()/minimize make sense, so the close/minimize buttons show only in that mode.
    const APP = window.location.search.includes('app=1');

    let expanded = false;
    let selectedLogId = null;  // null = live encounter, else a saved log id
    let chartLog = null;
    let chartKey = 'live';     // 'live' or a log id - resets series toggles + zoom when it changes
    let hidden = { raid: true }; // series key -> hidden; raid off by default
    let viewingLog = null;     // saved encounter shown in the table, null = live
    let lastData = null;
    let lastHistSig = '';

    const rowsEl = el('rows'), bossNameEl = el('boss-name'), totalsEl = el('totals');
    const statusEl = el('status'), timerEl = el('timer');
    const meterEl = el('meter'), bossHpBarEl = el('boss-hp-bar'), bossHpTextEl = el('boss-hp-text');
    const chartEl = el('chart'), chartWrapEl = el('chart-wrap'), legendEl = el('legend');
    const chartTitleEl = el('chart-title'), chartSubEl = el('chart-sub');
    const historyListEl = el('history-list');

    function el(id) { return document.getElementById(id); }

    function formatNumber(n) { n = Math.round(n || 0); return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
    function abbrev(n) {
        n = Math.round(n || 0);
        const a = Math.abs(n);
        if (a >= 1e9) return strip((n / 1e9).toFixed(2)) + 'B';
        if (a >= 1e6) return strip((n / 1e6).toFixed(2)) + 'M';
        if (a >= 1e3) return strip((n / 1e3).toFixed(1)) + 'K';
        return String(n);
    }
    function strip(s) { return s.replace(/\.?0+$/, ''); }
    // Plain up to 99,999; K with 1 decimal; M/B with 3 - high precision so big-hit totals stay legible.
    function fmtDamage(n) {
        n = Math.round(n || 0);
        const a = Math.abs(n);
        if (a >= 1e9) return (n / 1e9).toFixed(3) + 'B';
        if (a >= 1e6) return (n / 1e6).toFixed(3) + 'M';
        if (a >= 1e5) return (n / 1e3).toFixed(1) + 'K';
        return formatNumber(n);
    }
    function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); }
    function makeSpan(cls, text) { const s = document.createElement('span'); s.className = cls; s.textContent = text; return s; }
    function pad2(n) { return (n < 10 ? '0' : '') + n; }

    function getJSON(url, cb = () => {}) {
        fetch(url, { cache: 'no-store' })
            .then(r => (r.ok ? r.json() : null))
            .then(cb)
            .catch(() => cb(null));
    }

    // The UI talks to one data source: live overlay endpoints, or canned data from demo.js under
    // ?demo=1. Everything below is source-agnostic - no endpoint or demo branching leaks in.
    const source = DEMO ? window.createDemoSource() : createServerSource();

    function createServerSource() {
        let polling = false; // one /data request in flight at a time; a slow tick must not stack them
        return {
            expandOnBoot: false,
            snapshot(cb, force) {
                if (polling && !force) return;
                polling = true;
                getJSON(`/data?_=${Date.now()}`, d => { polling = false; cb(d); });
            },
            current: (cb, wantEvents) => getJSON('/current' + (wantEvents ? '?events=1' : ''), cb),
            logs: cb => getJSON('/logs', cb),
            log: (id, cb) => getJSON(`/log?id=${encodeURIComponent(id)}`, cb),
            settings: cb => getJSON('/settings', cb),
            setSettings: (key, value, cb) => getJSON(`/settings/set?${key}=${encodeURIComponent(value)}`, cb),
            stop: cb => getJSON('/stop', cb),
            clearLogs: cb => getJSON('/logs/clear', cb),
            expand: on => getJSON(`/expand?on=${on ? 1 : 0}`),
            minimize: () => getJSON('/minimize')
        };
    }

    const KNOWN_THEMES = ['tera', 'onedark', 'dracula', 'nord', 'catppuccin', 'gruvbox', 'solarized', 'rosepine', 'tokyonight', 'darkly'];
    // The canvas can't read CSS vars, so pull the active theme's palette triples and build the exact
    // colours the chart paints with. Re-read on every theme change.
    function readTheme() {
        const cs = getComputedStyle(document.documentElement);
        const t = n => cs.getPropertyValue(n).trim() || '0,0,0';
        const line = t('--line-rgb'), inkF = t('--ink-faint-rgb'), inkB = t('--ink-bright-rgb'),
            inkD = t('--ink-dim-rgb'), danger = t('--danger-rgb'), accent = t('--accent-rgb'), bg = t('--bg-rgb');
        return {
            grid: `rgba(${line},0.14)`, gridSoft: `rgba(${line},0.08)`,
            axis: `rgb(${inkF})`, axisHp: `rgba(${danger},0.7)`,
            raid: `rgb(${inkB})`, boss: `rgb(${danger})`, death: 'rgba(232,75,80,0.55)',
            tipBg: `rgba(${bg},0.92)`, tipBorder: `rgba(${line},0.4)`,
            tipInk: `rgb(${inkB})`, tipInk2: `rgb(${inkD})`, select: `rgba(${accent},0.18)`, hover: `rgba(${inkB},0.4)`
        };
    }
    let chartTheme = readTheme();
    function applyTheme(name) {
        document.documentElement.setAttribute('data-theme', KNOWN_THEMES.includes(name) ? name : 'tera');
        chartTheme = readTheme();
        drawChart(chartLog); // reskin the canvas to match the new palette right away
    }

    // Prefer the real in-game class icon. If the file is missing the img errors out and we drop it,
    // leaving the plain class-coloured tile - there's no drawn fallback.
    function setClassBadge(badge, key, color) {
        badge.style.background = color;
        const img = document.createElement('img');
        img.className = 'cicon';
        img.alt = '';
        img.onerror = () => { if (img.parentNode) badge.removeChild(img); badge.classList.remove('hasicon'); };
        img.src = `/icons/${key}.webp`;
        badge.classList.add('hasicon');
        badge.appendChild(img);
    }

    // Rows are kept and updated in place (not rebuilt) so the bars animate as damage grows.
    let rowEls = {}; // player id -> row element
    function buildRow(e) {
        const row = document.createElement('div');
        row.className = 'row enter' + (e.isSelf ? ' self' : '');
        const track = document.createElement('div'); track.className = 'track';
        const bar = document.createElement('div'); bar.className = 'bar'; track.appendChild(bar); row.appendChild(track);
        const badge = document.createElement('div'); badge.className = 'badge'; row.appendChild(badge);
        const name = makeSpan('name', ''); row.appendChild(name);
        const deaths = makeSpan('deaths', ''); row.appendChild(deaths);
        const crit = makeSpan('crit', ''); row.appendChild(crit);
        const main = document.createElement('span'); main.className = 'main';
        const dval = makeSpan('dval', ''), dpct = makeSpan('dpct', '');
        main.appendChild(dval); main.appendChild(dpct); row.appendChild(main);
        const val = makeSpan('val', ''); row.appendChild(val);
        row._r = { bar, badge, name, deaths, crit, dval, dpct, val, cls: null };
        return row;
    }
    function updateRow(row, e, top) {
        const r = row._r;
        if (e.isSelf) row.classList.add('self'); else row.classList.remove('self');
        r.bar.style.width = (top > 0 ? Math.round((e.damage / top) * 100) : 0) + '%';
        r.bar.style.background = e.color;
        const cls = e.cls || (e.className || '').toLowerCase();
        if (r.cls !== cls) { r.cls = cls; clear(r.badge); r.badge.className = 'badge'; r.badge.title = e.className || ''; setClassBadge(r.badge, cls, e.color); }
        r.name.textContent = e.isSelf ? 'YOU' : (e.name || '?');
        r.deaths.textContent = e.deaths ? String(e.deaths) : '';
        r.crit.textContent = Number(e.crit || 0).toFixed(1) + '%';
        r.dval.textContent = fmtDamage(e.damage);
        r.dpct.textContent = ` (${e.share}%)`;
        r.val.textContent = formatNumber(e.dps);
    }
    function renderRows(entries) {
        let top = 0;
        for (const e of entries) if (e.damage > top) top = e.damage;
        const seen = {};
        for (const e of entries) {
            let row = rowEls[e.id];
            if (!row) { row = buildRow(e); rowEls[e.id] = row; }
            else row.classList.remove('enter'); // only NEW rows animate in; re-ordering must not replay it
            updateRow(row, e, top);
            seen[e.id] = true;
            rowsEl.appendChild(row); // re-append in sorted order
        }
        for (const id in rowEls) if (!seen[id]) { if (rowEls[id].parentNode) rowEls[id].parentNode.removeChild(rowEls[id]); delete rowEls[id]; }
    }

    // Live snapshot from the source - stored, but only rendered to the table when not viewing a log.
    function render(data) {
        if (!data) return;
        lastData = data;
        if (data.enabled === false) {
            if (meterEl) meterEl.style.display = 'none';
            try { window.close(); } catch (e) { /* ignore */ }
            return;
        }
        if (meterEl) meterEl.style.display = '';
        if (viewingLog === null) renderView(fromSnapshot(data));
        updateLiveItem(data); // keep the history "Live" row's timer/DPS/colour current
    }

    function fromSnapshot(d) {
        return {
            live: true, bossName: d.bossName, totalDps: d.totalDps, totalDamage: d.totalDamage,
            totalDeaths: d.totalDeaths, totalCrit: d.totalCrit, active: d.active, elapsed: d.elapsed,
            inProgress: !!d.inProgress, bossHpPct: d.bossHpPct, bossCurHp: d.bossCurHp, bossMaxHp: d.bossMaxHp,
            entries: d.entries || []
        };
    }

    function fromLog(log) {
        const total = log.totalDamage || 0;
        let deaths = 0, wCrit = 0;
        const entries = (log.players || []).map(p => {
            deaths += p.deaths || 0;
            wCrit += (p.crit || 0) * (p.damage || 0);
            return {
                id: p.id, name: p.name, className: p.className, color: p.color, isSelf: p.isSelf,
                damage: p.damage, dps: p.dps, crit: p.crit, deaths: p.deaths,
                share: total > 0 ? Math.round((p.damage / total) * 1000) / 10 : 0
            };
        });
        // Older logs (saved before totalCrit existed) lack it - fall back to a damage-weighted avg.
        const totalCrit = log.totalCrit != null ? log.totalCrit : (total > 0 ? Math.round((wCrit / total) * 10) / 10 : 0);
        // Recover final boss HP% and max HP by scanning the timeline back from the end.
        let hp = null, cur = null, max = null;
        const tl = log.timeline || [];
        for (let k = tl.length - 1; k >= 0; k--) {
            const sm = tl[k];
            if (hp == null && sm.bossHpPct != null) { hp = sm.bossHpPct; cur = sm.bossCurHp; }
            if (max == null && sm.bossMaxHp > 0) max = sm.bossMaxHp;
            if (hp != null && max != null) break;
        }
        return {
            live: false, bossName: log.bossName || 'Unknown', totalDps: log.totalDps, totalDamage: total,
            totalDeaths: deaths, totalCrit, active: false, elapsed: log.duration,
            bossHpPct: hp, bossCurHp: cur, bossMaxHp: max, entries
        };
    }

    function renderView(v) {
        bossNameEl.textContent = v.bossName || 'Teralith';

        // Bar is always in the DOM (reserved height) so toggling HP info never shifts the layout.
        if (v.bossHpPct != null) {
            const pct = Math.max(0, Math.min(100, v.bossHpPct));
            bossHpBarEl.style.width = pct + '%';
            let t = v.bossHpPct + '%';
            if (v.bossMaxHp > 1000) t = `${abbrev(v.bossCurHp)} / ${abbrev(v.bossMaxHp)}   ${v.bossHpPct}%`;
            bossHpTextEl.textContent = t;
        } else {
            bossHpBarEl.style.width = '0';
            bossHpTextEl.textContent = '';
        }

        const entries = v.entries || [];
        if (!entries.length) {
            clear(rowsEl); rowEls = {};
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = v.live ? 'No combat data yet.' : 'No damage recorded.';
            rowsEl.appendChild(empty);
        } else {
            const emp = rowsEl.querySelector('.empty'); if (emp) rowsEl.removeChild(emp);
            renderRows(entries);
        }

        renderTotals(v);

        // "End" only applies to the live view - hide it in saved history, and disable it ("Idle")
        // when there's no in-progress encounter to save.
        const stop = el('btn-stop');
        stop.style.display = v.live ? '' : 'none';
        if (v.live) {
            stop.disabled = !v.inProgress;
            stop.querySelector('span').textContent = v.inProgress ? 'End' : 'Idle';
            stop.title = v.inProgress ? 'End & save this encounter' : 'No encounter in progress';
        }

        statusEl.textContent = v.live ? (v.active ? 'In combat' : (v.elapsed ? 'Combat ended' : 'Waiting for combat...')) : 'Saved encounter';
        timerEl.textContent = v.elapsed ? fmtTime(v.elapsed) : '';
    }

    function renderTotals(v) {
        const has = v.totalDamage > 0;
        totalsEl.querySelector('.deaths').textContent = v.totalDeaths ? String(v.totalDeaths) : '';
        totalsEl.querySelector('.crit').textContent = has ? Number(v.totalCrit || 0).toFixed(1) + '%' : '';
        totalsEl.querySelector('.main .dval').textContent = has ? fmtDamage(v.totalDamage) : '';
        totalsEl.querySelector('.val').textContent = has ? formatNumber(v.totalDps) : '';
    }

    const onSnapshot = d => { if (d) render(d); };
    function poll() { source.snapshot(onSnapshot); }
    function repoll() { source.snapshot(onSnapshot, true); } // force past the in-flight guard after an action

    let pendingReselect = null; // saved-encounter id to restore when the view is re-expanded
    function setExpanded(on) {
        expanded = !!on;
        document.body.classList.toggle('expanded', expanded);
        el('btn-expand').className = 'wbtn' + (expanded ? ' active' : '');
        const chev = el('expand-chevron');
        if (chev) chev.setAttribute('points', expanded ? '3,7.5 6,4 9,7.5' : '3,4.5 6,8 9,4.5');
        source.expand(expanded); // resize the Electron window to match (no-op in preview)
        if (expanded) {
            if (pendingReselect !== null) { const keep = pendingReselect; pendingReselect = null; selectLog(keep); }
            expandedTick(true);
        } else if (selectedLogId !== null) {
            // Compact has no history controls - never strand it on a frozen saved encounter. Drop to
            // the live table but remember the selection to restore when re-expanded.
            pendingReselect = selectedLogId;
            selectLive();
        }
    }

    function selectLive() {
        selectedLogId = null;
        viewingLog = null;
        if (chartKey !== 'live') { chartKey = 'live'; hidden = { raid: true }; zoom = null; skillPlayer = null; }
        if (lastData) renderView(fromSnapshot(lastData)); // restore the live table immediately
        markHistoryActive();
        expandedTick(true);
    }
    let logCache = {}; // id -> full log, so re-opening a saved encounter is instant
    function selectLog(id) {
        selectedLogId = id;
        if (chartKey !== id) { chartKey = id; hidden = { raid: true }; zoom = null; skillPlayer = null; } // keep zoom/toggles when re-clicking the same log
        if (logCache[id]) { viewingLog = logCache[id]; renderView(fromLog(logCache[id])); setChart(logCache[id]); markHistoryActive(); return; }
        markHistoryActive();
        chartTitleEl.textContent = 'Loading…'; chartSubEl.textContent = '';
        source.log(id, log => {
            if (selectedLogId !== id) return; // a newer selection won the race
            if (log) logCache[id] = log;
            viewingLog = log;
            if (log) renderView(fromLog(log));
            setChart(log);
            markHistoryActive();
        });
    }

    let tickN = 0;
    // Chart (source.current) refreshes every tick (~1s); the history list (source.logs, which reads
    // the log directory) only every 3rd tick or when forced, to limit disk churn.
    function expandedTick(force) {
        if (!expanded) return;
        tickN++;
        const doLogs = force || (tickN % 3 === 1);
        if (doLogs) source.logs(list => { if (expanded) renderHistory(list); });
        if (selectedLogId === null && !drag && !pan) { // pause the live chart while drag-zooming or panning
            source.current(log => { if (expanded && selectedLogId === null && !drag && !pan) setChart(log); }, panelMode === 'events');
        }
    }

    function setChart(log) {
        chartLog = log;
        const live = selectedLogId === null;
        if (live) {
            chartTitleEl.textContent = 'Live';
            chartSubEl.textContent = log && log.bossName ? log.bossName : '';
        } else if (log) {
            chartTitleEl.textContent = log.bossName || 'Unknown';
            chartSubEl.textContent = `${dateLabel(log.start)} ${timeLabel(log.start)}  •  ${fmtTime(log.duration)}  •  ${abbrev(log.totalDps)}/s`;
        }
        renderPanel();
    }

    // The chart panel renders either the DPS graph or the per-skill breakdown.
    let panelMode = 'graph';  // 'graph' | 'skills'
    let chartIntro = null;    // { start, p } while the chart draw-in reveal is playing
    let chartIntroKey = null; // chartKey the intro last played for (so it plays once per encounter)
    function renderPanel() {
        if (panelMode === 'events') { renderEvents(chartLog); return; }
        if (panelMode === 'skills') { renderSkills(chartLog); return; }
        renderLegend(chartLog);
        if (chartIntro) return; // the intro loop is already driving the draw
        if (chartLog && (chartLog.timeline || []).length > 1 && chartKey !== chartIntroKey) { chartIntroKey = chartKey; playChartIntro(); }
        else drawChart(chartLog);
    }
    function nowMs() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
    function playChartIntro() { chartIntro = { start: nowMs() }; requestAnimationFrame(stepChartIntro); }
    function stepChartIntro() {
        if (!chartIntro) return;
        chartIntro.p = Math.min(1, (nowMs() - chartIntro.start) / 300); // ~300ms, fast
        const done = chartIntro.p >= 1;
        drawChart(chartLog);
        if (done) chartIntro = null; else requestAnimationFrame(stepChartIntro);
    }
    function setPanelMode(mode) {
        panelMode = (mode === 'skills' || mode === 'events') ? mode : 'graph';
        const panel = el('chart-panel');
        panel.classList.toggle('skills-mode', panelMode === 'skills');
        panel.classList.toggle('events-mode', panelMode === 'events');
        el('mode-graph').className = 'modebtn' + (panelMode === 'graph' ? ' active' : '');
        el('mode-skills').className = 'modebtn' + (panelMode === 'skills' ? ' active' : '');
        el('mode-events').className = 'modebtn' + (panelMode === 'events' ? ' active' : '');
        // The live log is polled without its (large) event stream; fetch a copy with events the
        // moment the Events tab opens on the live encounter.
        if (panelMode === 'events' && selectedLogId === null) { source.current(l => { if (l) { chartLog = l; renderPanel(); } }, true); return; }
        renderPanel();
    }

    let skillPlayer = null;        // selected player id (null = auto: YOU, else top damage)
    const skillMaps = {};          // region -> { class: { skillId: [name, iconName] } }
    const skillMapLoading = {};    // region -> true while fetching

    function skillRegion(log) { return (log && log.region) || (lastData && lastData.region) || 'EU-EN'; }
    // Lazily fetch a region's skill map; re-renders the panel once it lands (names/icons appear).
    // Served by the same host in both modes, so this stays a plain fetch rather than a source call.
    function ensureSkillMap(region) {
        if (skillMaps[region] || skillMapLoading[region]) return;
        skillMapLoading[region] = true;
        getJSON(`/skills/${encodeURIComponent(region)}`, m => {
            skillMapLoading[region] = false;
            if (!m) return; // failed; don't re-render (a later /current tick retries - no fetch loop)
            skillMaps[region] = m;
            if (panelMode === 'skills' || panelMode === 'events') renderPanel();
        });
    }
    function resolveSkill(region, cls, id) {
        const m = skillMaps[region];
        // class skill -> shared/common skill -> DOT/HOT abnormality -> unknown
        const e = m && ((m[cls] && m[cls][id]) || (m.common && m.common[id]) || (m.abnorm && m.abnorm[id]));
        return e ? { name: e[0], icon: e[1] || null } : { name: `Skill #${id}`, icon: null };
    }
    function hexA(hex, a) {
        hex = String(hex || '').replace('#', '');
        if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        const n = parseInt(hex, 16);
        if (isNaN(n)) return `rgba(74,143,224,${a})`;
        return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    }

    // Player chips shared by the Abilities and Events tabs; clicking one re-renders the active panel.
    function buildSwitcher(container, players, selId) {
        clear(container);
        players.forEach(p => {
            const chip = document.createElement('div');
            chip.className = 'skill-sel' + (p.id === selId ? ' active' : '') + (p.isSelf ? ' you' : '');
            const sw = document.createElement('span'); sw.className = 'leg-swatch'; sw.style.background = p.color || '#888'; chip.appendChild(sw);
            chip.appendChild(document.createTextNode(p.isSelf ? 'YOU' : (p.name || '?')));
            if (p.dps) { const v = document.createElement('span'); v.className = 'leg-val'; v.textContent = abbrev(p.dps) + '/s'; chip.appendChild(v); }
            chip.onclick = () => { skillPlayer = p.id; renderPanel(); };
            container.appendChild(chip);
        });
    }

    let skillRowEls = {};       // skill id -> row element (for the currently shown player)
    let skillRowsPlayer = null; // whose rows are in the list (rebuild fresh when it changes)
    function renderSkills(log) {
        const region = skillRegion(log);
        ensureSkillMap(region);
        const players = (log && log.players) || [];
        const switcher = el('skill-players'), list = el('skill-list');
        clear(switcher);
        if (!players.length) { clear(list); skillRowEls = {}; skillRowsPlayer = null; list.appendChild(makeSpan('skills-empty', 'No combat data yet.')); return; }

        // pick the shown player: remembered selection, else YOU, else top damage
        const sel = players.find(p => String(p.id) === String(skillPlayer)) || players.find(p => p.isSelf) || players[0];
        skillPlayer = sel.id;
        buildSwitcher(switcher, players, sel.id);

        // Rebuild the list when the shown player changes (fresh fill-in); otherwise update rows in
        // place so the bars grow smoothly on live ticks.
        if (String(skillRowsPlayer) !== String(sel.id)) { clear(list); skillRowEls = {}; skillRowsPlayer = sel.id; list.appendChild(skillHeadRow()); }

        const skills = (sel.skills || []).slice().sort((a, b) => b.damage - a.damage);
        const emptyEl = list.querySelector('.skills-empty');
        if (!skills.length) { if (!emptyEl) list.appendChild(makeSpan('skills-empty', 'No per-skill data for this encounter.')); return; }
        if (emptyEl) list.removeChild(emptyEl);

        const total = sel.damage || 0, maxDmg = skills[0].damage || 1;
        const cls = sel.cls || (sel.className || '').toLowerCase();
        const seen = {};
        skills.forEach(sk => {
            let row = skillRowEls[sk.id];
            if (!row) { row = buildSkillRow(); skillRowEls[sk.id] = row; }
            else row.classList.remove('enter'); // only NEW skill rows animate in
            updateSkillRow(row, sk, region, cls, total, maxDmg, sel.color);
            seen[sk.id] = true;
            list.appendChild(row);
        });
        for (const id in skillRowEls) if (!seen[id]) { if (skillRowEls[id].parentNode) skillRowEls[id].parentNode.removeChild(skillRowEls[id]); delete skillRowEls[id]; }
    }

    function skillHeadRow() {
        const row = document.createElement('div'); row.className = 'skill-row skill-head';
        row.appendChild(makeSpan('sicon-ph', ''));
        row.appendChild(makeSpan('sname', 'Skill'));
        row.appendChild(makeSpan('sdmg', 'Damage'));
        row.appendChild(makeSpan('scount', 'Hits'));
        row.appendChild(makeSpan('scrit', 'Crit'));
        return row;
    }
    function phIcon(color) { const d = document.createElement('span'); d.className = 'sicon-ph'; d.style.background = hexA(color || '#4a8fe0', 0.5); return d; }
    function buildSkillRow() {
        const row = document.createElement('div'); row.className = 'skill-row enter';
        const bar = document.createElement('div'); bar.className = 'sbar'; row.appendChild(bar);
        const icon = phIcon(null); row.appendChild(icon); // replaced with the real icon on first update
        const name = makeSpan('sname', ''); row.appendChild(name);
        const dmg = document.createElement('span'); dmg.className = 'sdmg';
        const dval = makeSpan('dval', ''), dpct = makeSpan('dpct', '');
        dmg.appendChild(dval); dmg.appendChild(dpct); row.appendChild(dmg);
        const count = makeSpan('scount', ''); row.appendChild(count);
        const crit = makeSpan('scrit', ''); row.appendChild(crit);
        row._s = { bar, icon, name, dval, dpct, count, crit, iconKey: null };
        return row;
    }
    function updateSkillRow(row, sk, region, cls, total, maxDmg, color) {
        const s = row._s;
        s.bar.style.width = (maxDmg > 0 ? Math.round(sk.damage / maxDmg * 100) : 0) + '%';
        s.bar.style.background = hexA(color || '#4a8fe0', 0.3);
        const info = resolveSkill(region, cls, String(sk.id));
        const key = info.icon || '';
        if (s.iconKey !== key) { // set the icon once (and again if the map resolves it later)
            s.iconKey = key;
            let next;
            if (info.icon) {
                next = document.createElement('img'); next.className = 'sicon'; next.alt = '';
                next.onerror = () => { const ph = phIcon(color); if (next.parentNode) next.parentNode.replaceChild(ph, next); s.icon = ph; };
                next.src = `/skill-icon/${info.icon}.png`;
            } else next = phIcon(color);
            if (s.icon.parentNode) s.icon.parentNode.replaceChild(next, s.icon);
            s.icon = next;
        }
        s.name.textContent = info.name;
        const pct = total > 0 ? Math.round(sk.damage / total * 1000) / 10 : 0;
        s.dval.textContent = fmtDamage(sk.damage);
        s.dpct.textContent = ` (${pct}%)`;
        s.count.textContent = String(sk.hits);
        s.crit.textContent = (sk.hits ? Math.round(sk.crits / sk.hits * 1000) / 10 : 0) + '%';
    }

    let eventsPlayer = null; // shown player; a change forces the list back to the newest event
    // Events: an FFLogs-style chronological log for the selected player - damage dealt/taken, heals,
    // deaths, and resurrections.
    function renderEvents(log) {
        const region = skillRegion(log);
        ensureSkillMap(region);
        const players = (log && log.players) || [];
        const switcher = el('event-players'), list = el('event-list');
        if (!players.length) { clear(switcher); clear(list); list.appendChild(makeSpan('skills-empty', 'No combat data yet.')); return; }

        const sel = players.find(p => String(p.id) === String(skillPlayer)) || players.find(p => p.isSelf) || players[0];
        skillPlayer = sel.id;
        buildSwitcher(switcher, players, sel.id);

        // Follow the newest event only when already at the bottom (or when the shown player changed);
        // otherwise a live tick must not yank the user down while they scroll back through the log.
        const switched = String(eventsPlayer) !== String(sel.id);
        eventsPlayer = sel.id;
        const atBottom = switched || (list.scrollHeight - list.scrollTop - list.clientHeight < 24);
        const prevTop = list.scrollTop;

        // Resolve each event's skill against its source's class (covers damage dealt, heals done, and
        // heals received); enemy sources aren't in the map and fall back to a plain label.
        const classById = {};
        players.forEach(p => { classById[String(p.id)] = p.cls || (p.className || '').toLowerCase(); });
        const pid = String(sel.id);
        const mine = (log.events || []).filter(e => e.sId === pid || e.tId === pid);
        clear(list);
        if (!mine.length) {
            list.appendChild(makeSpan('skills-empty', log.events ? 'No events for this player.' : 'This saved encounter has no event log.'));
            return;
        }
        // A long fight logs thousands of events; only the most recent slice is worth rendering.
        const MAX = 400;
        const slice = mine.length > MAX ? mine.slice(mine.length - MAX) : mine;
        slice.forEach(e => list.appendChild(buildEventRow(e, pid, region, classById)));
        list.scrollTop = atBottom ? list.scrollHeight : prevTop;
    }

    function buildEventRow(e, pid, region, classById) {
        const row = document.createElement('div');
        row.appendChild(makeSpan('ev-time', fmtEventTime(e.t)));

        if (e.kind === 'death' || e.kind === 'res') {
            row.className = 'event-row ' + e.kind;
            row.appendChild(makeSpan('ev-icon-ph ' + e.kind + '-mark', ''));
            row.appendChild(makeSpan('ev-name', e.kind === 'death' ? 'Defeated' : 'Resurrected'));
            row.appendChild(makeSpan('ev-tgt', e.tName || '?'));
            return row;
        }

        const heal = e.kind === 'heal';
        const dealt = e.sId === pid; // viewed player is the source
        row.className = 'event-row ' + (heal ? 'heal' : (dealt ? 'dealt' : 'taken'));

        const info = e.skill ? resolveSkill(region, classById[e.sId] || '', String(e.skill)) : { name: heal ? 'Heal' : 'Attack', icon: null };
        if (info.icon) {
            const img = document.createElement('img'); img.className = 'ev-icon'; img.alt = '';
            img.onerror = () => { const ph = makeSpan('ev-icon-ph', ''); if (img.parentNode) img.parentNode.replaceChild(ph, img); };
            img.src = `/skill-icon/${info.icon}.png`;
            row.appendChild(img);
        } else row.appendChild(makeSpan('ev-icon-ph', ''));

        row.appendChild(makeSpan('ev-name', info.name));
        row.appendChild(makeSpan('ev-amt' + (e.crit ? ' crit' : ''), (heal ? '+' : '') + fmtDamage(e.amount)));
        if (e.crit) row.appendChild(makeSpan('ev-crit', 'crit'));
        row.appendChild(makeSpan('ev-tgt', `${e.sName || '?'} → ${e.tName || '?'}`));
        return row;
    }
    function fmtEventTime(t) {
        const ms = Math.max(0, Math.round(t * 1000));
        return `${pad2(Math.floor(ms / 60000))}:${pad2(Math.floor(ms / 1000) % 60)}.${String(ms % 1000).padStart(3, '0')}`;
    }

    function renderHistory(list) {
        list = list || [];
        const sig = list.map(s => s.id).join(',') + '|' + selectedLogId;
        if (sig === lastHistSig) { markHistoryActive(); return; }
        lastHistSig = sig;

        clear(historyListEl);
        historyListEl.appendChild(liveItem());

        if (!list.length) {
            const e = document.createElement('div');
            e.className = 'hist-empty';
            e.textContent = 'No saved encounters yet.';
            historyListEl.appendChild(e);
        }

        let curKey = null;
        for (const s of list) {
            const k = dateKey(s.start);
            if (k !== curKey) {
                curKey = k;
                const h = document.createElement('div');
                h.className = 'hist-date';
                h.textContent = dateLabel(s.start);
                historyListEl.appendChild(h);
            }
            historyListEl.appendChild(histItem(s));
        }
        markHistoryActive();
    }

    function liveItem() {
        const d = document.createElement('div');
        d.className = 'hist-item live' + (selectedLogId === null ? ' active' : '');
        d.setAttribute('data-live', '1');
        d.appendChild(makeSpan('hist-name', 'Live (current)'));
        const sub = document.createElement('div'); sub.className = 'hist-sub';
        sub.appendChild(makeSpan('hist-time', ''));
        sub.appendChild(makeSpan('hist-dps', ''));
        d.appendChild(sub);
        d.onclick = () => selectLive();
        if (lastData) applyLive(d, lastData);
        return d;
    }
    // Reflect the live fight in the "Live (current)" row: green name + running timer/DPS when in
    // combat, grey + "idle" otherwise.
    function applyLive(item, data) {
        if (data.active) item.classList.add('combat'); else item.classList.remove('combat');
        const t = item.querySelector('.hist-time'), dp = item.querySelector('.hist-dps');
        if (t) t.textContent = data.active ? fmtTime(data.elapsed) : (data.elapsed ? 'ended' : 'idle');
        if (dp) dp.textContent = data.totalDps ? abbrev(data.totalDps) + '/s' : '';
    }
    function updateLiveItem(data) {
        const item = historyListEl.querySelector('.hist-item.live');
        if (item) applyLive(item, data);
    }
    function histItem(s) {
        const d = document.createElement('div');
        d.className = 'hist-item' + (selectedLogId === s.id ? ' active' : '');
        d.setAttribute('data-id', s.id);
        d.appendChild(makeSpan('hist-name', s.bossName || 'Unknown'));
        const sub = document.createElement('div'); sub.className = 'hist-sub';
        sub.appendChild(makeSpan('hist-time', `${timeLabel(s.start)} · ${fmtTime(s.duration)}`));
        sub.appendChild(makeSpan('hist-dps', abbrev(s.totalDps) + '/s'));
        d.appendChild(sub);
        d.onclick = () => selectLog(s.id);
        return d;
    }

    function markHistoryActive() {
        const items = historyListEl.getElementsByClassName('hist-item');
        for (const it of items) {
            const isLive = it.getAttribute('data-live') === '1';
            const on = isLive ? (selectedLogId === null) : (it.getAttribute('data-id') === selectedLogId);
            if (on) it.classList.add('active'); else it.classList.remove('active');
        }
    }

    // Date grouping keyed in local time (not UTC), so "Today" matches the player's clock.
    function dateKey(ms) { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
    function dateLabel(ms) {
        const d = new Date(ms), n = new Date();
        if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return 'Today';
        return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
    }
    function timeLabel(ms) { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }

    let zoom = null;        // { t0, t1 } visible window, or null = full
    let hover = null;       // hover pixel x within the plot, or null
    let drag = null;        // { x0, x1 } while left-drag-selecting a zoom range
    let pan = null;         // { x } while middle-drag panning the view left/right
    let chartGeom = null;   // last draw geometry, for mouse -> time mapping

    function seriesDefs(log) {
        const players = (log && log.players) || [];
        const defs = [{ key: 'raid', name: 'Raid', color: chartTheme.raid, axis: 'dps', width: 2, val: log ? log.totalDps : 0, cum: s => s.total || 0 }];
        players.forEach(p => {
            const id = p.id;
            defs.push({ key: String(id), name: p.isSelf ? 'YOU' : p.name, color: p.color, axis: 'dps', width: 1.2, val: p.dps, cum: s => (s.players && s.players[id]) || 0 });
        });
        defs.push({ key: 'boss', name: 'Boss HP', color: chartTheme.boss, axis: 'hp', hp: true });
        return defs;
    }

    // Round up to a "nice" axis max, but with fine steps so a ~24K peak lands on 25K (not 50K) -
    // otherwise the coarse 1/2/5 ladder wastes up to half the DPS axis.
    function niceMax(v) {
        if (v <= 0) return 1;
        const pow = Math.pow(10, Math.floor(Math.log(v) / Math.LN10)), n = v / pow;
        const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
        for (const step of steps) if (n <= step) return step * pow;
        return 10 * pow;
    }
    function clampNum(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
    function fmtTime(sec) { sec = Math.max(0, Math.round(sec)); return `${Math.floor(sec / 60)}:${pad2(sec % 60)}`; }
    function niceTimeStep(span) {
        const c = [5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800];
        for (const s of c) if (span / s <= 8) return s;
        return 3600;
    }
    // Cumulative value interpolated at time t (timeline is ~1 sample/second).
    function valAt(tl, t, acc) {
        const n = tl.length; if (!n) return 0;
        if (t <= tl[0].t) return acc(tl[0]);
        if (t >= tl[n - 1].t) return acc(tl[n - 1]);
        let lo = 0, hi = n - 1;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (tl[mid].t <= t) lo = mid; else hi = mid; }
        const a = tl[lo], b = tl[hi], f = (t - a.t) / ((b.t - a.t) || 1);
        return acc(a) + (acc(b) - acc(a)) * f;
    }
    // Rolling-average DPS over a W-second window CENTERED on t (smooths per-skill spikes without
    // lag). Centering means the fight's start shows its real early rate instead of ramping up from
    // zero; the window shrinks against the timeline ends.
    function dpsAt(tl, acc, t, W) {
        const n = tl.length; if (!n) return 0;
        const half = W / 2;
        const a = Math.max(0, t - half), b = Math.min(tl[n - 1].t, t + half), w = b - a;
        return w > 0 ? Math.max(0, (valAt(tl, b, acc) - valAt(tl, a, acc)) / w) : 0;
    }
    function hpAcc(s) { return s.bossHpPct != null ? s.bossHpPct : 0; }

    function chartView(log) {
        const tl = (log && log.timeline) || [];
        const maxT = tl.length ? Math.max(1, tl[tl.length - 1].t) : 1;
        const t0 = zoom ? clampNum(zoom.t0, 0, maxT - 0.5) : 0;
        const t1 = zoom ? clampNum(zoom.t1, t0 + 0.5, maxT) : maxT;
        return { tl, maxT, t0, t1, span: t1 - t0 };
    }

    function drawChart(log) {
        const Wpx = chartWrapEl.clientWidth, H = chartWrapEl.clientHeight;
        if (Wpx < 2 || H < 2) return;
        const dpr = window.devicePixelRatio || 1;
        chartEl.width = Math.floor(Wpx * dpr); chartEl.height = Math.floor(H * dpr);
        const ctx = chartEl.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, Wpx, H);
        ctx.font = '9px "Segoe UI",Tahoma,sans-serif';

        const padL = 46, padR = 34, padT = 6, padB = 16;
        const pw = Wpx - padL - padR, ph = H - padT - padB;
        if (pw < 4 || ph < 4) return;

        const v = chartView(log), tl = v.tl;
        chartGeom = { padL, padT, pw, ph, t0: v.t0, t1: v.t1 };

        if (!tl.length) {
            ctx.fillStyle = chartTheme.axis; ctx.font = '11px "Segoe UI",sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText('No encounter data yet.', padL + pw / 2, padT + ph / 2);
            return;
        }

        // Rolling-average window (seconds) proportional to the visible span, so zooming in reduces
        // the smoothing (more detail) and zooming out increases it. Low floor keeps the proportion
        // meaningful at tight zoom; cap keeps very long fights readable.
        const W = clampNum(v.span * 0.04, 1.5, 20);
        const xOf = t => padL + ((t - v.t0) / v.span) * pw;

        // sample each visible DPS series across pixels
        const step = 2, cols = [];
        for (let x = 0; x <= pw; x += step) cols.push(v.t0 + (x / pw) * v.span);
        const defs = seriesDefs(log);
        let maxDps = 1;
        defs.forEach(d => {
            if (d.axis !== 'dps' || hidden[d.key]) return;
            d.samp = cols.map(t => dpsAt(tl, d.cum, t, W));
            for (const val of d.samp) if (val > maxDps) maxDps = val;
        });
        maxDps = niceMax(maxDps * 1.02); // tiny headroom so the peak line doesn't sit on the top edge
        const yDps = val => padT + ph - (val / maxDps) * ph;
        const yHp = val => padT + ph - (val / 100) * ph;

        // horizontal grid + left(DPS)/right(HP%) axis labels
        ctx.textBaseline = 'middle'; ctx.lineWidth = 1;
        for (let g = 0; g <= 4; g++) {
            const gy = padT + ph * g / 4;
            ctx.strokeStyle = chartTheme.grid; ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(padL + pw, gy); ctx.stroke();
            ctx.fillStyle = chartTheme.axis; ctx.textAlign = 'right'; ctx.fillText(abbrev(maxDps * (1 - g / 4)), padL - 4, gy);
            ctx.fillStyle = chartTheme.axisHp; ctx.textAlign = 'left'; ctx.fillText(Math.round(100 * (1 - g / 4)) + '%', padL + pw + 4, gy);
        }
        // vertical time grid + m:ss labels
        ctx.fillStyle = chartTheme.axis; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        const tStep = niceTimeStep(v.span);
        for (let tt = Math.ceil(v.t0 / tStep) * tStep; tt <= v.t1 + 0.001; tt += tStep) {
            const gx = xOf(tt);
            ctx.strokeStyle = chartTheme.gridSoft; ctx.beginPath(); ctx.moveTo(gx, padT); ctx.lineTo(gx, padT + ph); ctx.stroke();
            ctx.fillText(fmtTime(tt), gx, padT + ph + 3);
        }

        // reveal the data left-to-right during the intro animation (axes/grid stay put)
        const introP = chartIntro ? (1 - Math.pow(1 - chartIntro.p, 2)) : 1;
        if (introP < 1) { ctx.save(); ctx.beginPath(); ctx.rect(padL, padT, pw * introP, ph); ctx.clip(); }

        // death markers (red verticals)
        const deaths = (log && log.deathEvents) || [];
        ctx.strokeStyle = chartTheme.death; ctx.setLineDash([3, 3]);
        deaths.forEach(dth => { if (dth.t >= v.t0 && dth.t <= v.t1) { const dx = xOf(dth.t); ctx.beginPath(); ctx.moveTo(dx, padT); ctx.lineTo(dx, padT + ph); ctx.stroke(); } });
        ctx.setLineDash([]);

        function drawDps(d) {
            if (hidden[d.key] || !d.samp) return;
            ctx.beginPath(); ctx.strokeStyle = d.color; ctx.lineWidth = d.width;
            // Skip the leading zeros (the t=0 origin) so the line starts at the first real value
            // instead of shooting straight up from the axis; mid-fight zeros still draw.
            let started = false;
            for (let i = 0; i < d.samp.length; i++) {
                if (!started && d.samp[i] <= 0) continue;
                const xx = padL + Math.min(i * step, pw);
                if (!started) { ctx.moveTo(xx, yDps(d.samp[i])); started = true; }
                else ctx.lineTo(xx, yDps(d.samp[i]));
            }
            ctx.stroke();
        }
        function drawHp(d) {
            if (hidden[d.key]) return;
            ctx.beginPath(); ctx.strokeStyle = d.color; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
            for (let i = 0; i < cols.length; i++) { const xx = padL + Math.min(i * step, pw); const yy = yHp(valAt(tl, cols[i], hpAcc)); if (i === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy); }
            ctx.stroke(); ctx.setLineDash([]);
        }
        defs.forEach(d => { if (d.axis === 'dps' && d.key !== 'raid') drawDps(d); });
        defs.forEach(d => { if (d.key === 'raid') drawDps(d); else if (d.hp) drawHp(d); });
        if (introP < 1) ctx.restore();

        // drag-select rectangle
        if (drag) {
            const xa = clampNum(Math.min(drag.x0, drag.x1), padL, padL + pw), xb = clampNum(Math.max(drag.x0, drag.x1), padL, padL + pw);
            ctx.fillStyle = chartTheme.select; ctx.fillRect(xa, padT, xb - xa, ph);
        }
        // hover line + tooltip
        if (hover != null && hover >= padL && hover <= padL + pw) drawHover(ctx, log, v, defs, W, xOf, padL, padT, pw, ph, tl);
    }

    function drawHover(ctx, log, v, defs, W, xOf, padL, padT, pw, ph, tl) {
        const th = v.t0 + ((hover - padL) / pw) * v.span;
        ctx.strokeStyle = chartTheme.hover; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(hover, padT); ctx.lineTo(hover, padT + ph); ctx.stroke();

        let rows = [];
        defs.forEach(d => { if (d.axis === 'dps' && !hidden[d.key] && d.samp) rows.push({ name: d.name, color: d.color, v: dpsAt(tl, d.cum, th, W) }); });
        rows.sort((a, b) => b.v - a.v);
        if (rows.length > 8) rows = rows.slice(0, 8);
        const lines = [{ name: fmtTime(th), color: null, v: null }].concat(rows);
        let near = null; (log.deathEvents || []).forEach(dh => { if (Math.abs(xOf(dh.t) - hover) < 5) near = dh; });
        if (near) lines.push({ name: near.name, color: '#e84b50', death: true, v: null });

        ctx.font = '10px "Segoe UI",Tahoma,sans-serif';
        let wBox = 0; lines.forEach(l => { const s = (l.death ? '*  ' : '') + l.name + (l.v != null ? '  ' + abbrev(l.v) : ''); wBox = Math.max(wBox, ctx.measureText(s).width); });
        wBox += 20; const hBox = lines.length * 14 + 6;
        let bx = hover + 10; if (bx + wBox > padL + pw) bx = hover - wBox - 10;
        const by = padT + 4;
        ctx.fillStyle = chartTheme.tipBg; ctx.strokeStyle = chartTheme.tipBorder;
        ctx.fillRect(bx, by, wBox, hBox); ctx.strokeRect(bx, by, wBox, hBox);
        ctx.textBaseline = 'middle';
        lines.forEach((l, i) => {
            const ly = by + 10 + i * 14;
            ctx.textAlign = 'left';
            if (l.death) { // red "*" marker + name for a death at this time
                ctx.fillStyle = '#e84b50';
                ctx.font = 'bold 13px "Segoe UI",Tahoma,sans-serif'; ctx.fillText('*', bx + 6, ly + 3);
                ctx.font = '10px "Segoe UI",Tahoma,sans-serif'; ctx.fillText(l.name, bx + 16, ly);
                return;
            }
            if (l.color) { ctx.fillStyle = l.color; ctx.fillRect(bx + 6, ly - 4, 8, 8); }
            ctx.fillStyle = i === 0 ? chartTheme.tipInk : chartTheme.tipInk2; ctx.fillText(l.name, bx + (l.color ? 18 : 6), ly);
            if (l.v != null) { ctx.fillStyle = chartTheme.tipInk2; ctx.textAlign = 'right'; ctx.fillText(abbrev(l.v) + '/s', bx + wBox - 6, ly); }
        });
    }

    function renderLegend(log) {
        clear(legendEl);
        seriesDefs(log).forEach(d => {
            const item = document.createElement('span');
            item.className = 'leg-item' + (hidden[d.key] ? ' off' : '');
            const sw = document.createElement('span'); sw.className = 'leg-swatch'; sw.style.background = d.color; item.appendChild(sw);
            item.appendChild(document.createTextNode(d.name));
            if (d.axis === 'dps' && d.val) { const vv = document.createElement('span'); vv.className = 'leg-val'; vv.textContent = abbrev(d.val) + '/s'; item.appendChild(vv); }
            item.onclick = () => { hidden[d.key] = !hidden[d.key]; item.className = 'leg-item' + (hidden[d.key] ? ' off' : ''); drawChart(chartLog); };
            legendEl.appendChild(item);
        });
    }

    // Map a mouse event to a plot pixel x (or null if outside).
    function chartMouseX(e) {
        if (!chartGeom) return null;
        const r = chartEl.getBoundingClientRect();
        return e.clientX - r.left;
    }
    // Map a plot pixel x -> time using geometry `g` (defaults to the latest draw). A drag passes the
    // geometry snapshot from mousedown so a live refresh mid-drag can't skew the zoom range.
    function chartTimeAt(x, g = chartGeom) {
        if (!g) return 0;
        const f = (x - g.padL) / g.pw;
        return g.t0 + clampNum(f, 0, 1) * (g.t1 - g.t0);
    }
    function chartPan(dir) {
        const v = chartView(chartLog);
        if (!zoom) zoom = { t0: v.t0, t1: v.t1 };
        const shift = (zoom.t1 - zoom.t0) * 0.3 * dir;
        const w = zoom.t1 - zoom.t0;
        const nt0 = clampNum(zoom.t0 + shift, 0, v.maxT - w);
        zoom = { t0: nt0, t1: nt0 + w };
        drawChart(chartLog);
    }
    function chartZoomReset() { zoom = null; drawChart(chartLog); }
    // Middle-drag panning: shift the zoomed window so the grabbed point follows the cursor.
    function chartDoPan(x) {
        if (!chartGeom || !pan) return;
        const vw = chartView(chartLog), w = vw.t1 - vw.t0;
        if (w >= vw.maxT) { pan.x = x; return; } // full view: nothing to scroll
        const dt = (x - pan.x) / chartGeom.pw * w;
        pan.x = x;
        const nt0 = clampNum(vw.t0 - dt, 0, vw.maxT - w);
        zoom = { t0: nt0, t1: nt0 + w };
        hover = null;
        scheduleRedraw();
    }
    let rafPending = false;
    function scheduleRedraw() { if (rafPending) return; rafPending = true; requestAnimationFrame(() => { rafPending = false; drawChart(chartLog); }); }
    function initChart() {
        // Throttle hover/drag redraws to one per frame - each redraw resamples every visible line.
        chartEl.addEventListener('mousemove', e => {
            const x = chartMouseX(e);
            if (pan) { chartDoPan(x); return; }
            if (drag) drag.x1 = x;
            hover = x; scheduleRedraw();
        });
        chartEl.addEventListener('mouseleave', () => { hover = null; if (!drag && !pan) scheduleRedraw(); });
        chartEl.addEventListener('mousedown', e => {
            const x = chartMouseX(e);
            if (e.button === 1) { e.preventDefault(); pan = { x }; return; } // middle button = pan
            if (e.button !== 0) return;                                       // ignore right button
            drag = { x0: x, x1: x, geom: chartGeom };                         // left button = zoom-select
        });
        window.addEventListener('mouseup', () => {
            if (pan) { pan = null; return; }
            if (!drag) return;
            const a = Math.min(drag.x0, drag.x1), b = Math.max(drag.x0, drag.x1);
            if (b - a > 5) { const t0 = chartTimeAt(a, drag.geom), t1 = chartTimeAt(b, drag.geom); if (t1 - t0 > 0.5) zoom = { t0, t1 }; }
            drag = null; drawChart(chartLog);
        });
        // Focus stolen mid-drag (alt-tab, game reclaiming focus) never delivers our mouseup - clear
        // the drag/pan so their overlays can't stick on subsequent redraws.
        window.addEventListener('blur', () => { drag = null; pan = null; hover = null; scheduleRedraw(); });
        chartEl.addEventListener('wheel', e => {
            if (!chartLog) return;
            e.preventDefault();
            const v = chartView(chartLog), ct = chartTimeAt(chartMouseX(e));
            const factor = e.deltaY < 0 ? 0.8 : 1.25;
            const w = clampNum((v.t1 - v.t0) * factor, 2, v.maxT);
            const t0 = clampNum(ct - (ct - v.t0) * (w / (v.t1 - v.t0)), 0, v.maxT - w);
            zoom = (w >= v.maxT) ? null : { t0, t1: t0 + w };
            drawChart(chartLog);
        }, { passive: false });
    }

    // In-app confirmation dialog (more reliable + better-looking than window.confirm, which is
    // jarring and unreliable under Wine). Calls onYes() only if the user confirms.
    function confirmDialog(msg, okLabel, onYes) {
        const modal = el('modal');
        el('modal-msg').textContent = msg;
        el('modal-ok').textContent = okLabel || 'OK';
        const close = () => { modal.className = 'modal-hidden'; modal.onclick = null; };
        el('modal-cancel').onclick = close;
        el('modal-ok').onclick = () => { close(); onYes(); };
        modal.onclick = e => { if (e.target === modal) close(); }; // click backdrop = cancel
        modal.className = '';
    }

    function openSettings() { source.settings(s => { if (s) fillSettings(s); showSettings(); }); }
    function showSettings() { el('settings-modal').className = ''; }
    function closeSettings() { el('settings-modal').className = 'modal-hidden'; }
    function fillSettings(s) {
        el('set-theme').value = s.theme || 'tera';
        el('set-alwaysOnTop').checked = !!s.alwaysOnTop;
        el('set-autoOpenOnCombat').checked = !!s.autoOpenOnCombat;
        el('set-skillDataRegion').value = s.skillDataRegion || 'auto';
        el('set-combatGapSeconds').value = s.combatGapSeconds;
        el('set-endGapSeconds').value = s.endGapSeconds;
        el('set-maxRows').value = s.maxRows;
        el('settings-region-hint').textContent = (!s.skillDataRegion || s.skillDataRegion === 'auto') ? `Auto-detected: ${s.region || '?'}` : '';
    }
    function pushSetting(key, value) {
        source.setSettings(key, value, s => { if (s && key === 'skillDataRegion') fillSettings(s); });
    }
    function bindSettings() {
        const chk = id => { const e = el(id); e.onchange = () => pushSetting(id.slice(4), e.checked ? 1 : 0); };
        const num = id => { const e = el(id); e.onchange = () => pushSetting(id.slice(4), e.value); };
        chk('set-alwaysOnTop'); chk('set-autoOpenOnCombat');
        num('set-combatGapSeconds'); num('set-endGapSeconds'); num('set-maxRows');
        el('set-skillDataRegion').onchange = () => pushSetting('skillDataRegion', el('set-skillDataRegion').value);
        el('set-theme').onchange = () => { const v = el('set-theme').value; applyTheme(v); pushSetting('theme', v); };
        el('settings-close').onclick = closeSettings;
        el('settings-modal').onclick = ev => { if (ev.target === el('settings-modal')) closeSettings(); };
    }

    function wire() {
        el('btn-settings').onclick = openSettings;
        bindSettings();
        el('btn-expand').onclick = () => setExpanded(!expanded);

        const min = el('btn-min'), close = el('btn-close');
        if (APP) {
            min.onclick = () => source.minimize();
            close.onclick = () => { try { window.close(); } catch (e) { /* ignore */ } };
        } else {
            min.style.display = 'none';
            close.style.display = 'none';
        }

        el('btn-stop').onclick = () => source.stop(() => { lastHistSig = ''; selectLive(); repoll(); });
        el('btn-clear-logs').onclick = () => confirmDialog('Delete all saved encounter logs?', 'Delete', () => {
            source.clearLogs(() => { logCache = {}; lastHistSig = ''; selectLive(); });
        });

        el('chart-left').onclick = () => chartPan(-1);
        el('chart-right').onclick = () => chartPan(1);
        el('chart-reset').onclick = () => chartZoomReset();
        el('mode-graph').onclick = () => setPanelMode('graph');
        el('mode-skills').onclick = () => setPanelMode('skills');
        el('mode-events').onclick = () => setPanelMode('events');
        initChart();

        window.addEventListener('resize', () => { if (expanded) drawChart(chartLog); });
    }

    wire();
    source.settings(s => { if (s) applyTheme(s.theme); }); // apply the saved theme on load
    poll();
    if (source.expandOnBoot) setExpanded(true); // preview the full expanded UI from ?demo=1
    window.setInterval(poll, POLL_MS);
    window.setInterval(expandedTick, 1000);
})();
