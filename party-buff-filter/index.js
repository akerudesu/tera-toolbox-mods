'use strict';

// Party Buff Filter
// -----------------
// Hides selected buffs (abnormalities) so they don't clutter your party list.
//
// TERA draws buffs on TWO independent surfaces, fed by different packets:
//   * The party/raid WINDOW rows      -> S_PARTY_MEMBER_ABNORMAL_ADD / _REFRESH
//                                        (keyed by serverId + playerId)
//   * The over-head icons on the 3D   -> S_ABNORMALITY_BEGIN / _REFRESH
//     player entity                     (keyed by gameId)
// Both carry the same numeric abnormality `id`. We drop the ids you blacklist on
// both surfaces, so a hidden buff disappears from the party list AND from over
// the member's head. This only changes what your client displays, not gameplay.
//
// Find ids with "pbf find <name>" (needs client data) or "pbf scan" (live), then
// "pbf add <id>".

// Party-window buffs (serverId + playerId + id). THIS is the party list.
const PARTY_PACKETS = ['S_PARTY_MEMBER_ABNORMAL_ADD', 'S_PARTY_MEMBER_ABNORMAL_REFRESH'];
// Over-head buffs on the player entity (target gameId + id).
const OVERHEAD_PACKETS = ['S_ABNORMALITY_BEGIN', 'S_ABNORMALITY_REFRESH'];

// Cap on how many matches "pbf find" prints so a broad query can't spam chat.
const MAX_FIND_RESULTS = 20;

