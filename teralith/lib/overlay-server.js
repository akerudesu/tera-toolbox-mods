'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = '127.0.0.1';
const WEB_DIR = path.join(__dirname, '..', 'web');
// Bundled TeraDpsMeterData: per-region skill tables + extracted skill icons (see README).
const SKILLS_DIR = path.join(__dirname, '..', 'data', 'skills');
const SKILL_ICONS_DIR = path.join(__dirname, '..', 'data', 'skill-icons');
const REGIONS = ['EU-EN', 'EU-FR', 'EU-GER', 'JP', 'KR', 'RU', 'TW'];

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.webp': 'image/webp',
    '.png': 'image/png'
};

const JSON_HEADERS = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
};

function parseQuery(qs) {
    const out = {};
    if (!qs) return out;
    qs.split('&').forEach((pair) => {
        if (!pair) return;
        const i = pair.indexOf('=');
        try { // a malformed %-escape must not throw out of the request handler
            out[decodeURIComponent(i < 0 ? pair : pair.slice(0, i))] = i < 0 ? '' : decodeURIComponent(pair.slice(i + 1));
        } catch (err) {}
    });
    return out;
}

// Zero-dependency static + JSON server backing the overlay window (an Electron BrowserWindow in
// GUI mode, or the system browser in CLI mode - see lib/overlay-window.js). `handlers` maps each
// endpoint to a function(query) supplied by index.js. Only exact known assets are served, so no
// path traversal is possible.
class OverlayServer {
    constructor(mod, handlers) {
        this.mod = mod;
        this.handlers = handlers || {};
        this.server = null;
        this.port = 0;
        this.starting = null;
        this.assets = this.loadAssets();
        this.skillMaps = {}; // region -> skill map JSON, built lazily per requested region
    }

    // Build and cache the skill name/icon map for a region from the bundled TSVs, as a pre-
    // serialized JSON string. Shape: { "<class>": { "<skillId>": ["Name", "iconName"] } }.
    skillMapJson(region) {
        if (REGIONS.indexOf(region) === -1) region = 'EU-EN';
        if (this.skillMaps[region]) return this.skillMaps[region];
        const map = {};
        const load = (file) => {
            let text;
            try { text = fs.readFileSync(path.join(SKILLS_DIR, file), 'utf8'); } catch (err) { return; }
            text.split(/\r?\n/).forEach((line) => {
                if (!line) return;
                const c = line.split('\t');
                const id = c[0], cls = (c[3] || '').toLowerCase(), name = c[4], icon = c[7];
                if (!id || !cls || !name) return;
                (map[cls] || (map[cls] = {}))[id] = icon ? [name, icon] : [name];
            });
        };
        load('skills-' + region + '.tsv');
        load('skills-override-' + region + '.tsv'); // loaded last so overrides win

        // DOT/HOT effects (bleeds, poisons, ...) arrive as damage keyed by an abnormality id, not a
        // skill id - the client resolves these as a fallback after class/common skills.
        try {
            const abnorm = {};
            fs.readFileSync(path.join(SKILLS_DIR, 'hotdot-' + region + '.tsv'), 'utf8').split(/\r?\n/).forEach((line) => {
                if (!line) return;
                const c = line.split('\t');
                if (c[0] && c[1] && !abnorm[c[0]]) abnorm[c[0]] = c[2] ? [c[1], c[2]] : [c[1]];
            });
            map.abnorm = abnorm;
        } catch (err) { /* no dot table for this region */ }

        const json = JSON.stringify(map);
        this.skillMaps[region] = json;
        return json;
    }

