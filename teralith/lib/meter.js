'use strict';

const { classMeta } = require('./classes');

// S_EACH_SKILL_RESULT.type value for damage (verified against data.json def v13).
const TYPE_DAMAGE = 1;

// Cap the per-encounter event log so a very long fight can't grow it (or the saved log file) without
// bound. Oldest events are dropped first; the UI only shows the recent tail anyway.
const MAX_EVENTS = 6000;

// S_EACH_SKILL_RESULT.skill is a SkillID object on current defs, but tolerate a bare number too.
function skillIdOf(skill) {
    if (skill == null) return 0;
    if (typeof skill === 'object') return Number(skill.id) || 0;
    return Number(skill) || 0;
}

// Flatten an entity's per-skill map into a compact array for the log.
function skillArray(skills) {
    const out = [];
    for (const id in skills) {
        const sk = skills[id];
        out.push({ id: Number(id), hits: sk.hits, crits: sk.crits, damage: sk.damage });
    }
    return out;
}

class Meter {
    constructor(mod) {
        this.mod = mod;

        const s = mod.settings || {};
        this.enabled = s.enabled !== false;
        this.combatGapMs = (typeof s.combatGapSeconds === 'number' ? s.combatGapSeconds : 8) * 1000;
        // Idle before an open encounter is finalized as "walked away". Kept long so mid-fight
        // downtime merges into one encounter instead of splitting; a kill/wipe ends it sooner.
        this.finalizeIdleMs = (typeof s.endGapSeconds === 'number' ? s.endGapSeconds : 90) * 1000;
        this.maxRows = typeof s.maxRows === 'number' ? s.maxRows : 12;
        // TeraDpsMeterData region for resolving skill names/icons; set by index.js and stamped into
        // each log so saved encounters resolve offline (see the skills view).
        this.region = null;

        // Called with a finished encounter log when combat ends / on manual stop. Wired by index.js
        // to the on-disk history store.
        this.onEncounterEnd = null;

        // Per-encounter state
        this.reset();

        // Caches that survive an encounter reset (cleared on zone change / relog)
        this.aliveState = new Map();
        this.npcInfo = new Map();
        this.npcNames = new Map();

        mod.game.initialize('me');
        mod.game.initialize('party');

        this.installHooks();
    }

    reset() {
        this.entities = new Map();
        this.targets = new Map();
        this.combatStart = null;
        this.lastAction = null;
        this.damageStart = null;
        this.lastDamage = null;
        this.lastSampledDamage = null; // lastDamage value at the most recent tick sample (idle-freeze guard)
        this.encounterId = null;
        this.samples = [];
        this.deathEvents = [];
        this.events = []; // chronological damage log (outgoing + incoming) for the Events view
        this.bossKey = null;
        this.pendingReset = false; // boss HP jumped up (wipe/reset) - next pull is a separate log
        this.bossDead = false;     // boss HP hit 0 (kill) - finalize shortly
        // Boss HP gauge is per-encounter so a new fight never shows the previous boss's HP.
        this.bossGages = new Map();
        this.lastGageKey = null;
    }

    // Decide whether this hit continues the current encounter or starts a new one. Downtime on the
    // same boss/adds merges into one encounter; a wipe (boss HP reset), a kill, or a brand-new
    // enemy after a gap begins a fresh pull (ShinraMeter-style).
    touchEncounter(now, targetKey) {
        if (this.combatStart !== null) {
            const gapped = now - this.lastAction > this.combatGapMs;
            // A brand-new enemy after a gap normally starts a fresh pull - UNLESS the current boss is
            // still alive, because bosses spawn adds/minions and hitting one must not split the fight.
            const g = this.bossKey ? this.bossGages.get(this.bossKey) : null;
            const bossAlive = !!(g && g.maxHp > 0 && g.curHp > 0);
            const newTarget = !!(targetKey && !this.targets.has(targetKey));
            const freshEnemy = gapped && newTarget && !bossAlive;
            // Once the boss is dead the encounter is over. Lingering damage on an already-engaged
            // target (DoT ticks on the corpse, cleave on leftover adds, a queued skill landing) must
            // NOT seed a fresh 1-2 player "ghost" pull: drop it and let the encounter finalize on the
            // next idle tick. Only a genuinely new enemy starts the next pull. A wipe (pendingReset)
            // instead re-pulls the same boss, so it still restarts on the next hit whatever the target.
            if (this.bossDead && !this.pendingReset && !newTarget) return false;
            if (this.pendingReset || this.bossDead || freshEnemy) this.endEncounter();
        }
        if (this.combatStart === null) {
            this.combatStart = now;
            this.encounterId = now;
            this.pendingReset = false;
            this.bossDead = false;
            this.recordSample(now); // t=0 origin - this hit's damage is added just after
        }
        this.lastAction = now;
        return true;
    }

