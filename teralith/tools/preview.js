'use strict';
// DEV-ONLY preview server: serves web/ + the bundled skill data so the overlay page can be opened
// at http://localhost:<port>/index.html?demo=1 with real skill names/icons.
// Not shipped/loaded by the mod; used only while iterating on the UI.
const http = require('http');
const fs = require('fs');
const path = require('path');
const WEB = path.join(__dirname, '..', 'web');
const SKILLS_DIR = path.join(__dirname, '..', 'data', 'skills');
const SKILL_ICONS_DIR = path.join(__dirname, '..', 'data', 'skill-icons');
const REGIONS = ['EU-EN', 'EU-FR', 'EU-GER', 'JP', 'KR', 'RU', 'TW'];
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.webp': 'image/webp', '.png': 'image/png' };
const PORT = process.env.PORT || 5178;

const skillMaps = {};
function skillMapJson(region) {
    if (REGIONS.indexOf(region) === -1) region = 'EU-EN';
    if (skillMaps[region]) return skillMaps[region];
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
    load('skills-override-' + region + '.tsv');
    try {
        const abnorm = {};
        fs.readFileSync(path.join(SKILLS_DIR, 'hotdot-' + region + '.tsv'), 'utf8').split(/\r?\n/).forEach((line) => {
            if (!line) return; const c = line.split('\t');
            if (c[0] && c[1] && !abnorm[c[0]]) abnorm[c[0]] = c[2] ? [c[1], c[2]] : [c[1]];
        });
        map.abnorm = abnorm;
    } catch (err) { /* no dot table */ }
    return (skillMaps[region] = JSON.stringify(map));
}

http.createServer((req, res) => {
    let p;
    try { p = decodeURIComponent(req.url.split('?')[0]); } catch (err) { res.writeHead(404); res.end(); return; }
    if (p.indexOf('/skills/') === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(skillMapJson(p.slice('/skills/'.length)));
        return;
    }
    if (p.indexOf('/skill-icon/') === 0) {
        const name = p.slice('/skill-icon/'.length);
        if (!/^icon_skills\.[a-z0-9_.]+\.png$/i.test(name)) { res.writeHead(404); res.end(); return; }
        const file = path.join(SKILL_ICONS_DIR, name);
        if (path.dirname(file) !== SKILL_ICONS_DIR) { res.writeHead(404); res.end(); return; }
        fs.readFile(file, (err, buf) => { if (err) { res.writeHead(404); res.end(); } else { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(buf); } });
        return;
    }
    const full = path.join(WEB, p === '/' ? '/index.html' : p);
    if (!full.startsWith(WEB)) { res.writeHead(403); res.end(); return; }
    fs.readFile(full, (err, buf) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
        res.end(buf);
    });
}).listen(PORT, () => console.log('preview on http://localhost:' + PORT + '/index.html?demo=1'));