module.exports = function PartyBuffFilter(mod) {
	const { command, game } = mod;

	// tera-game-state subsystems we rely on.
	game.initialize('me');
	game.initialize('party');

	// Fast O(1) lookup set kept in sync with the persisted blacklist array.
	let blocked = new Set();

	// Scan mode: log every buff as it lands so the user can find the id to hide.
	// Deduped so it doesn't spam.
	let scanning = false;
	let scanSeen = new Set();

	function persist() {
		mod.settings.blacklist = [...blocked].sort((a, b) => a - b);
	}

	function loadBlacklist() {
		blocked = new Set(
			(mod.settings.blacklist || [])
				.map(Number)
				.filter(n => Number.isInteger(n))
		);
		persist();
	}
	loadBlacklist();

	// --- optional datacenter name lookup (id -> "Crystalbind"), degrades to id
	function abnormalityTable() {
		try {
			return (game.data && game.data.abnormalities) || null;
		} catch (_) {
			return null;
		}
	}

	function abnormalityName(id) {
		const table = abnormalityTable();
		const info = table && table.get(id);
		return info && info.name ? String(info.name) : null;
	}

	// "12345 (Crystalbind)" when the name is known, otherwise just "12345".
	function label(id) {
		const name = abnormalityName(id);
		return name ? `${id} (${name})` : `${id}`;
	}

	// --- identity helpers
	function isSelfGameId(gameId) {
		try {
			return game.me.is(gameId);
		} catch (_) {
			return false;
		}
	}

	function isSelfMember(serverId, playerId) {
		try {
			return !!game.me && game.me.playerId === playerId && game.serverId === serverId;
		} catch (_) {
			return false;
		}
	}

	function memberNameByGameId(gameId) {
		try {
			const m = game.party.getMemberData(gameId);
			return m ? m.name : `gameId ${gameId}`;
		} catch (_) {
			return `gameId ${gameId}`;
		}
	}

	function memberNameByPid(serverId, playerId) {
		try {
			const list = (game.party && game.party.partyMembers) || [];
			const m = list.find(x => x.serverId === serverId && x.playerId === playerId);
			return m ? m.name : `playerId ${playerId}`;
		} catch (_) {
			return `playerId ${playerId}`;
		}
	}

	function scanOnce(key, line, logLine) {
		if (!scanning || scanSeen.has(key)) return;
		scanSeen.add(key);
		command.message(line);
		mod.log(logLine);
	}

	// --- party-window filter (the actual party list) --------------------------
	function onPartyMemberAbnormal(event) {
		const self = isSelfMember(event.serverId, event.playerId);
		if (self && !mod.settings.includeSelf) return; // leave your own row alone

		const flag = blocked.has(event.id) ? ' <font color="#ff8888">(already hidden)</font>' : '';
		const who = self ? 'you' : memberNameByPid(event.serverId, event.playerId);
		scanOnce(`L:${event.serverId}:${event.playerId}:${event.id}`,
			`<font color="#88ccff">[scan:list]</font> ${who} -> <font color="#ffdd55">${label(event.id)}</font>${flag}`,
			`[scan:list] ${who} (sid ${event.serverId} pid ${event.playerId}) abnormality ${label(event.id)}`);

		if (mod.settings.enabled && blocked.has(event.id))
			return false; // drop -> buff never shows on this member's party row
	}

	// --- over-head filter (bonus: hides the icon over the member's head) ------
	function onOverheadAbnormal(event) {
		if (isSelfGameId(event.target)) return; // never touch your own buffs
		if (mod.settings.partyOnly && !safeIsMember(event.target)) return;

		const flag = blocked.has(event.id) ? ' <font color="#ff8888">(already hidden)</font>' : '';
		scanOnce(`O:${event.target}:${event.id}`,
			`<font color="#88ccff">[scan:over]</font> ${memberNameByGameId(event.target)} -> <font color="#ffdd55">${label(event.id)}</font>${flag}`,
			`[scan:over] ${memberNameByGameId(event.target)} (gameId ${event.target}) abnormality ${label(event.id)}`);

		if (mod.settings.enabled && blocked.has(event.id))
			return false;
	}

	function safeIsMember(gameId) {
		try {
			return game.party.isMember(gameId);
		} catch (_) {
			return false;
		}
	}

	// Tell the client to remove a buff icon from a member's party row right now.
	// A DEL for a buff the member doesn't have is harmless (ignored).
	function sendPartyDel(serverId, playerId, id) {
		try {
			mod.send('S_PARTY_MEMBER_ABNORMAL_DEL', '*', { serverId, playerId, id });
			return true;
		} catch (_) {
			return false;
		}
	}

	// Proactively clear already-displayed icons for the given ids from every
	// current party/raid member's row (and yours if includeSelf). Needed because
	// dropping incoming packets only stops *new*/refreshing buffs; a buff already
	// on the list (e.g. a permanent reputation boost) would otherwise linger.
	function clearForAll(ids) {
		if (!ids.length || !mod.settings.enabled) return;
		let members;
		try {
			members = (game.party && game.party.partyMembers) || [];
		} catch (_) {
			members = [];
		}
		for (const m of members)
			for (const id of ids)
				sendPartyDel(m.serverId, m.playerId, id);
		if (mod.settings.includeSelf) {
			try {
				if (game.me && game.me.playerId != null)
					for (const id of ids) sendPartyDel(game.serverId, game.me.playerId, id);
			} catch (_) { /* ignore */ }
		}
	}

	// --- install hooks (resilient: a missing packet won't kill the mod) -------
	function hookSafe(name, cb) {
		try {
			mod.hook(name, '*', cb);
			return true;
		} catch (e) {
			mod.warn(`could not hook ${name} (${e && e.message ? e.message : e}) - filtering for it is disabled`);
			return false;
		}
	}

	const partyHooked = PARTY_PACKETS.map(p => hookSafe(p, onPartyMemberAbnormal)).some(Boolean);
	OVERHEAD_PACKETS.forEach(p => hookSafe(p, onOverheadAbnormal));
	if (!partyHooked)
		mod.warn('party-window abnormality packets are unavailable on this patch; party-list buffs cannot be filtered.');

	// --- keep the list clean on (re)load and whenever it is (re)sent ----------
	// Dropping incoming packets only stops NEW buffs. Buffs already showing when
	// we load (e.g. after a mod reload) or that the server re-sends when the
	// party list is rebuilt (zoning, re-entering an instance) must be actively
	// removed, otherwise they linger until you toggle the filter. Debounced so a
	// burst of list/join events only triggers one sweep, and delayed so it runs
	// after the batch of ADD packets that accompanies a list refresh.
	let clearTimer = null;
	function scheduleClear() {
		if (!mod.settings.enabled || !blocked.size) return;
		if (clearTimer) mod.clearTimeout(clearTimer);
		clearTimer = mod.setTimeout(() => {
			clearTimer = null;
			clearForAll([...blocked]);
		}, 800);
	}

	const onPartyList = () => scheduleClear();
	try {
		game.party.on('list', onPartyList);
	} catch (_) {
		mod.warn('could not subscribe to party updates; buffs may linger after zoning until you re-add or refresh.');
	}
	scheduleClear(); // initial sweep in case we loaded while already in a party

	// ---------------------------------------------------------------- commands

	function statusLine() {
		return `Party Buff Filter is ${mod.settings.enabled ? '<font color="#55ff55">ON</font>' : '<font color="#ff5555">OFF</font>'}, `
			+ `hiding <font color="#ffdd55">${blocked.size}</font> buff id(s). `
			+ `Over-head scope: ${mod.settings.partyOnly ? 'party/raid only' : 'all players'}. `
			+ `Own party row: ${mod.settings.includeSelf ? 'hidden too' : 'left alone'}.`;
	}

	function parseIds(raw) {
		const good = [], bad = [];
		for (const token of raw) {
			const id = Number(token);
			if (Number.isInteger(id) && id > 0) good.push(id);
			else bad.push(token);
		}
		return { good, bad };
	}

	function printHelp() {
		command.message([
			`<font color="#ffdd55">Party Buff Filter</font> — hide buffs from your party/raid list`,
			`<font color="#ffffff">pbf</font> — toggle filtering on/off`,
			`<font color="#ffffff">pbf find &lt;name&gt;</font> — search buffs by name to get their id`,
			`<font color="#ffffff">pbf scan</font> — toggle scan mode to discover buff ids live`,
			`<font color="#ffffff">pbf add &lt;id&gt; [id ...]</font> — hide buff id(s)`,
			`<font color="#ffffff">pbf remove &lt;id&gt; [id ...]</font> — stop hiding buff id(s)`,
			`<font color="#ffffff">pbf list</font> — show hidden buff ids`,
			`<font color="#ffffff">pbf clear</font> — remove all hidden buff ids`,
			`<font color="#ffffff">pbf scope</font> — over-head scope: party/raid-only vs all players`,
			`<font color="#ffffff">pbf self</font> — also hide these on your own party row`,
			`<font color="#ffffff">pbf refresh</font> — clear lingering hidden buffs from current members`,
			statusLine()
		].join('\n'));
	}

	command.add('pbf', {
		$none() {
			mod.settings.enabled = !mod.settings.enabled;
			if (mod.settings.enabled) clearForAll([...blocked]); // wipe any lingering icons
			command.message(statusLine());
			command.message(mod.settings.enabled
				? '<font color="#aaaaaa">Note: hidden buffs already on party members were cleared.</font>'
				: '<font color="#aaaaaa">Note: buffs that were hidden won\'t come back right away. They show again after they refresh or when you change zones.</font>');
		},
		add(...raw) {
			if (!raw.length) return command.message('Usage: pbf add <id> [id ...]');
			const { good, bad } = parseIds(raw);
			const added = good.filter(id => !blocked.has(id));
			added.forEach(id => blocked.add(id));
			persist();
			clearForAll(added); // remove them from members' rows immediately
			if (added.length) command.message(`Now hiding: <font color="#ffdd55">${added.map(label).join(', ')}</font>. Total: ${blocked.size}.`);
			else command.message('No new ids added (already hidden or invalid).');
			if (bad.length) command.message(`<font color="#ff8888">Ignored non-numeric:</font> ${bad.join(', ')}`);
		},
		remove(...raw) {
			if (!raw.length) return command.message('Usage: pbf remove <id> [id ...]');
			const { good } = parseIds(raw);
			const removed = good.filter(id => blocked.delete(id));
			persist();
			command.message(removed.length
				? `No longer hiding: <font color="#ffdd55">${removed.join(', ')}</font>. Total: ${blocked.size}.`
				: 'None of those ids were in the list.');
		},
		list() {
			if (!blocked.size)
				return command.message('No buff ids are hidden yet. Use "pbf find <name>" or "pbf scan", then "pbf add <id>".');
			const ids = [...blocked].sort((a, b) => a - b);
			command.message(`Hidden buffs (${ids.length}):\n<font color="#ffdd55">${ids.map(label).join('\n')}</font>`);
		},
		clear() {
			const n = blocked.size;
			blocked.clear();
			persist();
			command.message(`Cleared ${n} hidden buff id(s).`);
		},
		find(...raw) {
			const query = raw.join(' ').trim().toLowerCase();
			if (!query) return command.message('Usage: pbf find <name>  (e.g. pbf find kaia)');

			const table = abnormalityTable();
			if (!table || table.size === 0)
				return command.message('<font color="#ff8888">Buff names are not available</font> (no client data). Use "pbf scan" to capture ids instead.');

			const matches = [];
			for (const [id, info] of table) {
				if (info && info.name && String(info.name).toLowerCase().includes(query)) {
					matches.push([id, String(info.name)]);
					if (matches.length > MAX_FIND_RESULTS) break;
				}
			}

			if (!matches.length)
				return command.message(`No buffs found matching "${query}".`);

			const shown = matches.slice(0, MAX_FIND_RESULTS)
				.sort((a, b) => a[0] - b[0])
				.map(([id, name]) => `${id} (${name})`);
			let msg = `Matches for "${query}":\n<font color="#ffdd55">${shown.join('\n')}</font>\nThen: pbf add <id>`;
			if (matches.length > MAX_FIND_RESULTS) msg += `\n<font color="#ff8888">(showing first ${MAX_FIND_RESULTS}, refine your search)</font>`;
			command.message(msg);
		},
		scan() {
			scanning = !scanning;
			scanSeen = new Set();
			command.message(scanning
				? 'Buff scan <font color="#55ff55">ON</font>. Buffs on party/raid members are printed as [scan:list] (party window) / [scan:over] (over-head). Then "pbf add <id>".'
				: 'Buff scan <font color="#ff5555">OFF</font>.');
		},
		scope() {
			mod.settings.partyOnly = !mod.settings.partyOnly;
			command.message(`Over-head scope: <font color="#ffdd55">${mod.settings.partyOnly ? 'party/raid members only' : 'all other players'}</font>. (The party window is always party/raid.)`);
		},
		self() {
			mod.settings.includeSelf = !mod.settings.includeSelf;
			command.message(`Your own party-window row: <font color="#ffdd55">${mod.settings.includeSelf ? 'these buffs hidden there too' : 'left untouched'}</font>.`);
		},
		refresh() {
			if (!mod.settings.enabled) return command.message('Filter is OFF — nothing to refresh. Enable it with "pbf".');
			clearForAll([...blocked]);
			command.message(`Cleared ${blocked.size} hidden buff id(s) from current party/raid members.`);
		},
		help: printHelp,
		$default(cmd) {
			command.message(`Unknown subcommand "${cmd}".`);
			printHelp();
		}
	});

	this.destructor = () => {
		try {
			game.party.removeListener('list', onPartyList);
		} catch (_) { /* ignore */ }
		if (clearTimer) mod.clearTimeout(clearTimer);
		command.remove('pbf');
	};
};
