'use strict';

// The in-game cash-shop browser (S_OPEN_AWESOMIUM_WEB_URL / CoherentGT) is a fixed-size,
// game-managed window that can't be resized and renders the page poorly, so we open our own.
// Primary path: mods run inside the toolbox's Electron main process, so we spawn a real
// BrowserWindow - proven to work on Windows and under Proton/Wine, since the toolbox's own
// main window is the same frameless-resizable type. Fallback: in CLI mode there's no Electron,
// so we hand the URL to the system browser (and always print it as a last resort).
//
// Pinned to Electron 11 (Chromium 87 / Node 12) APIs - what the toolbox ships.

const DEFAULT_WIDTH = 360;
const DEFAULT_HEIGHT = 440;
const DEFAULT_EXPANDED_WIDTH = 760;
const DEFAULT_EXPANDED_HEIGHT = 640;
const MIN_WIDTH = 320;   // keeps the header controls on one line; rows ellipsize below this anyway
const MIN_HEIGHT = 180;
const CASCADE_STEP = 30; // px offset per extra overlay when multi-boxing, so they don't stack

// Overlays currently showing a window (across all per-client mod instances in this process).
// Used to cascade multi-boxed windows and to avoid clobbering each other's saved bounds.
const openOverlays = new Set();

// In CLI mode the `electron` package resolves to a *path string* (not the API), so we gate on
// the Electron runtime actually being present before trusting the require.
function getElectron() {
    if (!process.versions || !process.versions.electron) return null;
    try {
        const electron = require('electron');
        if (electron && electron.BrowserWindow && electron.app) return electron;
    } catch (err) { /* not running under an Electron runtime */ }
    return null;
}

// Tell the page it is running inside the Electron overlay window (enables the header X, which
// can only close a script-controlled window - never a user-opened browser tab).
function withAppFlag(url) {
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'app=1';
}

class OverlayWindow {
    constructor(mod) {
        this.mod = mod;
        this.electron = getElectron();
        this.win = null;
        this.saveTimer = null;
        this.externalOpened = false; // browser fallback: spawn a tab only once unless forced
        this.onUserClose = null;     // fires only when the *user* closes the window, not the mod
        this.expanded = false;
    }

    get available() {
        return !!this.electron;
    }

    isOpen() {
        return !!(this.win && !this.win.isDestroyed());
    }

    // `force` is set for explicit user actions (the `dps` command) and cleared for automatic
    // re-opens (entering world / combat), so auto-opens never steal focus or spam browser tabs.
    open(url, force) {
        this.url = url;
        if (this.electron) {
            try {
                this.openWindow(url, !!force);
                return;
            } catch (err) {
                this.mod.error('[Teralith] could not open overlay window, falling back to browser: ' + err);
            }
        }
        this.openExternal(url, !!force);
    }

    openWindow(url, force) {
        const { BrowserWindow } = this.electron;

        if (this.isOpen()) {
            if (force) {
                try {
                    if (this.win.isMinimized()) this.win.restore();
                    this.win.show();
                    this.win.focus();
                } catch (err) { /* ignore */ }
            }
            return; // never create a second window for the same overlay
        }

        // Cascade away from overlays already open (multi-boxing) so windows don't stack.
        const bounds = this.resolveBounds(openOverlays.size);
        const alwaysOnTop = this.alwaysOnTop();

        const win = new BrowserWindow({
            title: 'Teralith',
            width: bounds.width,
            height: bounds.height,
            x: bounds.x,
            y: bounds.y,
            minWidth: MIN_WIDTH,
            minHeight: MIN_HEIGHT,
            frame: false,            // the page draws its own draggable header
            transparent: false,      // transparency is unreliable under Wine
            backgroundColor: '#070b12',
            resizable: true,
            skipTaskbar: false,
            alwaysOnTop: alwaysOnTop,
            show: false,             // wait for ready-to-show to avoid a white flash
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                enableRemoteModule: false,
                devTools: false
            }
        });

        // 'screen-saver' keeps it above full-screen-ish game windows where supported; plain
        // alwaysOnTop is the fallback where that level string isn't honored.
        if (alwaysOnTop) {
            try { win.setAlwaysOnTop(true, 'screen-saver'); } catch (err) { try { win.setAlwaysOnTop(true); } catch (e2) { /* ignore */ } }
        }

