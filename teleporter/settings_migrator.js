/* eslint-disable no-param-reassign */
"use strict";

const DefaultSettings = {
    // Master toggle for the tp command.
    enabled: true,
    // PC-Bang inventory slot of the atlas item (learned automatically).
    atlasSlot: null,
    // PC-Bang inventory slot of the Travel Journal item (learned automatically).
    journalSlot: null,
    // Item id(s) that open the atlas. Override if yours differs.
    atlasItems: [181116],
    // Optional manual shortcuts: { "alias": <village atlas section id> }.
    aliases: {},
    // Auto-accept the "teleport to <name>?" prompt for Travel Journal jumps.
    autoConfirm: true
};

module.exports = function MigrateSettings(from_ver, to_ver, settings) {
    if (from_ver === undefined) return { ...DefaultSettings, ...settings };
    if (from_ver === null) return { ...DefaultSettings };
    return { ...DefaultSettings, ...settings, aliases: { ...(settings.aliases || {}) } };
};