    installHooks() {
        const mod = this.mod;
        this.dataHooks = [];

        // Lifecycle resets stay registered regardless of on/off state (rare + cheap). These are
        // listeners on the shared, long-lived tera-game-state emitter, so we keep refs and remove
        // them in destructor() to avoid leaking across hot-reloads.
        this._onLeaveGame = () => this.fullReset();
        mod.game.on('leave_game', this._onLeaveGame);
        if (mod.game.me && typeof mod.game.me.on === 'function') {
            this._onChangeZone = () => this.fullReset();
            mod.game.me.on('change_zone', this._onChangeZone);
        }

        if (this.enabled) this.installDataHooks();
    }

    installDataHooks() {
        if (this.dataHooks.length) return;
        const mod = this.mod;
        const add = (h) => { if (h) this.dataHooks.push(h); };

        // Damage arrives on this packet ('*' = latest bundled def = v13).
        add(mod.hook('S_EACH_SKILL_RESULT', '*', (event) => this.onSkillResult(event)));

        // Deaths. gameId + alive are identical across the bundled defs (v2/v3).
        add(mod.tryHook('S_CREATURE_LIFE', '*', (event) => this.onCreatureLife(event)));

        add(mod.tryHook('S_SPAWN_NPC', '*', (event) => this.onSpawnNpc(event)));

        add(mod.tryHook('S_BOSS_GAGE_INFO', '*', (event) => this.onBossGage(event)));
    }

    removeDataHooks() {
        const mod = this.mod;
        this.dataHooks.forEach((h) => { try { mod.unhook(h); } catch (err) { /* ignore */ } });
        this.dataHooks = [];
    }

    setEnabled(on) {
        on = !!on;
        if (on === this.enabled) return on;
        this.enabled = on;
        if (on) {
            this.installDataHooks();
        } else {
            this.removeDataHooks();
            this.reset();
            this.aliveState.clear();
        }
        return on;
    }

    isEnabled() {
        return this.enabled;
    }

    // Re-read the live-adjustable settings onto the running meter (from the in-overlay settings
    // panel), so changes take effect without a reload.
    applySettings() {
        const s = this.mod.settings || {};
        this.combatGapMs = (typeof s.combatGapSeconds === 'number' ? s.combatGapSeconds : 8) * 1000;
        this.finalizeIdleMs = (typeof s.endGapSeconds === 'number' ? s.endGapSeconds : 90) * 1000;
        this.maxRows = typeof s.maxRows === 'number' ? s.maxRows : 12;
    }

    destructor() {
        this.removeDataHooks();
        const mod = this.mod;
        if (this._onLeaveGame && mod.game && typeof mod.game.removeListener === 'function') {
            mod.game.removeListener('leave_game', this._onLeaveGame);
            this._onLeaveGame = null;
        }
        if (this._onChangeZone && mod.game.me && typeof mod.game.me.removeListener === 'function') {
            mod.game.me.removeListener('change_zone', this._onChangeZone);
            this._onChangeZone = null;
        }
    }

    // Zone change / relog: save any live parse, then clear the alive baseline.
    fullReset() {
        this.endEncounter();
        this.aliveState.clear();
    }

    resolveActor(gameId) {
        const me = this.mod.game.me;
        if (me && me.gameId && gameId === me.gameId)
            return { isSelf: true, name: me.name, cls: me.class };

        const party = this.mod.game.party;
        const member = party ? party.getMemberData(gameId) : null;
        if (member) return { isSelf: false, name: member.name, cls: member.class };

        return null;
    }