        win.loadURL(withAppFlag(url));
        win.once('ready-to-show', () => { try { win.show(); } catch (err) { /* ignore */ } });

        const persist = () => this.scheduleSaveBounds();
        win.on('move', persist);
        win.on('resize', persist);
        win.on('close', () => this.saveBounds());
        win.on('closed', () => {
            openOverlays.delete(this);
            if (this.win === win) this.win = null;
            // A user close (header X or OS close) counts as disabling the meter. Mod-driven
            // closes (dps off, disconnect, unload) flag the window first via close().
            if (!win.__dpsModClosing && typeof this.onUserClose === 'function') {
                try { this.onUserClose(); } catch (err) { /* ignore */ }
            }
        });

        this.win = win;
        this.expanded = false; // the page boots collapsed
        openOverlays.add(this);
    }

    openExternal(url, force) {
        // Don't spawn a second tab on auto re-opens (world / combat) - otherwise every zone
        // change spams a new tab and a chat line.
        if (this.externalOpened && !force) return;

        let opened = false;

        // Have Electron but couldn't make a window: prefer its shell opener over spawning.
        if (this.electron && this.electron.shell) {
            try { this.electron.shell.openExternal(url); opened = true; } catch (err) { /* ignore */ }
        }

        if (!opened) {
            try {
                const { spawn } = require('child_process');
                let cmd, args;
                // Under Proton the toolbox is a Windows process, so process.platform is 'win32'
                // there too; `start` routes through Wine's winebrowser to the host browser.
                if (process.platform === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '', url]; }
                else if (process.platform === 'darwin') { cmd = 'open'; args = [url]; }
                else { cmd = 'xdg-open'; args = [url]; }
                const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
                child.on('error', () => { /* opener missing - the logged URL is the fallback */ });
                child.unref();
                opened = true;
            } catch (err) { /* ignore */ }
        }

        this.externalOpened = opened;
        this.mod.command.message('Teralith overlay: open ' + url + ' in your browser.');
        if (!opened) this.mod.log('Overlay URL: ' + url);
    }

    minimize() {
        if (this.isOpen()) {
            try { this.win.minimize(); } catch (err) { /* ignore */ }
        }
    }

    setAlwaysOnTop(on) {
        if (!this.isOpen()) return;
        try { this.win.setAlwaysOnTop(!!on, on ? 'screen-saver' : 'normal'); }
        catch (err) { try { this.win.setAlwaysOnTop(!!on); } catch (e2) { /* ignore */ } }
    }

    close() {
        if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
        if (this.isOpen()) {
            this.win.__dpsModClosing = true; // mod-initiated close - suppress onUserClose
            try { this.saveBounds(); this.win.close(); } catch (err) { /* ignore */ }
        }
        openOverlays.delete(this);
        this.win = null;
        this.externalOpened = false;
    }

    alwaysOnTop() {
        return this.mod.settings ? this.mod.settings.alwaysOnTop !== false : true;
    }

    // Clamp onto a visible display so a window saved on a now-missing monitor (or a smaller
    // Proton virtual desktop) can't reopen off-screen, where its frameless window can't be grabbed.
    resolveBounds(peers) {
        const b = this.savedBounds();
        if (peers > 0 && typeof b.x === 'number' && typeof b.y === 'number') {
            b.x += peers * CASCADE_STEP;
            b.y += peers * CASCADE_STEP;
        }
        return this.clampToDisplay(b);
    }

    clampToDisplay(b) {
        if (!this.electron || !this.electron.screen) return b;
        if (typeof b.x !== 'number' || typeof b.y !== 'number') return b; // undefined => centered
        let area;
        try {
            const disp = this.electron.screen.getDisplayMatching({ x: b.x, y: b.y, width: b.width, height: b.height });
            area = disp && disp.workArea;
        } catch (err) { return b; }
        if (!area) return b;

        // If the saved rect barely overlaps the nearest display, drop x/y so Electron centers it.
        const overlapX = Math.min(b.x + b.width, area.x + area.width) - Math.max(b.x, area.x);
        const overlapY = Math.min(b.y + b.height, area.y + area.height) - Math.max(b.y, area.y);
        if (overlapX < 40 || overlapY < 24) { b.x = undefined; b.y = undefined; return b; }

        // Otherwise nudge it fully inside the work area.
        b.x = Math.max(area.x, Math.min(b.x, area.x + area.width - b.width));
        b.y = Math.max(area.y, Math.min(b.y, area.y + area.height - b.height));
        return b;
    }

    // Compact and expanded sizes are remembered separately, but the window is resized in place
    // (top-left kept) so toggling never repositions it. No-op under the CLI/browser fallback.
    setExpanded(on) {
        on = !!on;
        if (!this.isOpen()) { this.expanded = on; return; }
        if (on === this.expanded) return;
        // Flush the pending save for the mode we're leaving so its size isn't lost.
        if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; this.saveBounds(); }
        this.expanded = on;
        const size = this.sizeFor(on);
        const cur = this.currentBounds() || {};
        const target = this.clampToDisplay({ width: size.width, height: size.height, x: cur.x, y: cur.y });
        try {
            if (typeof target.x === 'number' && typeof target.y === 'number')
                this.win.setBounds({ x: target.x, y: target.y, width: target.width, height: target.height });
            else
                this.win.setSize(target.width, target.height);
        } catch (err) { /* ignore */ }
    }

    // Remembered width/height for a mode (position is intentionally not used - see setExpanded).
    sizeFor(expanded) {
        if (!expanded) { const b = this.savedBounds(); return { width: b.width, height: b.height }; }
        const saved = this.readBounds('overlayExpandedBounds');
        if (saved && saved.width && saved.height) return { width: saved.width, height: saved.height };
        // No saved expanded size yet: grow from the current window.
        const c = this.currentBounds() || this.savedBounds();
        return {
            width: Math.max(c.width || DEFAULT_WIDTH, DEFAULT_EXPANDED_WIDTH),
            height: Math.max(c.height || DEFAULT_HEIGHT, DEFAULT_EXPANDED_HEIGHT)
        };
    }

    currentBounds() {
        if (!this.isOpen()) return null;
        try { return this.win.getBounds(); } catch (err) { return null; }
    }

    // Read a saved bounds object from settings (or null). Width/height clamped to the minimum.
    readBounds(key) {
        const s = this.mod.settings && this.mod.settings[key];
        if (!s || typeof s !== 'object') return null;
        const out = { width: 0, height: 0, x: undefined, y: undefined };
        if (s.width > 0) out.width = Math.max(MIN_WIDTH, Math.round(s.width));
        if (s.height > 0) out.height = Math.max(MIN_HEIGHT, Math.round(s.height));
        if (typeof s.x === 'number' && isFinite(s.x)) out.x = Math.round(s.x);
        if (typeof s.y === 'number' && isFinite(s.y)) out.y = Math.round(s.y);
        return out;
    }

    savedBounds() {
        const b = this.readBounds('overlayBounds') || {};
        return { width: b.width || DEFAULT_WIDTH, height: b.height || DEFAULT_HEIGHT, x: b.x, y: b.y };
    }

    scheduleSaveBounds() {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveBounds(); }, 500);
    }

    saveBounds() {
        if (!this.isOpen() || !this.mod.settings) return;
        // Don't persist while another overlay (another boxed client) is open: they share one
        // settings object, so the last writer would clobber the others. Single-client (the
        // common case) always has no peers and persists normally.
        let others = 0;
        openOverlays.forEach((o) => { if (o !== this) others++; });
        if (others > 0) return;
        let b;
        try { b = this.win.getBounds(); } catch (err) { return; }
        if (!b || !(b.width > 0) || !(b.height > 0)) return;
        // Save into the slot for the current view so compact & expanded sizes don't overwrite.
        const key = this.expanded ? 'overlayExpandedBounds' : 'overlayBounds';
        this.mod.settings[key] = { x: b.x, y: b.y, width: b.width, height: b.height };
        if (typeof this.mod.saveSettings === 'function') {
            try { this.mod.saveSettings(); } catch (err) { /* ignore */ }
        }
    }
}

module.exports = OverlayWindow;
