'use strict';

// Indexed by TERA job id - S_PARTY_MEMBER_LIST member.class is numeric, so order is load-bearing.
const CLASS_BY_ID = [
    'warrior',
    'lancer',
    'slayer',
    'berserker',
    'sorcerer',
    'archer',
    'priest',
    'mystic',
    'reaper',
    'gunner',
    'brawler',
    'ninja',
    'valkyrie'
];

// DataCenter internal names (mod.game.me.class is a string) differ from canonical keys - map them.
const ALIASES = {
    warrior: 'warrior',
    lancer: 'lancer',
    slayer: 'slayer',
    berserker: 'berserker',
    sorcerer: 'sorcerer',
    archer: 'archer',
    priest: 'priest',
    elementalist: 'mystic',
    mystic: 'mystic',
    soulless: 'reaper',
    reaper: 'reaper',
    engineer: 'gunner',
    gunner: 'gunner',
    fighter: 'brawler',
    brawler: 'brawler',
    assassin: 'ninja',
    ninja: 'ninja',
    glaiver: 'valkyrie',
    valkyrie: 'valkyrie'
};

// Colors grouped by role.
const META = {
    // Tanks
    lancer: { name: 'Lancer', color: '#4a8fe0' },
    brawler: { name: 'Brawler', color: '#3fb2cf' },
    // Healers
    priest: { name: 'Priest', color: '#84cf4d' },
    mystic: { name: 'Mystic', color: '#33bd93' },
    // DPS
    warrior: { name: 'Warrior', color: '#e5484d' },
    berserker: { name: 'Berserker', color: '#ef6d3a' },
    slayer: { name: 'Slayer', color: '#f39a3c' },
    gunner: { name: 'Gunner', color: '#e8b93f' },
    archer: { name: 'Archer', color: '#cdd24a' },
    reaper: { name: 'Reaper', color: '#7b6ce0' },
    sorcerer: { name: 'Sorcerer', color: '#aa5fe0' },
    valkyrie: { name: 'Valkyrie', color: '#d05fce' },
    ninja: { name: 'Ninja', color: '#ec5a9e' }
};

const UNKNOWN = { key: 'unknown', name: 'Unknown', color: '#9aa0a6' };

function normalizeClass(cls) {
    if (cls === null || cls === undefined) return null;
    if (typeof cls === 'number') return CLASS_BY_ID[cls] || null;
    const s = String(cls).toLowerCase();
    if (ALIASES[s]) return ALIASES[s];
    return META[s] ? s : null;
}

function classMeta(cls) {
    const key = normalizeClass(cls);
    if (key && META[key]) {
        const m = META[key];
        return { key: key, name: m.name, color: m.color };
    }
    return UNKNOWN;
}

module.exports = { normalizeClass, classMeta, CLASS_BY_ID, META };
