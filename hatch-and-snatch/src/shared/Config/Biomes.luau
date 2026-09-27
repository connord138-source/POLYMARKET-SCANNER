--!strict
-- Biomes unlock in `order` via rebirth. Moonfall is endgame; Junk is event-only (Prism Moon).
local Types = require(script.Parent.Types)

local Biomes: { [Types.BiomeId]: Types.Biome } = {
	Mossvale = { id = "Mossvale", displayName = "Mossvale Forest", order = 1, eggPriceMultiplier = 1 },
	CoralCoast = { id = "CoralCoast", displayName = "Coral Coast", order = 2, eggPriceMultiplier = 8 },
	MagmaRift = { id = "MagmaRift", displayName = "Magma Rift", order = 3, eggPriceMultiplier = 64 },
	FrostShelf = { id = "FrostShelf", displayName = "Frost Shelf", order = 4, eggPriceMultiplier = 512 },
	StormPeaks = { id = "StormPeaks", displayName = "Storm Peaks", order = 5, eggPriceMultiplier = 4096 },
	Moonfall = { id = "Moonfall", displayName = "Moonfall", order = 6, eggPriceMultiplier = 32768 },
	Junk = { id = "Junk", displayName = "Junk Egg", order = 0, eggPriceMultiplier = 256 },
}

return Biomes
