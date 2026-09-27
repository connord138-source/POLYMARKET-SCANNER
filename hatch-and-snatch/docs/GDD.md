# Hatch & Snatch: Game Design Document

Status: **pre-production.** The world, art style and roster are locked. The
numbers are first-pass drafts to tune during playtesting. Gameplay values live
in `src/shared/Config/*`, and that code is the source of truth; this document
explains the reasoning behind them.

## 1. Pitch

On an island under a cracked Moon Egg, players buy eggs off a conveyor, hatch
semi-realistic elemental creatures, raise them from cute babies into majestic
adults, and earn cash from them. Every other player can sneak in and **steal**
them. Players who'd rather raise their own get protection and bonuses for
doing so.

**Design goals**
1. **Learn it in 10 seconds:** buy an egg, place it, collect cash.
2. **Progress continues while you're away:** hatch and growth timers run offline, and cash is banked (capped at 8 hours).
3. **Social tension creates stories:** steals, revenge and trades produce clips people share.
4. **A collection that keeps pulling you in:** species × growth stage × mutation × finish × palette.
5. **Server-wide moments:** moon events bring players back at set times.

## 2. World: Crackpoint Island

- **Hatchery Reactor** (center): a glowing glass dome. The **egg conveyor loop** starts here and circles the island.
- **8 base plots** are arranged in a ring around the loop, so every base is equally close to the eggs and to each other. Each plot has:
  - pedestals (10 to start, upgradeable to 30),
  - a laser-gate **base lock** with a countdown light,
  - a cash collector and an incubator rack,
  - **nursery** slots.
- **The Moon Egg** hangs in the sky. Its color is the server's event alarm (section 8). Long-term, a big update lets the moon hatch, releasing Lunaris.
- **Biome eggs:** the conveyor carries eggs from biomes the player has unlocked through rebirths, and the map's look expands with them. The biomes, in order: Mossvale Forest → Coral Coast → Magma Rift → Frost Shelf → Storm Peaks → Moonfall.

## 3. Core loop

```
buy egg from conveyor → place in incubator → hatch (real-time timer)
    → creature on a pedestal earns cash/sec → grows Baby → Juvenile → Adult (earns more)
    → spend cash on better eggs, pedestals, base upgrades → rebirth to unlock the next biome
    ↘ steal other players' creatures / defend your own ↙
```

## 4. Creatures

- **Roster:** 30 at launch (`docs/ROSTER.md`): 5 biomes × 4, plus 4 in Moonfall and 6 in the Junk Egg.
- **Rarity tiers:** Common, Uncommon, Rare, Epic, Legendary, Mythic. Junk is its own event-only tier.
- **Tone by rarity:** cute or funny at the low end, majestic at the top. The most valuable creatures should look the most worth stealing.
- **Visual value:** rarer creatures glow more, so a player can read value from across the map before committing to a steal.

### 4.1 Growth (not merging)

| Stage | Earnings | Size | Carry speed when stolen |
|---|---|---|---|
| Baby | ×1 | small | 100% (full speed, can jump) |
| Juvenile | ×4 | medium | 75% |
| Adult | ×15 | large | 50% (no jumping) |

- **Growth time** is a base time multiplied by a rarity factor, and it keeps running while the player is offline.
- **Duplicates can be "fed"** to a creature of the same species to speed up its growth. This gives duplicates a use besides selling. *(Open question: confirm this during playtesting.)*

### 4.2 Movement

Creatures move with a **slow bounding run with a hop**: front paws reach together, back legs push off together, there's a short airborne arc, and a squash on landing.

- **By stage:** babies bounce too much and occasionally face-plant; adults land with heavy, powerful bounds, a thud, and a puff of their element (dust, embers, frost, sparks).
- **By body shape:** hoppers hop, heavy creatures stomp, and low-slung creatures scurry.
- **How it's built:** one hand-keyed bound animation per skeleton family, plus a shared procedural movement script. It handles hop height, landing squash, trailing tail and ears, head tracking toward nearby players (especially thieves), random blinks, and wandering around the base.

## 5. Rarity layers (the collection)

1. **Species rarity:** see the roster.
2. **Genetic mutations**, rolled at hatch. These give natural variety and are mostly cosmetic, with a small value bonus:
   - Albino 5%, Melanistic 3%, Leucistic 2%, Piebald 2%, Iridescent 0.2%.
3. **Finishes**, the flashy layer. Each is a material and particle swap, so no new models are needed:

| Finish | Odds | Earnings | Look |
|---|---|---|---|
| Normal | — | ×1 | — |
| Gold | 1 in 25 | ×1.5 | Gold with sparkles |
| Chrome | 1 in 100 | ×2 | Mirror finish that reflects the world |
| Diamond | 1 in 400 | ×3 | See-through crystal that bends light |
| Molten | 1 in 1,500 | ×5 | Glowing lava cracks, drips embers, sizzles |
| Galaxy | 1 in 5,000 | ×8 | Starfield skin with a tiny orbiting planet; server announcement |
| Prismatic | 1 in 20,000 | ×15 | Color-shifting glow and a rainbow trail; server-wide fanfare |
| Blood Moon | Blood Moon event only | ×10 | Black and red with a red aura |

4. **Color palettes:** unlockable recolors of each species' color regions. Palettes are a collection track and something players can buy.

**Collection size:** 30 species × 3 stages × 8 finishes = 720 versions before mutations and palettes are counted.

## 6. Stealing

