"use strict";

const DefaultSettings = {
	"enabled": true,
	// Over-head icons only: true -> only hide on party/raid members,
	// false -> hide the listed buffs over ALL other players (never on yourself).
	// (The party window itself is always limited to party/raid members.)
	"partyOnly": true,
	// Also hide the listed buffs on YOUR OWN row in the party window.
	"includeSelf": false,
	// Numeric abnormality ids to hide (e.g. Elite Kaia's Protection, Crystalbind,
	// Reputation Boost, ...). Discover ids in-game with "pbf find" or "pbf scan".
	"blacklist": []
};

module.exports = function MigrateSettings(from_ver, to_ver, settings) {
	if (from_ver === undefined) {
		// Migrate legacy config file
		return { ...DefaultSettings, ...settings };
	} else if (from_ver === null) {
		// No config file exists, use default settings
		return DefaultSettings;
	} else {
		// Migrate from older version (using the new system) to latest one
		throw new Error("So far there is only one settings version and this should never be reached!");
	}
};