    ensureEntity(key, actor) {
        let ent = this.entities.get(key);
        if (!ent) {
            ent = {
                id: key,
                name: actor.name,
                cls: actor.cls,
                isSelf: actor.isSelf,
                damage: 0, hits: 0, crits: 0,
                deaths: 0,
                skills: {}
            };
            this.entities.set(key, ent);
        }
        if (actor.name) ent.name = actor.name;
        if (actor.cls !== null && actor.cls !== undefined) ent.cls = actor.cls;
        ent.isSelf = actor.isSelf;
        return ent;
    }

    onSkillResult(event) {
        if (event.type !== TYPE_DAMAGE) return; // heals arrive as this type too, toward a friendly target

        const value = Number(event.value) || 0;
        if (value <= 0) return; // value is signed int32 - never assume positive

        const srcActor = this.resolveActor(event.source);
        const tgtActor = this.resolveActor(event.target);
        if (!srcActor && !tgtActor) return; // enemy -> enemy (or unknown), nothing to record

        const now = Date.now();
        const skillId = skillIdOf(event.skill);

        if (srcActor && tgtActor) {
            // party -> party: a heal or HoT tick (TERA has no friendly fire, so a value toward an ally
            // is restorative). Logged only during a live encounter; it doesn't start or extend one.
            if (this.combatStart === null) return;
            this.recordEvent(now, 'heal', event.source.toString(), srcActor.name, event.target.toString(), tgtActor.name, skillId, value, !!event.crit);
            return;
        }

        if (srcActor) {
            // Outgoing: a party member damaging an enemy - this drives DPS and the encounter. DoT
            // ticks arrive here too, as abnormality skill ids.
            const targetKey = event.target.toString();
            // Returns false for lingering post-kill damage (see touchEncounter): ignore it entirely
            // so a stray tick after a boss dies can't spawn a ghost encounter.
            if (!this.touchEncounter(now, targetKey)) return;

            const ent = this.ensureEntity(event.source.toString(), srcActor);
            if (this.damageStart === null) this.damageStart = now;
            this.lastDamage = now;
            ent.damage += value;
            ent.hits += 1;
            if (event.crit) ent.crits += 1;

            if (skillId) {
                const sk = ent.skills[skillId] || (ent.skills[skillId] = { hits: 0, crits: 0, damage: 0 });
                sk.hits += 1; sk.damage += value; if (event.crit) sk.crits += 1;
            }

            this.targets.set(targetKey, (this.targets.get(targetKey) || 0) + value);
            this.bossKey = this.primaryBossKey();
            this.recordEvent(now, 'dmg', event.source.toString(), ent.name, targetKey, this.enemyName(targetKey), skillId, value, !!event.crit);
            return;
        }

        // Incoming: an enemy hitting a party member. Only logged once an encounter is already live so
        // overworld chip damage never starts one; counts as activity so a fight we're tanking (but
        // not currently hitting) doesn't idle out.
        if (this.combatStart === null) return;
        this.lastAction = now;
        // Log the event only - don't create a player row for a victim that never dealt damage, so
        // the DPS table stays damage-dealers-only. The event still keys to their gameId, so it shows
        // under that player in the Events view when they're the one dealing damage too.
        this.recordEvent(now, 'dmg', event.source.toString(), this.enemyName(event.source.toString()), event.target.toString(), tgtActor.name, skillId, value, !!event.crit);
    }

    // Best-effort display name for a non-player entity (from S_SPAWN_NPC); 'Enemy' until it resolves.
    enemyName(key) {
        const info = this.npcInfo.get(key);
        return this.npcNames.get(key) || (info && info.internalName) || 'Enemy';
    }

    // kind: 'dmg' | 'heal' | 'death' | 'res'. Direction (dealt/taken/done/received) is derived on the
    // client from whether the viewed player is the source or the target.
    recordEvent(now, kind, sId, sName, tId, tName, skillId, amount, crit) {
        const t = Math.max(0, now - this.combatStart) / 1000; // seconds, keeps ms precision for the log
        this.events.push({ t, kind, sId, sName: sName || '?', tId, tName: tName || '?', skill: skillId || 0, amount, crit });
        if (this.events.length > MAX_EVENTS) this.events.shift();
    }

