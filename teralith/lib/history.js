'use strict';

const fs = require('fs');
const path = require('path');

// Keep at most this many encounters on disk; older ones are pruned on save.
const MAX_LOGS = 500;

// Stamped into every saved encounter as `log.v`. Bump it and add a step in migrate() whenever the
// saved-log shape changes, so old files can be upgraded on read.
const LOG_VERSION = 1;

// One JSON file per encounter under <mod>/logs. A lightweight summary of every encounter is
// cached in memory so the frequently-polled history list never touches disk; the heavy per-second
// timeline is only read when an encounter is opened for the graph. Writes are async + atomic (temp
// file then rename) so the packet/GUI thread never blocks and a crash can't leave a half-written log.
class HistoryStore {
    constructor(dir) {
        this.dir = dir;
        this.summaries = null; // null until first built
        this.ensureDir();
    }

    ensureDir() {
        try { fs.mkdirSync(this.dir, { recursive: true }); } catch (err) {}
    }

    fileFor(id, bossName) {
        const safe = String(bossName || 'encounter').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'encounter';
        return path.join(this.dir, id + '_' + safe + '.json');
    }

    files() {
        try {
            return fs.readdirSync(this.dir).filter((f) => f.toLowerCase().endsWith('.json') && !f.endsWith('.tmp.json'));
        } catch (err) {
            return [];
        }
    }

    build() {
        const out = [];
        this.files().forEach((f) => {
            const full = path.join(this.dir, f);
            try {
                out.push(summarize(migrate(JSON.parse(fs.readFileSync(full, 'utf8'))), f));
            } catch (err) {
                this.discardCorrupt(full); // drop it so it isn't rescanned every build
            }
        });
        out.sort((a, b) => b.start - a.start);
        this.summaries = out;
        return out;
    }

    // Strips the internal _file field before summaries leave the store.
    list() {
        if (this.summaries === null) this.build();
        return this.summaries.map(publicSummary);
    }

    save(log) {
        if (!log || !log.id) return false;
        this.ensureDir();

        const file = this.fileFor(log.id, log.bossName);
        const tmp = file + '.tmp';
        let data;
        // Object.assign into a fresh object so stamping the version doesn't mutate the caller's log.
        try { data = JSON.stringify(Object.assign({ v: LOG_VERSION }, log)); } catch (err) { return false; }

        fs.writeFile(tmp, data, (err) => {
            if (err) return;
            fs.rename(tmp, file, () => {});
        });

        if (this.summaries === null) this.build();
        this.summaries = this.summaries.filter((s) => s.id !== String(log.id));
        this.summaries.unshift(summarize(log, path.basename(file)));
        this.summaries.sort((a, b) => b.start - a.start);
        this.prune();
        return true;
    }

    prune() {
        if (!this.summaries || this.summaries.length <= MAX_LOGS) return;
        const removed = this.summaries.slice(MAX_LOGS);
        this.summaries = this.summaries.slice(0, MAX_LOGS);
        removed.forEach((s) => { if (s._file) fs.unlink(path.join(this.dir, s._file), () => {}); });
    }

    get(id) {
        if (!id) return null;
        id = String(id);
        let file = null;
        if (this.summaries) {
            const s = this.summaries.find((x) => x.id === id);
            if (s) file = s._file;
        }
        if (!file) file = this.files().find((f) => f.indexOf(id + '_') === 0 || f === id + '.json');
        if (!file) return null;

        const full = path.join(this.dir, file);
        try {
            return migrate(JSON.parse(fs.readFileSync(full, 'utf8')));
        } catch (err) {
            // ENOENT just means the async write hasn't landed yet (or it was pruned) - don't treat
            // that as corruption; only discard on an actual parse error.
            if (err && err.code !== 'ENOENT') this.discardCorrupt(full);
            return null;
        }
    }

    clear() {
        let n = 0;
        this.files().forEach((f) => {
            try { fs.unlinkSync(path.join(this.dir, f)); n++; } catch (err) {}
        });
        this.summaries = [];
        return n;
    }

    discardCorrupt(full) {
        try { fs.unlinkSync(full); } catch (err) {}
        if (this.summaries) {
            const base = path.basename(full);
            this.summaries = this.summaries.filter((s) => s._file !== base);
        }
    }
}

// Upgrade a just-loaded log to the current schema. Pre-versioning files have no `v` but already
// match v1, so they're just tagged. As the shape evolves, add ordered steps here:
//   if (v < 2) { /* transform log in place */ v = 2; }
function migrate(log) {
    if (!log || typeof log !== 'object') return log;
    let v = typeof log.v === 'number' ? log.v : 1;
    log.v = v;
    return log;
}

function summarize(log, file) {
    return {
        id: String(log.id),
        bossName: log.bossName || null,
        start: log.start,
        end: log.end,
        duration: log.duration,
        totalDamage: log.totalDamage,
        totalDps: log.totalDps,
        players: (log.players || []).map((p) => ({ name: p.name, dps: p.dps, color: p.color })),
        _file: file
    };
}

function publicSummary(s) {
    return {
        id: s.id, bossName: s.bossName, start: s.start, end: s.end, duration: s.duration,
        totalDamage: s.totalDamage, totalDps: s.totalDps, players: s.players
    };
}

module.exports = HistoryStore;
