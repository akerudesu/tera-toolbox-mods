'use strict';

const path = require('path');
const Meter = require('./lib/meter');
const OverlayServer = require('./lib/overlay-server');
const OverlayWindow = require('./lib/overlay-window');
const HistoryStore = require('./lib/history');

// Picks the skill-data region for names/icons. Client language maps precisely; publisher is a
// coarse fallback that can't tell EU EN/FR/GER/RU apart. The setting override wins - needed on
// classic/private servers where auto-detection is often wrong.
function detectRegion(mod) {
    const forced = mod.settings && mod.settings.skillDataRegion;
    if (forced && forced !== 'auto') return String(forced);
    switch (String(mod.language || '').toLowerCase()) {
        case 'fra': return 'EU-FR';
        case 'ger': return 'EU-GER';
        case 'rus': return 'RU';
        case 'kor': return 'KR';
        case 'jpn': return 'JP';
        case 'tw': return 'TW';
        case 'usa': case 'eur': return 'EU-EN';
    }
    switch (String(mod.publisher || '').toLowerCase()) {
        case 'bh': return 'KR';
        case 'pm': return 'JP';
        case 'm5': return 'TW';
        default: return 'EU-EN'; // eme (NA), gf (EU), int / classic / unknown
    }
}

module.exports = function Teralith(mod) {
    const meter = new Meter(mod);
    meter.region = detectRegion(mod);
    const overlay = new OverlayWindow(mod);
    const history = new HistoryStore(path.join(mod.info.path, 'logs'));

    meter.onEncounterEnd = (log) => { history.save(log); };

    const UI_REGIONS = ['auto', 'EU-EN', 'EU-FR', 'EU-GER', 'JP', 'KR', 'RU', 'TW'];
    const UI_THEMES = ['tera', 'onedark', 'dracula', 'nord', 'catppuccin', 'gruvbox', 'solarized', 'rosepine', 'tokyonight', 'darkly'];
    const boolQ = (v) => v === '1' || v === 'true';
    const intQ = (v, lo, hi, def) => { const n = parseInt(v, 10); return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def; };
    function currentSettings() {
        const s = mod.settings || {};
        return {
            theme: s.theme || 'tera',
            autoOpenOnCombat: !!s.autoOpenOnCombat,
            alwaysOnTop: s.alwaysOnTop !== false,
            skillDataRegion: s.skillDataRegion || 'auto',
            combatGapSeconds: typeof s.combatGapSeconds === 'number' ? s.combatGapSeconds : 8,
            endGapSeconds: typeof s.endGapSeconds === 'number' ? s.endGapSeconds : 90,
            maxRows: typeof s.maxRows === 'number' ? s.maxRows : 12,
            region: meter.region
        };
    }
    function applySettingUpdates(q) {
        const s = mod.settings;
        if (!s || !q) return currentSettings();
        if ('alwaysOnTop' in q) { s.alwaysOnTop = boolQ(q.alwaysOnTop); overlay.setAlwaysOnTop(s.alwaysOnTop); }
        if ('autoOpenOnCombat' in q) s.autoOpenOnCombat = boolQ(q.autoOpenOnCombat);
        if ('theme' in q) s.theme = UI_THEMES.indexOf(q.theme) >= 0 ? q.theme : 'tera';
        if ('skillDataRegion' in q) { s.skillDataRegion = UI_REGIONS.indexOf(q.skillDataRegion) >= 0 ? q.skillDataRegion : 'auto'; meter.region = detectRegion(mod); }
        if ('combatGapSeconds' in q) s.combatGapSeconds = intQ(q.combatGapSeconds, 1, 60, 8);
        if ('endGapSeconds' in q) s.endGapSeconds = intQ(q.endGapSeconds, 10, 600, 90);
        if ('maxRows' in q) s.maxRows = intQ(q.maxRows, 1, 40, 12);
        meter.applySettings();
        if (typeof mod.saveSettings === 'function') { try { mod.saveSettings(); } catch (err) { /* ignore */ } }
        return currentSettings();
    }

    const server = new OverlayServer(mod, {
        data: () => meter.snapshot(),
        current: (q) => meter.currentLog(q && q.events === '1'),
        reset: () => meter.reset(),
        stop: () => meter.stop(),
        logs: () => history.list(),
        log: (q) => history.get(q && q.id),
        clearLogs: () => history.clear(),
        minimize: () => overlay.minimize(),
        setExpanded: (q) => overlay.setExpanded(q && (q.on === '1' || q.on === 'true')),
        settings: () => currentSettings(),
        setSettings: (q) => applySettingUpdates(q)
    });

    // Warm the skill-table parse up front so the first Skills view isn't stalled by it.
    try { server.skillMapJson(meter.region); } catch (err) { /* skill data optional */ }

    // Raw interval, not mod.setInterval - it must survive leave_game, where tera-game-state
    // clears mod timers, so encounters still auto-finalize.
    const tickTimer = setInterval(() => {
        try { meter.tick(Date.now()); } catch (err) { /* ignore */ }
    }, 1000);

    // tera-game-state's emitter is shared and outlives us - track handlers so unload can detach them.
    const gameHandlers = [];
    const meHandlers = [];
    function onGame(ev, fn) {
        mod.game.on(ev, fn);
        gameHandlers.push([ev, fn]);
    }
    function onMe(ev, fn) {
        if (mod.game.me && typeof mod.game.me.on === 'function') {
            mod.game.me.on(ev, fn);
            meHandlers.push([ev, fn]);
        }
    }

    // Renders in a real Electron window (or the system browser in CLI mode), not the in-game
    // cash-shop browser. force=false for automatic re-opens so they never steal focus from an
    // already-open overlay; true for explicit user actions.
    function openWindow(force) {
        server.ensureStarted().then((url) => {
            overlay.open(url, force);
        }).catch((err) => {
            mod.error('[Teralith] could not start overlay server: ' + err);
            mod.command.message('Failed to open overlay - see the toolbox console.');
        });
    }

    let openedThisFight = false; // autoOpen latch (hoisted so setEnabled can re-arm it)

    function setEnabled(on) {
        on = !!on;
        const was = meter.isEnabled();
        meter.setEnabled(on);
        if (mod.settings) mod.settings.enabled = on;
        if (typeof mod.saveSettings === 'function') mod.saveSettings();
        openedThisFight = false; // re-arm the combat auto-open
        if (on) openWindow(true);
        else overlay.close();
        if (on && was) mod.command.message('Teralith overlay opened.');
        else mod.command.message('Teralith ' + (on ? 'enabled - overlay open.' : 'disabled - overlay closed.'));
    }

    // Closing the overlay window (the X or the OS close button) is treated exactly like `teralith off`.
    overlay.onUserClose = () => { if (meter.isEnabled()) setEnabled(false); };

    function printHelp() {
        mod.command.message('teralith     - show this help');
        mod.command.message('teralith on  - enable Teralith and open the overlay');
        mod.command.message('teralith off - disable Teralith and close the overlay');
    }

    mod.command.add('teralith', {
        $none() {
            printHelp();
        },
        on() {
            setEnabled(true);
        },
        off() {
            setEnabled(false);
        },
        help() {
            printHelp();
        }
    }, this);

    // Non-forcing re-open on entering the world - no-op if already open, so zoning never steals focus.
    onGame('enter_game', () => {
        if (meter.isEnabled()) openWindow(false);
    });

    // Always attached, checks autoOpenOnCombat live - toggling it in the settings panel takes effect
    // without a relog.
    onMe('enter_combat', () => {
        if (mod.settings && mod.settings.autoOpenOnCombat && meter.isEnabled() && !openedThisFight) {
            openedThisFight = true;
            openWindow(false);
        }
    });
    onMe('leave_combat', () => { openedThisFight = false; });

    // Tear down when the game connection drops. Keep a ref to detach on unload - the socket can
    // outlive a hot-reload that happens without a relog, so stale listeners would otherwise pile up.
    const onConnClose = () => { overlay.close(); server.close(); };
    let serverConnection = null;
    try {
        serverConnection = mod.dispatch.connection.serverConnection;
        serverConnection.once('close', onConnClose);
    } catch (err) { /* connection not available yet - destructor still handles cleanup */ }

    this.destructor = function () {
        clearInterval(tickTimer);
        overlay.close();
        server.close();
        meter.destructor();
        if (serverConnection && typeof serverConnection.removeListener === 'function') {
            try { serverConnection.removeListener('close', onConnClose); } catch (err) { /* ignore */ }
        }
        gameHandlers.forEach((h) => {
            if (typeof mod.game.removeListener === 'function') mod.game.removeListener(h[0], h[1]);
        });
        if (mod.game.me && typeof mod.game.me.removeListener === 'function') {
            meHandlers.forEach((h) => mod.game.me.removeListener(h[0], h[1]));
        }
    };
};
