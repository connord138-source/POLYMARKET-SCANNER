# Art Bible

## The look

- **Inspiration:** *Creatures of Sonaria*. We take its style only; every design is original.
- **Anatomy:** semi-realistic fantasy animals with believable anatomy, natural proportions and **realistic animal eyes**.
- **Geometry:** faceted models, smoothly shaded, around 3–8k triangles per creature.
- **Color:** solid color regions per creature (body, belly, markings, eyes, glow) rather than detailed painted textures. These regions are what palettes recolor.
- **Real materials:** each creature is fused with a real natural material or element (basalt and magma, amethyst geode, coral, glacier ice, copper and lightning, nebula and void). Household objects appear only in the comic Junk Egg.
- **Glow is geometry:** glowing parts (magma cracks, bioluminescence, lightning) are separate meshes using Neon, so finishes can swap them.

## Tone by rarity

| Rarity | Tone | Benchmark |
|---|---|---|
| Common / Uncommon | Cute or funny, with rounder, younger proportions. Still realistic eyes. | Mossmunk, Zapybara, Coalby |
| Rare | Cute with a bit of wow | Hivebadger, Novapanda |
| Epic+ | Majestic, something people want to steal and show off | Emberlynx, Tidalotl |
| Junk | Pure comedy | Toastoise, Fridgehog |

## Rejected looks (never again)

- Generic cube or sphere blobs.
- Glossy "premium AI render" finishes.
- The Pixar look: skin with light glowing through, sculpted faces, film lighting. It doesn't translate to Roblox.
- Cartoon or anime eyes and toy proportions (Kitefin, Puffleece and Crateroo were rejected for this).
- Several creatures sharing the same lean cat or dog body.
- Every creature standing in the same side-on pose.

## Variety rules

1. **Silhouette test:** every creature must be identifiable from its black silhouette alone.
2. **Body-shape groups**, spread across every biome:

| Group | Examples |
|---|---|
| lean-predator | Emberlynx, Nebulion (keep it to 2) |
| tall-leggy | Geodeer, Coralope, Thunderhoof, Lawnmoose |
| heavy-tank | Slagodon, Calderhorn, Glacibear, Aurorox, Stormback, Lunaris |
| shelled | Clamodon, Toastoise |
| low-long | Kelpotter, Eclipsaur, Grillgator |
| small-round | Mossmunk, Coalby, Iceadillo, Zapybara, Novapanda, Fridgehog |
| hopper | Frostbun |
| stocky | Brambloar, Hivebadger, Bassdog |
| big-floppy | Tidalotl, Laundrophant |
| upright-bandit | Squallcoon |

3. **Signature pose:** each creature's concept shows a pose that fits its character (defensive, upright, sitting and stargazing, sniffing). The neutral pose is only for the 3D model sheet.
4. **Distinct color palettes** within a biome: the biome shares an element, but each creature needs its own color story.

## Prompt templates (Higgsfield `gpt_image_2_5`)

**Concept**, with 2–3 approved creatures as `medias` (`image_references`), e.g. Tidalotl `c9ac86c9…` and Hivebadger `f0c3c130…`:

```
Match ONLY the rendering style of the reference images (semi-realistic Roblox-engine
creature, low-poly faceted geometry with smooth shading, solid color regions, realistic
eyes, plain light gray background, even lighting). Do NOT copy their species, pose or
camera angle. NEW creature in a DYNAMIC POSE: <NAME> — <body shape>, <pose>, <real
material/element fusion>, <colors>. <Silhouette description>. No text.
```

**Clean model sheet** for 3D conversion, with the chosen concept as the reference and `quality: high`:

```
Using the creature from the reference image, create a single clean 3D character reference
render of only that creature: same design, same colors and style. Full body including
the full tail, side three-quarter view, neutral stance with all four legs straight and
slightly apart, mouth closed, tail extended, no ground, plain flat light gray background,
even neutral lighting, no particles, no text.
```

**3D conversion:** `tripo_h3_1_image_to_3d`, `face_limit: 8000`, `texture: true`, `pbr: true`.

## Growth stages

Baby, juvenile and adult come from one adult model with adjusted proportions:

- **Baby:** head about 1.4×, legs about 0.7×, horns, plates and crystals reduced or just starting to show, eyes about 1.2×. Babies should read as **cute**.
- **Juvenile:** halfway between baby and adult.
- **Adult:** full size.
