# Hatch & Snatch (working title)

A Roblox creature game: hatch eggs off the conveyor, grow creatures from cute
babies into majestic adults, earn cash from them, and steal from other players
or protect your own.

- **Design:** [`docs/GDD.md`](docs/GDD.md)
- **Creatures:** [`docs/ROSTER.md`](docs/ROSTER.md), with concept images
- **Art rules:** [`docs/ART_BIBLE.md`](docs/ART_BIBLE.md)
- **Context for Claude sessions:** [`CLAUDE.md`](CLAUDE.md)

## One-time setup on your PC

1. **Roblox Studio:** install it and sign in.
2. **Git:** https://git-scm.com
3. **VS Code:** https://code.visualstudio.com. Add the extensions **Luau Language Server** (JohnnyMorganz), **StyLua**, **Selene** and **Rojo**.
4. **Rokit** (installs the pinned tools):
   - Windows PowerShell: `irm https://raw.githubusercontent.com/rojo-rbx/rokit/main/scripts/install.ps1 | iex`
   - Then, inside this folder: `rokit install`. That installs Rojo, StyLua and Selene at the versions pinned in `rokit.toml`.
5. **Rojo plugin for Studio:** run `rojo plugin install`, or install it from the Creator Store.
6. **Blender:** https://www.blender.org, for rigging and cleaning up creature models.
7. **A Roblox group** to own the game. Group ownership keeps payouts and team access clean.

## Daily workflow

```bash
rojo serve          # in this folder, keep it running
```

In Studio, open a Baseplate, then **Rojo plugin → Connect**. Code in `src/` syncs
live into Studio. Press **Play** to test. The server prints a config summary on
start. If it errors, the config data has a mistake.

```bash
stylua src          # format
selene src          # lint
```

## Layout

```
src/
  shared/Config/   data tables: creatures, rarities, finishes, mutations, biomes, economy, events
  server/          server bootstrap + services (authoritative: cash, hatching, growth, stealing)
  client/          UI, VFX, creature movement (visual only)
docs/              design, roster, art bible
```
