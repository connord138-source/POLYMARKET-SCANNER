--!strict
-- Shared type definitions for all config tables.

export type RarityId = "Common" | "Uncommon" | "Rare" | "Epic" | "Legendary" | "Mythic" | "Junk"

export type BiomeId = "Mossvale" | "CoralCoast" | "MagmaRift" | "FrostShelf" | "StormPeaks" | "Moonfall" | "Junk"

export type BodyPlan =
	"lean-predator"
	| "tall-leggy"
	| "heavy-tank"
	| "shelled"
	| "low-long"
	| "small-round"
	| "hopper"
	| "stocky"
	| "big-floppy"
	| "upright-bandit"

export type StageId = "Baby" | "Juvenile" | "Adult"

export type Rarity = {
	id: RarityId,
	order: number,
	baseCashPerSec: number,
	hatchSeconds: number,
	growthFactor: number,
	eventOnly: boolean,
	color: Color3,
}

export type Biome = {
	id: BiomeId,
	displayName: string,
	order: number, -- unlock order via rebirth; 0 = not on the normal conveyor
	eggPriceMultiplier: number,
}

export type Creature = {
	id: string,
	displayName: string,
	biome: BiomeId,
	rarity: RarityId,
	bodyPlan: BodyPlan,
	element: string,
	gag: string,
	conceptJob: string, -- Higgsfield job id (see docs/ROSTER.md)
}

export type Stage = {
	id: StageId,
	order: number,
	earningsMultiplier: number,
	scale: number,
	carrySpeed: number, -- fraction of thief walk speed while carrying
	thiefCanJump: boolean,
}

export type Finish = {
	id: string,
	displayName: string,
	oneIn: number?, -- nil = not rolled normally (event-only or Normal)
	earningsMultiplier: number,
	announce: "none" | "server" | "fanfare",
	eventOnly: string?, -- MoonEvent id, if only obtainable during that event
}

export type Mutation = {
	id: string,
	displayName: string,
	chance: number, -- 0..1 per hatch
	valueBonus: number, -- additive earnings bonus, e.g. 0.05 = +5%
}

export type MoonEvent = {
	id: string,
	displayName: string,
	durationSeconds: number,
	weight: number, -- relative pick weight for the hourly event
	finishChanceMultiplier: number,
	earningsMultiplier: number,
	lockDurationMultiplier: number,
	stealCashBonus: number,
	spawnsJunkEgg: boolean,
}

return {}
