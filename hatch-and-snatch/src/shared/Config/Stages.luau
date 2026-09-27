--!strict
-- Growth stages. Growth time = base seconds × rarity growthFactor (see Economy).
local Types = require(script.Parent.Types)

local Stages: { [Types.StageId]: Types.Stage } = {
	Baby = {
		id = "Baby",
		order = 1,
		earningsMultiplier = 1,
		scale = 0.45,
		carrySpeed = 1.0,
		thiefCanJump = true,
	},
	Juvenile = {
		id = "Juvenile",
		order = 2,
		earningsMultiplier = 4,
		scale = 0.7,
		carrySpeed = 0.75,
		thiefCanJump = true,
	},
	Adult = {
		id = "Adult",
		order = 3,
		earningsMultiplier = 15,
		scale = 1,
		carrySpeed = 0.5,
		thiefCanJump = false,
	},
}

return Stages
