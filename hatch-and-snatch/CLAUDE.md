# HATCH & SNATCH — Roblox game (read this first)

Roblox creature game: hatch eggs from a conveyor, grow creatures from baby to
adult, earn cash, and steal (or get stolen from). The goal is passive income
(game passes, dev products, Premium Payouts, rewarded ads).

This folder currently lives on the `claude/roblox-server-brainstorm-fi0l43`
branch of `polymarket-scanner` because the session could not create a new
GitHub repo (403). **Move it to its own repo (`hatch-and-snatch`) as soon as
the owner creates one**:
`git subtree split -P hatch-and-snatch -b hns-export`, then push that branch
to the new repo's `main`. It has nothing to do with the Polymarket worker.

## Decisions already made (do not re-litigate)

- **Concept:** the "Hatch & Snatch" tycoon won over survival co-op, obby and fishing ideas.
- **World:** Crackpoint Island.
  - A **Moon Egg** hangs cracked in the sky and drives the events: Blood, Gold, Void and Prism moons.
  - A Hatchery Reactor sits in the center, with a **conveyor loop** carrying eggs.
  - **8 base plots** are arranged in a ring around the loop.
  - The owner approved the loop and plot layout.
- **Art style:** inspired by *Creatures of Sonaria*, taking only the style and never its designs.
  - Semi-realistic fantasy animals with natural proportions and **realistic eyes**.
  - Faceted models with smooth shading and solid color regions.
  - Each creature is fused with a **real natural material or element**: magma, geode, coral, ice, lightning, void.
- **Approved references:**
  - **Emberlynx** (the magma lynx; a 3D model already exists).
  - **Tidalotl** (the coral axolotl).
  - **Hivebadger**.
- **Tone by rarity:** Common and Uncommon are cute or funny, Rare sits in between, Epic and above are majestic. Junk Egg creatures are pure comedy.
- **Growth, not evolution:** Baby → Juvenile → Adult, like Sonaria life stages.
- **Movement:** a slow bounding run with a hop, not a walk.
  - Babies are bouncy and clumsy, and sometimes face-plant.
  - Adults land with heavy, powerful bounds.
- **Stealing:** every stage can be stolen.
  - Carry speed goes Baby 100% → Juvenile 75% → Adult 50%.
  - "Homegrown" creatures get +25% earnings, struggle when grabbed, and can break free once.
  - Stolen creatures carry a permanent "Stolen from X" tag.
  - Each base has protected **nursery** slots for players who prefer raising their own.
- **Rarity layers:** species rarity, then genetic mutations at hatch, then **finishes** (Gold → Chrome → Diamond → Molten → Galaxy → Prismatic, plus event-only Blood Moon), then color palettes.
  - The owner loved the finish-sheet look (the toaster tortoise in 7 finishes).
- **Junk Egg:** rare and event-only, containing comic household-object creatures such as the Toaster Tortoise and Fridge Hedgehog.
- **Roster:** 30 creatures are final. See `docs/ROSTER.md` and `src/shared/Config/Creatures.luau`.

## Art direction lessons (learned the hard way)

The owner rejected all of the following:

- Generic cube or sphere creatures.
- Glossy "AI-looking" premium renders.
- A Pixar look, which doesn't translate to Roblox.
- Cartoon or anime eyes, and toy-like "cute" proportions (Kitefin, Puffleece, Crateroo, the first Cometoad).
- Too many similar lean cat or dog bodies.
- Everything standing in the **same side-on pose**.

How to prompt for concepts:

1. Use **2–3 approved creatures together** as style references, never just one; a single reference copies its body and pose. Tell the model to copy style only, not species, pose or camera.
2. Give every creature a **distinct body shape** (see the body-shape groups in `docs/ART_BIBLE.md`) and a **signature pose and silhouette**.
3. Use the neutral, legs-apart pose only for the clean model sheet sent to 3D conversion.

## Tooling notes

- **Higgsfield:** project "Hatch & Snatch — Art Tests".
  - Folder/project id `6d89dc0f-9bb7-4421-aa38-a2c3f0e1a49a`, workspace `0e9c384c-231d-44f7-92bd-b44c00f8b6ff`.
  - Concept images: `gpt_image_2_5` at 0.25 credits (low quality) or 1.5 (high quality).
  - 3D: `tripo_h3_1_image_to_3d` with face_limit 8000, about 9 credits.
- **Image files are not reachable from the sandbox.** The CloudFront download is blocked, so images can't be viewed here; only the owner sees them in the gallery. Use the job IDs in `docs/ROSTER.md` as `medias` references.
- The owner has granted **full permission** for this work, including Higgsfield spend at this scale. Don't ask for small confirmations.
- The owner prefers compact, decision-focused replies and keeping conversation context.

## Tech

- Rojo 7 (`default.project.json`) with Luau `--!strict`.
- Tool versions are pinned in `rokit.toml`; lint with selene and format with StyLua.
- Config is data-driven in `src/shared/Config/*`. New content means editing tables, not code.
- The server is authoritative for cash, hatching, growth and stealing, since stealing games attract exploiters.
- Player data: ProfileStore (to be added).
