--!strict
-- Finishes: the flashy rarity layer. Material + particle swaps, no new models.
-- Rolled rarest-first at hatch; see Economy.rollFinish.
local Types = require(script.Parent.Types)

local Finishes: { Types.Finish } = {
	{ id = "Normal", displayName = "Normal", oneIn = nil, earningsMultiplier = 1, announce = "none" },
	{ id = "Gold", displayName = "Gold", oneIn = 25, earningsMultiplier = 1.5, announce = "none" },
	{ id = "Chrome", displayName = "Chrome", oneIn = 100, earningsMultiplier = 2, announce = "none" },
	{ id = "Diamond", displayName = "Diamond", oneIn = 400, earningsMultiplier = 3, announce = "none" },
	{ id = "Molten", displayName = "Molten", oneIn = 1500, earningsMultiplier = 5, announce = "none" },
	{ id = "Galaxy", displayName = "Galaxy", oneIn = 5000, earningsMultiplier = 8, announce = "server" },
	{
		id = "Prismatic",
		displayName = "Prismatic",
		oneIn = 20000,
		earningsMultiplier = 15,
		announce = "fanfare",
	},
	{
		id = "BloodMoon",
		displayName = "Blood Moon",
		oneIn = 200,
		earningsMultiplier = 10,
		announce = "server",
		eventOnly = "BloodMoon",
	},
}

return Finishes