    // Serve a bundled skill icon from disk on demand - there are hundreds, so preloading them all
    // isn't worth it. The name is tightly validated so no path escapes the icons folder.
    serveIcon(res, urlPath) {
        let name;
        try { name = decodeURIComponent(urlPath.slice('/skill-icon/'.length)); }
        catch (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; } // malformed %-escape
        if (!/^icon_skills\.[a-z0-9_.]+\.png$/i.test(name)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
        const file = path.join(SKILL_ICONS_DIR, name);
        if (path.dirname(file) !== SKILL_ICONS_DIR) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
        fs.readFile(file, (err, buf) => {
            if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
            res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
            res.end(buf);
        });
    }

    loadAssets() {
        const out = {};
        ['index.html', 'style.css', 'app.js', 'demo.js'].forEach((file) => {
            try {
                out['/' + file] = fs.readFileSync(path.join(WEB_DIR, file));
            } catch (err) {
                this.mod.error('[Teralith] missing web asset: ' + file + ' (' + err.message + ')');
            }
        });
        out['/'] = out['/index.html'];

        // Preload class icons (web/icons/*.webp) - served by exact path only, so no traversal.
        try {
            const iconsDir = path.join(WEB_DIR, 'icons');
            fs.readdirSync(iconsDir).forEach((f) => {
                if (/\.(webp|png)$/i.test(f)) {
                    try { out['/icons/' + f] = fs.readFileSync(path.join(iconsDir, f)); } catch (err) {}
                }
            });
        } catch (err) { /* no icons dir */ }

        return out;
    }

    ensureStarted() {
        if (this.port) return Promise.resolve(this.url());
        if (this.starting) return this.starting;

        this.starting = new Promise((resolve, reject) => {
            const server = http.createServer((req, res) => this.handle(req, res));
            server.on('error', (err) => {
                this.starting = null;
                reject(err);
            });
            server.listen(0, HOST, () => {
                this.server = server;
                this.port = server.address().port;
                this.starting = null;
                resolve(this.url());
            });
        });
        return this.starting;
    }

    url() {
        return 'http://' + HOST + ':' + this.port + '/';
    }

    // Returns the value to send, or undefined when the path isn't a JSON endpoint (null is a valid
    // body, so it can't double as the sentinel). The caller turns thrown errors into a safe body.
    runJson(urlPath, query) {
        const h = this.handlers;
        switch (urlPath) {
            case '/data': return h.data ? h.data(query) : {};
            case '/current': return h.current ? h.current(query) : null;
            case '/reset': if (h.reset) h.reset(); return { ok: true };
            case '/stop': {
                const log = h.stop ? h.stop() : null;
                return { ok: true, saved: !!log, id: log ? log.id : null, bossName: log ? log.bossName : null };
            }
            case '/logs': return h.logs ? h.logs() : [];
            case '/log': return h.log ? h.log(query) : null;
            case '/logs/clear': return { ok: true, cleared: h.clearLogs ? h.clearLogs() : 0 };
            case '/minimize': if (h.minimize) h.minimize(); return { ok: true };
            case '/expand': if (h.setExpanded) h.setExpanded(query); return { ok: true };
            case '/settings': return h.settings ? h.settings() : {};
            case '/settings/set': return h.setSettings ? h.setSettings(query) : {};
            default: return undefined;
        }
    }

    handle(req, res) {
        const qIndex = req.url.indexOf('?');
        const urlPath = qIndex === -1 ? req.url : req.url.slice(0, qIndex);
        const query = qIndex === -1 ? {} : parseQuery(req.url.slice(qIndex + 1));

        let json;
        try {
            json = this.runJson(urlPath, query);
        } catch (err) {
            this.mod.error('[Teralith] endpoint ' + urlPath + ' failed: ' + err);
            res.writeHead(200, JSON_HEADERS);
            res.end('{"error":"handler"}');
            return;
        }
        if (json !== undefined) { // undefined = fall through to static assets; null is a valid body
            let body;
            try { body = JSON.stringify(json); }
            catch (err) { body = '{"error":"serialize"}'; }
            res.writeHead(200, JSON_HEADERS);
            res.end(body);
            return;
        }

        if (urlPath.indexOf('/skills/') === 0) {
            res.writeHead(200, JSON_HEADERS);
            res.end(this.skillMapJson(urlPath.slice('/skills/'.length)));
            return;
        }
        if (urlPath.indexOf('/skill-icon/') === 0) {
            this.serveIcon(res, urlPath);
            return;
        }

        const asset = this.assets[urlPath];
        if (asset) {
            const ext = path.extname(urlPath === '/' ? '/index.html' : urlPath);
            res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
            res.end(asset);
            return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
    }

    close() {
        if (this.server) {
            try { this.server.close(); } catch (err) {}
            this.server = null;
            this.port = 0;
        }
    }
}

module.exports = OverlayServer;
