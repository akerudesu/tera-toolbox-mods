# TERA Toolbox mods

A collection of mods for [TERA Toolbox](https://github.com/tera-toolbox) for classic TERA (v31.04)


## Install

Copy the mod folder(s) you want (for example `teleporter`)
into your `tera-toolbox/mods/` folder, then restart the toolbox.

---

## Teleporter — `tp`, `tpj`

Teleport by name through the village atlas or your Travel Journal.

| Command | What it does |
|---|---|
| `tp <place>` | Teleport to a town, e.g. `tp alle` → Allemantheia |
| `tpj <name>` | Teleport to a Travel Journal location, e.g. `tpj home` |
| `tp` / `tpj` | Show usage (`tpj` also lists your locations) |

## Party Buff Filter — `pbf`

Hide clutter buffs from your party/raid frames. Buffs are matched by numeric id.

| Command | What it does |
|---|---|
| `pbf` | Toggle filtering on/off |
| `pbf find <name>` | Search buffs by name to get their id |
| `pbf scan` | Toggle live scan mode to discover buff ids as they appear |
| `pbf add <id> [id …]` | Hide buff id(s) |
| `pbf remove <id> [id …]` | Stop hiding buff id(s) |
| `pbf list` | Show hidden buff ids |
| `pbf clear` | Remove all hidden buff ids |
| `pbf scope` | Over-head scope: party/raid-only vs. all players |
| `pbf self` | Also hide these on your own party row |
| `pbf refresh` | Clear lingering hidden buffs from current members |
| `pbf help` | Show this list |

Typical use: `pbf find kaia` (or `pbf scan`) to get an id, then `pbf add <id>`.

## Fast Quest — `fq`

Makes the `F` key actually select the single available option on quest dialogs.
On this server some quest boxes bind `F` to a hidden cancel action, so pressing
`F` resets the conversation instead of picking the one option — this drops that
action so `F` selects the real button and closes the box cleanly. No
auto-advance and no injected packets: you press `F` (or click) yourself, it just
works now. Multi-option dialogs (a real choice, quiz answers) are left for you to
pick with the mouse.

| Command | What it does |
|---|---|
| `fq` | Toggle the mod on/off |
| `fq debug` | Toggle `[fq]` packet logging in the toolbox console |

## Teralith — `teralith`

A lightweight DPS meter that runs entirely inside TERA Toolbox, capturing combat through its built-in network hooks. Why? Because I simply want to avoid the hassle of setting up an external parser under Linux.

| Command | What it does |
|---|---|
| `teralith on` | Enable Teralith and open the overlay |
| `teralith off` | Disable Teralith and close the overlay |


