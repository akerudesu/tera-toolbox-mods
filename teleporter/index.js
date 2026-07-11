"use strict";

// Teleporter - adds `tp <town>` (village atlas) and `tpj <location name>` (Travel
// Journal) chat commands.
//
// On this server the atlas is an item in the PC-Bang inventory, so opening it
// and clicking a town is three packets, which this mod replays in order:
//     C_PCBANGINVENTORY_USE_SLOT { slot }        // use the atlas item
//     S_VILLAGE_LIST_TO_TELEPORT { locations }    // teleport session opens
//     C_TELEPORT_TO_VILLAGE { id }                // jump to the chosen town
// A bare teleport is ignored unless the session was just opened this way, and
// we only ever send an id the server put in that list. Town names come from
// StrSheet_Region, keyed by the section id.
//
// It also teleports to your Travel Journal locations. On this server the journal is
// *also* a PC-Bang item, so a jump mirrors the atlas - the mod opens the item for
// you (no need to open the journal in game first):
//     C_PCBANGINVENTORY_USE_SLOT { slot }          // use the journal item
//     S_LOAD_TELEPORT_TO_POS_LIST { locations }     // saved-location list + session
//     C_TELEPORT_TO_POS { index }                  // jump (index = position in list)
// C_TELEPORT_TO_POS is ignored unless the session was just opened this way. The
// server teleports directly; if it ever asks a confirm we auto-accept the one
// matching our jump (never an unrelated prompt like a party summon):
//     S_ASK_TELEPORT { name }  ->  C_REPLY_TELEPORT { accept: 1 }

const DEFAULT_ATLAS_ITEMS = [181116]; // PC-Bang item id(s) that open the atlas