| Rule | Draft value |
|---|---|
| All growth stages can be stolen | yes |
| Base lock duration, then cooldown | 60 s locked, 45 s cooldown |
| New-player protection | first 10 minutes |
| Creatures leave with their owner | theft only happens while the owner is online |
| Owner can knock a thief down so they drop the creature | yes; adults are dropped more easily |
| **Homegrown** (hatched and raised by you) | +25% earnings, struggles when grabbed (thief moves slower), can break free once per steal |
| **Stolen from [name]** tag | permanent; a stolen creature loses Homegrown status |
| **Nursery** slots (nothing in them can be stolen) | 1 to start; up to 3 with cash upgrades or the game pass |

All of this is checked on the server: grab range, carry state, drop-off at the thief's own base, and the lock state.

## 7. Economy (first-pass draft; tune in playtests)

| Rarity | Base cash/sec | Hatch time | Growth factor |
|---|---|---|---|
| Common | 1 | 30 s | ×1 |
| Uncommon | 4 | 90 s | ×1.25 |
| Rare | 15 | 5 min | ×1.5 |
| Epic | 60 | 15 min | ×2 |
| Legendary | 250 | 45 min | ×3 |
| Mythic | 1500 | 3 h | ×4 |
| Junk | 100 | 20 min | ×1.5 |

- **Growth times:** Baby → Juvenile takes 30 min × the growth factor; Juvenile → Adult takes 3 h × the growth factor.
- **Egg prices** scale about ×8 per biome.
- **Target payback** on a fresh egg is about 2–4 minutes early in the game, lengthening to 20–30 minutes late.
- **Rebirth** resets cash and pedestals, keeps creatures, unlocks the next biome and gives +10% earnings for each rebirth.
- **Offline earnings** are capped at 8 hours; the cap can be raised by a game pass.

## 8. Moon events (server-wide, hourly)

| Moon | Effect | Lasts |
|---|---|---|
| 🔴 Blood Moon | Finish chance ×5; Blood Moon finish available | 10 min |
| 🟡 Gold Moon | ×2 earnings | 10 min |
| 🟣 Void Moon | Thief night: locks shortened, bonus cash per steal | 10 min |
| 🌈 Prism Moon (rare) | Chance of a Prismatic finish; Junk Egg appears on the conveyor | 5 min |

A **weekly update at a fixed time**, with an admin-hosted live event, runs on top of this.

## 9. Monetization

The rule: everything that matters can be earned. Paying buys speed, convenience, protection or cosmetics. Eggs that can be bought with Robux are never the only way to get a creature. Odds must be shown for any random item bought with Robux, as Roblox policy requires.

- **Game passes (bought once):** 2× Cash, VIP Plot (+10 pedestals and a VIP tag), Auto-Collect, Extra Nursery, Longer Lock, Offline Cap +8h.
- **Developer products (bought repeatedly):**
  - **Server Luck Boost:** the whole server benefits, the buyer's name is announced, and it stacks. This is the headline product.
  - Instant Restock, Growth Elixir, Skip Hatch, Cash packs.
- **Other income:** Premium Payouts (from long sessions), rewarded video ads ("watch an ad for a free egg"), private servers.
- **Free promotion channels:** a like-goal code system, and a reward for joining the Roblox group.

## 10. Technical plan

- **Tooling:** Rojo 7 and Luau `--!strict`, with Rokit to pin tool versions. Format with StyLua, lint with selene.
- **Player data:** ProfileStore for saves, plus a session lock so the same account can't load in two servers at once.
- **Server-authoritative services:**
  - EggService (conveyor spawns and purchases)
  - HatchService
  - GrowthService
  - EconomyService (cash ticks and offline catch-up)
  - StealService (grab, carry, drop, locks)
  - EventService (moon events)
  - MonetizationService
- **Client:** UI, VFX and the procedural creature movement script (visual only; never trusted by the server).
- **Data-driven content:** creatures, rarities, finishes, mutations, biomes and the economy are Luau tables in `src/shared/Config`. Adding content means editing data.

### Art pipeline

1. Concept image in Higgsfield. Rules are in `docs/ART_BIBLE.md`.
2. Clean model sheet: neutral pose, legs apart.
3. Tripo H3.1 image-to-3D, capped at 8k faces.
4. Blender:
   - clean up, target 3–8k triangles,
   - split into jointed parts (head, neck, torso, 2-segment legs, 3-segment tail, plus prop parts),
   - rig with a shared skeleton family,
   - move glowing parts onto separate meshes (Neon material, swapped per finish).
5. Import through Studio's 3D Importer, then make baby, juvenile and adult versions by scaling proportions (babies get bigger heads and shorter legs).

## 11. Roadmap

| Week | Goal |
|---|---|
| 0 (now) | Design, art direction, roster ✅; repo scaffold ✅ |
| 1 | Studio set up on the owner's PC; Emberlynx imported and rigged; bounding-run test |
| 2 | Core loop: conveyor, buying, incubator, hatching, pedestals, cash, saving |
| 3 | Growth stages, stealing, base locks, nursery, Homegrown |
| 4 | Finishes and mutations, moon events, the collection index |
| 5 | Monetization, rebirth, UI polish, analytics |
| 6 | Soft launch with Mossvale and Coral Coast only; other biomes arrive in weekly updates |

Rolling out one biome per update is deliberate: it gives the weekly updates their content.

## 12. Open questions

- Should feeding duplicates to speed growth replace selling them, or sit alongside it?
- Should trading ship at launch or in the first update? (Leaning toward the first update, with trade locks.)
- The final game name: "Hatch & Snatch" is a working title.
