--!strict
-- Genetic mutations rolled at hatch (at most one). Mostly cosmetic, small value bonus.
local Types = require(script.Parent.Types)

local Mutations: { Types.Mutation } = {
	{ id = "Albino", displayName = "Albino", chance = 0.05, valueBonus = 0.05 },
	{ id = "Melanistic", displayName = "Melanistic", chance = 0.03, valueBonus = 0.05 },
	{ id = "Leucistic", displayName = "Leucistic", chance = 0.02, valueBonus = 0.08 },
	{ id = "Piebald", displayName = "Piebald", chance = 0.02, valueBonus = 0.08 },
	{ id = "Iridescent", displayName = "Iridescent", chance = 0.002, valueBonus = 0.25 },
}

return Mutations