function NetworkMod(mod) {
    const settings = mod.settings;
    const aliases = settings.aliases || {};
    const atlasItems = settings.atlasItems || DEFAULT_ATLAS_ITEMS;

    const available = new Map();   // id -> { id, zone, ... }  (server access list)
    const resolved = new Map();    // id -> town name (from StrSheet_Region)
    let atlasSlot = (typeof settings.atlasSlot === "number") ? settings.atlasSlot : null;

    // teleport handshake state
    let pendingQuery = null;       // query waiting for the atlas to open
    let pendingToken = 0;
    let expectingList = false;     // the next village list is a response to us
    let realUseSlot = null;        // slot of a recent manual atlas open (to learn)
    let realUseFlag = false;

    // Travel Journal state. On this server the journal is *also* a PC-Bang item,
    // so a jump mirrors the atlas: open the item (which makes the server push the
    // saved-location list and open a teleport session), then send C_TELEPORT_TO_POS.
    const journal = [];               // [{ index, name, label, place, zone, x, y, z }]
    let journalSlot = (typeof settings.journalSlot === "number") ? settings.journalSlot : null;
    let pendingJournalQuery = null;   // teleport target waiting for our journal-open (null = list only)
    let expectingJournalList = false; // the next pos-list is a response to our own open
    let journalToken = 0;
    let pendingConfirmName = null;    // location name awaiting an S_ASK_TELEPORT confirm (safety net)

    const norm = s => String(s).toLowerCase().trim().replace(/\s+/g, " ");
    const squash = s => norm(s).replace(/\s+/g, "");
    const msg = s => mod.command.message(s);

    // User-facing text: short, impersonal, and parallel between the two modes.
    // `what` is "village atlas" or "Travel Journal".
    const needSlot = what => `Open the ${what} once in order to use this command.`;
    const didntOpen = what => `${what} didn't open (item on cooldown?). Try again shortly.`;
    // A location name is stored as "<custom label><spaces><town>", e.g.
    // "Alle Rep Quests    Allemantheia". Split it for display.
    const locationEntry = e => (e.place ? `${e.label} (${e.place})` : e.label);
    const locationTarget = e => (e.place ? `"${e.label}" in ${e.place}` : `"${e.label}"`);
    const locationsList = () => journal.filter(e => e.label).map(locationEntry).join(", ");

    function rememberSlot(slot) {
        if (slot == null || atlasSlot === slot) return;
        atlasSlot = slot;
        settings.atlasSlot = slot;
        mod.saveSettings();
    }

    function rememberJournalSlot(slot) {
        if (slot == null || journalSlot === slot) return;
        journalSlot = slot;
        settings.journalSlot = slot;
        mod.saveSettings();
    }

    // ---- name resolution ---------------------------------------------------

    function withTimeout(promise, ms) {
        return Promise.race([
            Promise.resolve(promise).catch(() => null),
            new Promise(resolve => mod.setTimeout(() => resolve(null), ms))
        ]);
    }

    // The atlas label for a destination is StrSheet_Region keyed by section id.
    async function townName(id) {
        if (typeof mod.queryData !== "function") return null;
        const res = await withTimeout(mod.queryData("/StrSheet_Region/String@id=?", [id], true, false), 3000);
        const a = Array.isArray(res) ? (res[0] && res[0].attributes) : (res && res.attributes);
        return (a && a.string) ? String(a.string) : null;
    }

    // Resolve names a few at a time - firing one query per town at once
    // overwhelms the client and many time out. Anything still unresolved is
    // retried on the next atlas open (we only skip towns already named).
    async function resolveNames() {
        const todo = [...available.values()].filter(e => !resolved.has(e.id));
        let i = 0;
        const worker = async () => {
            while (i < todo.length) {
                const e = todo[i++];
                const name = await townName(e.id);
                if (name) resolved.set(e.id, name);
            }
        };
        await Promise.all(Array.from({ length: Math.min(4, todo.length) }, worker));
    }

    function labelFor(id) {
        if (resolved.has(id)) return resolved.get(id);
        const alias = Object.keys(aliases).find(k => aliases[k] === id);
        return alias || `#${id}`;
    }

    // Resolve a typed place name to one id: { id } | { ambiguous:[ids] } | null.
    function findDestination(query) {
        const qn = norm(query);
        const qs = squash(query);

        const known = [];
        for (const [id, name] of resolved) known.push({ key: norm(name), id });
        for (const [k, id] of Object.entries(aliases)) known.push({ key: norm(k), id });

        const tiers = [
            e => e.key === qn || squash(e.key) === qs,
            e => e.key.startsWith(qn) || squash(e.key).startsWith(qs),
            e => e.key.includes(qn) || squash(e.key).includes(qs)
        ];
        for (const test of tiers) {
            const ids = [...new Set(known.filter(test).map(e => e.id))];
            if (ids.length === 1) return { id: ids[0] };
            if (ids.length > 1) return { ambiguous: ids };
        }
        return null;
    }

    // Resolve a typed name to one Travel Journal entry, using the same tiered
    // matching as villages: { entry } | { ambiguous:[entries] } | null.
    function findJournal(query) {
        if (!journal.length) return null;
        const qn = norm(query);
        const qs = squash(query);
        const known = journal.filter(e => e.name).map(e => ({ key: norm(e.name), e }));

        const tiers = [
            k => k.key === qn || squash(k.key) === qs,
            k => k.key.startsWith(qn) || squash(k.key).startsWith(qs),
            k => k.key.includes(qn) || squash(k.key).includes(qs)
        ];
        for (const test of tiers) {
            const hits = [...new Map(known.filter(test).map(h => [h.e.index, h.e])).values()];
            if (hits.length === 1) return { entry: hits[0] };
            if (hits.length > 1) return { ambiguous: hits };
        }
        return null;
    }

    // ---- teleport handshake ------------------------------------------------

    function startTeleport(query) {
        if (atlasSlot == null) { msg(needSlot("village atlas")); return; }
        const token = ++pendingToken;
        pendingQuery = query;
        expectingList = true;
        mod.trySend("C_PCBANGINVENTORY_USE_SLOT", 1, { slot: atlasSlot });
        mod.setTimeout(() => {
            if (pendingToken === token && pendingQuery !== null) {
                pendingQuery = null;
                expectingList = false;
                msg(didntOpen("Village atlas"));
            }
        }, 3500);
    }

    async function fulfill(query, ready) {
        // Fast path: if we already know the town, teleport without waiting.
        // Otherwise wait for the (possibly slow) first-time name lookup and let
        // the player know it's loading.
        let match = findDestination(query);
        if (!match && [...available.values()].some(e => !resolved.has(e.id))) {
            msg("Loading teleport destinations...");
            await ready;
            match = findDestination(query);
        }
        if (!match) { msg(`No town matches "${query}".`); return; }
        if (match.ambiguous) {
            msg(`"${query}" matches several: ${match.ambiguous.map(labelFor).join(", ")}. Be more specific.`);
            return;
        }
        if (!available.has(match.id)) { msg(`Cannot teleport to ${labelFor(match.id)} right now.`); return; }
        mod.setTimeout(() => {
            const ok = mod.trySend("C_TELEPORT_TO_VILLAGE", 1, { id: match.id });
            msg(ok ? `Teleporting to ${labelFor(match.id)}...` : "Failed to send teleport packet.");
        }, 200);
    }

    // Open the Travel Journal item so the server pushes the saved-location list
    // and opens a teleport session, exactly like the atlas. `query` is the location to
    // jump to once the list arrives, or null to just (re)load the list for `tpj`.
    function openJournal(query) {
        if (journalSlot == null) { msg(needSlot("Travel Journal")); return; }
        const token = ++journalToken;
        pendingJournalQuery = query;
        expectingJournalList = true;
        mod.trySend("C_PCBANGINVENTORY_USE_SLOT", 1, { slot: journalSlot });
        mod.setTimeout(() => {
            if (journalToken === token && expectingJournalList) {
                expectingJournalList = false;
                pendingJournalQuery = null;
                msg(didntOpen("Travel Journal"));
            }
        }, 3500);
    }

    // Runs once our own journal-open returns the list: match the name and fire the
    // teleport. On this server C_TELEPORT_TO_POS jumps directly (no confirm), but
    // the S_ASK_TELEPORT hook still auto-answers one if the server asks.
    function fulfillJournal(query) {
        const j = findJournal(query);
        if (!j) { msg(`No location matches "${query}".`); return; }
        if (j.ambiguous) {
            msg(`"${query}" matches several: ${j.ambiguous.map(locationEntry).join(", ")}. Be more specific.`);
            return;
        }
        const entry = j.entry;
        pendingConfirmName = entry.name;
        mod.setTimeout(() => {
            const ok = mod.trySend("C_TELEPORT_TO_POS", 1, { index: entry.index });
            msg(ok ? `Teleporting to ${locationTarget(entry)}...` : "Failed to send teleport packet.");
        }, 200);
        mod.setTimeout(() => { if (pendingConfirmName === entry.name) pendingConfirmName = null; }, 4000);
    }

    // ---- packet hooks ------------------------------------------------------

    // Find which PC-Bang slot holds the atlas item.
    mod.hook("S_PCBANGINVENTORY_DATALIST", "*", event => {
        const found = event.inventory.find(it => atlasItems.includes(it.item));
        if (found) rememberSlot(found.slot);
    });

    // A manual atlas open (default hooks only see the player's real packets).
    mod.hook("C_PCBANGINVENTORY_USE_SLOT", "*", event => {
        realUseSlot = event.slot;
        realUseFlag = true;
        mod.setTimeout(() => { realUseFlag = false; }, 2500);
    });

    mod.hook("S_VILLAGE_LIST_TO_TELEPORT", "*", event => {
        available.clear();
        for (const loc of event.locations) available.set(loc.id, loc);
        const ready = resolveNames().catch(() => {});

        // Learn the atlas slot by correlating a manual open with this list.
        if (realUseFlag) rememberSlot(realUseSlot);

        // If this list answers our own open, teleport and hide the packet so
        // the atlas UI doesn't pop up.
        if (expectingList && pendingQuery !== null) {
            expectingList = false;
            const q = pendingQuery;
            pendingQuery = null;
            fulfill(q, ready).catch(e => msg(`Error: ${e && e.message ? e.message : e}`));
            return false;
        }
    });

    // The server pushes the Travel Journal list when the journal item is used
    // (and on add/remove). Remember it - the teleport index is the position in
    // this list. When it answers our own open, act on it and hide the packet so
    // the in-game journal window doesn't pop up; otherwise let it pass.
    mod.hook("S_LOAD_TELEPORT_TO_POS_LIST", "*", event => {
        journal.length = 0;
        event.locations.forEach((loc, i) => {
            // A location name is "<custom label><run of spaces/tab><town>"; split the two.
            const raw = String(loc.name || "").trim();
            const parts = raw.split(/\s{2,}|\t/).map(s => s.trim()).filter(Boolean);
            journal.push({
                index: i,
                name: raw,                       // full text, used for name matching
                label: parts[0] || raw,          // custom name
                place: parts.slice(1).join(" "), // town name (may be "")
                zone: loc.zone, x: loc.x, y: loc.y, z: loc.z
            });
        });

        // Learn the journal item's slot by correlating a manual open with this list.
        if (realUseFlag) rememberJournalSlot(realUseSlot);

        if (expectingJournalList) {
            expectingJournalList = false;
            const q = pendingJournalQuery;
            pendingJournalQuery = null;
            if (q == null) {
                const list = locationsList();
                msg(list ? `Locations: ${list}` : "Travel Journal has no locations.");
            } else {
                fulfillJournal(q);
            }
            return false;
        }
    });

    // Safety net: if a journal jump triggers a "teleport to <name>?" confirm,
    // auto-answer only the one our own jump asked for (matched by name) so an
    // unrelated prompt (e.g. a party summon) is never touched.
    mod.hook("S_ASK_TELEPORT", "*", event => {
        if (!pendingConfirmName || settings.autoConfirm === false) return;
        const asked = norm(String(event.name || ""));
        if (asked && asked !== norm(pendingConfirmName)) return;
        pendingConfirmName = null;
        if (!mod.trySend("C_REPLY_TELEPORT", 1, { accept: 1 })) return;
        return false;   // accepted; hide the popup
    });

    // Hide the "used <item>" message from our own atlas/journal opens.
    mod.hook("S_SYSTEM_MESSAGE", "*", event => {
        if (!expectingList && !expectingJournalList) return;
        let p;
        try { p = mod.parseSystemMessage(event.message); } catch (_) { return; }
        if (p && p.id === "SMT_ITEM_USED") return false;
    });

    // ---- command -----------------------------------------------------------

    // tp  -> towns (village atlas)
    mod.command.add("tp", (...args) => {
        try {
            if (settings.enabled === false) { msg("Teleporter is disabled (see config.json)."); return; }
            const query = args.join(" ").trim();
            if (!query) {
                msg("Teleporter - teleport to a town via the village atlas");
                msg("  Usage: tp <place name>   (e.g. tp velika, tp allemantheia)");
                msg('  Partial names work. For Travel Journal locations use "tpj".');
                return;
            }
            startTeleport(query);
        } catch (e) {
            msg(`Error: ${e && e.message ? e.message : e}`);
        }
    });

    // tpj -> Travel Journal locations. The mod opens the journal item for you, so no
    // need to open it in game first (once the item slot has been learned).
    mod.command.add("tpj", (...args) => {
        try {
            if (settings.enabled === false) { msg("Teleporter is disabled (see config.json)."); return; }
            const query = args.join(" ").trim();
            if (!query) {
                msg("Teleporter - teleport to a Travel Journal location");
                msg("  Usage: tpj <location name>   (partial names work)");
                const list = locationsList();
                if (list) msg(`  Locations: ${list}`);
                else if (journalSlot != null) { msg("  Loading locations..."); openJournal(null); }
                else msg("  " + needSlot("Travel Journal"));
                return;
            }
            openJournal(query);
        } catch (e) {
            msg(`Error: ${e && e.message ? e.message : e}`);
        }
    });
}

module.exports = { NetworkMod };