    // The encounter's primary boss (for kill/wipe detection + the header). Prefer the most-damaged
    // target that has a boss gauge - real bosses send S_BOSS_GAGE_INFO, cleaved adds usually don't,
    // so an add out-damaging the boss can't hijack bossKey and hide the boss's kill/reset gage.
    // Falls back to the most-damaged enemy before any gauge has arrived.
    primaryBossKey() {
        let gaged = null, gagedDmg = -1, any = null, anyDmg = -1;
        this.targets.forEach((dmg, key) => {
            if (this.entities.has(key)) return; // skip players
            if (dmg > anyDmg) { anyDmg = dmg; any = key; }
            if (this.bossGages.has(key) && dmg > gagedDmg) { gagedDmg = dmg; gaged = key; }
        });
        return gaged || any;
    }

    onCreatureLife(event) {
        const actor = this.resolveActor(event.gameId);
        if (!actor) return; // only self + party/raid, never mobs

        const key = event.gameId.toString();
        const prev = this.aliveState.get(key);
        const alive = !!event.alive;
        const name = actor.name || '?';

        // Only during a live encounter. A death also drops a chart marker; a resurrection is a
        // dead->alive flip (prev must be an explicit false, so a first sighting isn't mistaken for one).
        if (this.combatStart !== null && prev === true && alive === false) {
            this.ensureEntity(key, actor).deaths += 1;
            const t = Math.max(0, Math.round(((Date.now() - this.combatStart) / 1000) * 10) / 10);
            this.deathEvents.push({ t: t, name: name });
            this.recordEvent(Date.now(), 'death', key, name, key, name, 0, 0, false);
        } else if (this.combatStart !== null && prev === false && alive === true) {
            this.recordEvent(Date.now(), 'res', key, name, key, name, 0, 0, false);
        }
        this.aliveState.set(key, alive);
    }

    onSpawnNpc(event) {
        const key = event.gameId.toString();
        if (this.npcInfo.has(key)) return;
        this.npcInfo.set(key, {
            huntingZoneId: Number(event.huntingZoneId),
            templateId: Number(event.templateId),
            internalName: event.npcName || null
        });
        this.resolveNpcName(key);
    }

    resolveNpcName(key) {
        const info = this.npcInfo.get(key);
        if (!info) return;

        let query;
        try {
            query = this.mod.queryData(
                '/StrSheet_Creature/HuntingZone@id=?/String@templateId=?/',
                [info.huntingZoneId, info.templateId],
                false,
                false,
                ['name']
            );
        } catch (err) {
            return;
        }

        if (!query || typeof query.then !== 'function') return;
        query.then((result) => {
            const name = result && result.attributes && result.attributes.name;
            if (name) this.npcNames.set(key, String(name));
        }).catch(() => { /* silent: header degrades gracefully */ });
    }

    onBossGage(event) {
        // The boss entity gameId is the FIRST field `id` (= ShinraMeter's EntityId), matching
        // S_EACH_SKILL_RESULT.target and S_SPAWN_NPC.gameId.
        const key = event.id.toString();
        const cur = Number(event.curHp) || 0, max = Number(event.maxHp) || 0;
        const prev = this.bossGages.get(key);
        this.bossGages.set(key, { curHp: cur, maxHp: max });
        this.lastGageKey = key;

        // Watch the current boss for a kill (HP 0) or a wipe (HP jumps back up >25% of max at once).
        if (this.combatStart !== null && key === this.bossKey && max > 0) {
            if (cur === 0) this.bossDead = true;
            else if (prev && prev.maxHp > 0 && (cur - prev.curHp) / max > 0.25) this.pendingReset = true;
        }
    }

    // The boss = the non-player target that took the most damage; falls back to the most recent
    // boss gage. Returns name + HP (best effort).
    resolveBoss() {
        const key = this.primaryBossKey() || this.lastGageKey;
        if (!key) return { name: null, curHp: null, maxHp: null };
        const info = this.npcInfo.get(key);
        const gage = this.bossGages.get(key) ||
            (this.lastGageKey ? this.bossGages.get(this.lastGageKey) : null) || null;
        return {
            name: this.npcNames.get(key) || (info && info.internalName) || null,
            curHp: gage ? gage.curHp : null,
            maxHp: gage ? gage.maxHp : null
        };
    }

