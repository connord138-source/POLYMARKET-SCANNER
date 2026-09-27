--!strict
-- Species rarity tiers. Numbers are first-pass drafts (docs/GDD.md §7); tune in playtests.
local Types = require(script.Parent.Types)

local Rarities: { [Types.RarityId]: Types.Rarity } = {
	Common = {
		id = "Common",
		order = 1,
		baseCashPerSec = 1,
		hatchSeconds = 30,
		growthFactor = 1,
		eventOnly = false,
		color = Color3.fromRGB(170, 170, 170),
	},
	Uncommon = {
		id = "Uncommon",
		order = 2,
		baseCashPerSec = 4,
		hatchSeconds = 90,
		growthFactor = 1.25,
		eventOnly = false,
		color = Color3.fromRGB(90, 200, 90),
	},
	Rare = {
		id = "Rare",
		order = 3,
		baseCashPerSec = 15,
		hatchSeconds = 5 * 60,
		growthFactor = 1.5,
		eventOnly = false,
		color = Color3.fromRGB(70, 140, 255),
	},
	Epic = {
		id = "Epic",
		order = 4,
		baseCashPerSec = 60,
		hatchSeconds = 15 * 60,
		growthFactor = 2,
		eventOnly = false,
		color = Color3.fromRGB(170, 80, 255),
	},
	Legendary = {
		id = "Legendary",
		order = 5,
		baseCashPerSec = 250,
		hatchSeconds = 45 * 60,
		growthFactor = 3,
		eventOnly = false,
		color = Color3.fromRGB(255, 170, 30),
	},
	Mythic = {
		id = "Mythic",
		order = 6,
		baseCashPerSec = 1500,
		hatchSeconds = 3 * 60 * 60,
		growthFactor = 4,
		eventOnly = true,
		color = Color3.fromRGB(255, 60, 90),
	},
	Junk = {
		id = "Junk",
		order = 7,
		baseCashPerSec = 100,
		hatchSeconds = 20 * 60,
		growthFactor = 1.5,
		eventOnly = true,
		color = Color3.fromRGB(150, 110, 70),
	},
}

return Rarities