    bossHpPct(boss) {
        return (boss.maxHp > 0 && boss.curHp != null) ? Math.round((boss.curHp / boss.maxHp) * 1000) / 10 : null;
    }

    // Append a per-second sample: cumulative per-player damage + raid total + boss HP. Samples at
    // the same whole-second replace the previous one so the timeline stays ~1 point/second.
    recordSample(now) {
        if (this.combatStart === null) return;
        let t = Math.max(0, Math.round(((now - this.combatStart) / 1000) * 10) / 10);
        const last = this.samples[this.samples.length - 1];
        // Keep the timeline strictly non-decreasing in t: the finalize sample is taken at the last
        // damage time, which can be earlier than a tick sample recorded a second later.
        if (last && t < last.t) t = last.t;

        const boss = this.resolveBoss();
        const players = {};
        let total = 0;
        this.entities.forEach((ent) => { players[ent.id] = ent.damage; total += ent.damage; });

        const sample = {
            t: t,
            bossCurHp: boss.curHp,
            bossMaxHp: boss.maxHp,
            bossHpPct: this.bossHpPct(boss),
            total: total,
            players: players
        };

        if (last && Math.floor(last.t) === Math.floor(t)) this.samples[this.samples.length - 1] = sample;
        else this.samples.push(sample);
    }

    hasData() {
        let any = false;
        this.entities.forEach((ent) => { if (ent.damage > 0) any = true; });
        return this.combatStart !== null && any;
    }

    // Runs ~once/second. Finalizes on a wipe, a kill (after a short delay), or a long walk-away idle;
    // otherwise samples the timeline - but only while damage is actually flowing.
    tick(now) {
        if (this.combatStart === null) return;
        const idle = now - this.lastAction;
        if (this.pendingReset || (this.bossDead && idle > this.combatGapMs) || idle > this.finalizeIdleMs) {
            this.endEncounter();
            return;
        }
        // Freeze the graph at the last event during downtime (a between-pack lull, the post-kill
        // merge window) instead of trailing flat, declining-DPS samples across the idle gap. Sampling
        // resumes the moment the next hit lands; endEncounter still trims/closes at the last hit.
        if (this.lastDamage === null || this.lastDamage === this.lastSampledDamage) return;
        this.lastSampledDamage = this.lastDamage;
        this.recordSample(now);
    }

    // Build a log object (final standings + timeline) for the current encounter. Works mid-fight
    // (used for the live graph) and at the end (persisted to history). The event log is large, so
    // it's only attached when asked for (saved logs, and the live Events tab).
    buildLog(includeEvents) {
        if (this.combatStart === null) return null;
        const now = this.lastAction || this.combatStart;
        const dmgElapsed = this.damageStart ? Math.max(1, ((this.lastDamage || this.damageStart) - this.damageStart) / 1000) : 0;

        let totalDamage = 0, totalCrits = 0, totalHits = 0, totalDeaths = 0;
        const players = [];
        this.entities.forEach((ent) => {
            const meta = classMeta(ent.cls);
            totalDamage += ent.damage;
            totalCrits += ent.crits;
            totalHits += ent.hits;
            totalDeaths += ent.deaths;
            players.push({
                id: ent.id,
                name: ent.name || '?',
                cls: meta.key,
                className: meta.name,
                color: meta.color,
                isSelf: ent.isSelf,
                damage: ent.damage,
                dps: dmgElapsed > 0 ? Math.round(ent.damage / dmgElapsed) : 0,
                crit: ent.hits ? Math.round((ent.crits / ent.hits) * 1000) / 10 : 0,
                deaths: ent.deaths,
                skills: skillArray(ent.skills)
            });
        });
        players.sort((a, b) => b.damage - a.damage);

        const boss = this.resolveBoss();
        return {
            id: String(this.encounterId || this.combatStart),
            region: this.region, // stamped so saved logs resolve skill names/icons offline
            bossName: boss.name || null,
            start: this.combatStart,
            end: now,
            duration: Math.round(((now - this.combatStart) / 1000) * 10) / 10,
            totalDamage: totalDamage,
            totalDps: dmgElapsed > 0 ? Math.round(totalDamage / dmgElapsed) : 0,
            totalCrit: totalHits ? Math.round((totalCrits / totalHits) * 1000) / 10 : 0,
            totalDeaths: totalDeaths,
            deathEvents: this.deathEvents.slice(),
            players: players,
            timeline: this.samples.slice(),
            events: includeEvents ? this.events.slice() : undefined
        };
    }

    currentLog(includeEvents) {
        return this.buildLog(includeEvents);
    }

    // Finalize the current encounter: persist it (if it has data) via onEncounterEnd, then reset
    // to an empty state. Returns the saved log (or null). Used for combat-end, zone change, and
    // the manual Stop button.
    endEncounter() {
        if (this.combatStart === null) return null;
        let log = null;
        if (this.hasData()) {
            // Trim the trailing no-damage tail so the saved graph ends at the last hit.
            const last = this.lastDamage || this.lastAction || Date.now();
            const tEnd = (last - this.combatStart) / 1000;
            this.samples = this.samples.filter((s) => s.t <= tEnd + 0.5);
            this.recordSample(last); // closing point
            log = this.buildLog(true); // saved logs keep the full event stream for the Events view
            if (log && typeof this.onEncounterEnd === 'function') {
                try { this.onEncounterEnd(log); } catch (err) { this.mod.error('[Teralith] failed to save encounter log: ' + err); }
            }
        }
        this.reset();
        return log;
    }

    stop() {
        return this.endEncounter();
    }

    snapshot() {
        const now = Date.now();
        const active = this.combatStart !== null && now - this.lastAction < this.combatGapMs;
        const elapsed = this.combatStart ? Math.max(0, ((this.lastAction || this.combatStart) - this.combatStart) / 1000) : 0;
        const dmgElapsed = this.damageStart ? Math.max(1, ((this.lastDamage || this.damageStart) - this.damageStart) / 1000) : 0;

        let fullDamage = 0, totalCrits = 0, totalHits = 0;
        this.entities.forEach((ent) => { fullDamage += ent.damage; totalCrits += ent.crits; totalHits += ent.hits; });

        let entries = [];
        this.entities.forEach((ent) => {
            const meta = classMeta(ent.cls);
            entries.push({
                id: ent.id,
                name: ent.name || '?',
                cls: meta.key,
                className: meta.name,
                color: meta.color,
                isSelf: ent.isSelf,
                damage: ent.damage,
                dps: dmgElapsed > 0 ? Math.round(ent.damage / dmgElapsed) : 0,
                crit: ent.hits ? Math.round((ent.crits / ent.hits) * 1000) / 10 : 0,
                share: fullDamage ? Math.round((ent.damage / fullDamage) * 1000) / 10 : 0,
                deaths: ent.deaths
            });
        });

        let totalDamage = 0, totalDeaths = 0;
        entries.forEach((e) => { totalDamage += e.damage; totalDeaths += e.deaths; });

        entries.sort((a, b) => b.dps - a.dps);

        const boss = this.resolveBoss();
        return {
            enabled: this.enabled,
            active: active,
            region: this.region, // lets the client preload the skill name/icon map
            inProgress: this.hasData(), // an encounter exists that End encounter can save
            elapsed: Math.round(elapsed * 10) / 10,
            bossName: boss.name,
            bossCurHp: boss.curHp,
            bossMaxHp: boss.maxHp,
            bossHpPct: this.bossHpPct(boss),
            totalDamage: totalDamage,
            totalDps: dmgElapsed > 0 ? Math.round(totalDamage / dmgElapsed) : 0,
            totalCrit: totalHits ? Math.round((totalCrits / totalHits) * 1000) / 10 : 0,
            totalDeaths: totalDeaths,
            entries: this.maxRows > 0 ? entries.slice(0, this.maxRows) : entries
        };
    }
}

module.exports = Meter;
