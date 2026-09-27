--!strict
-- Single entry point: `local Config = require(ReplicatedStorage.Shared.Config)`
return {
	Rarities = require(script.Rarities),
	Biomes = require(script.Biomes),
	Stages = require(script.Stages),
	Finishes = require(script.Finishes),
	Mutations = require(script.Mutations),
	MoonEvents = require(script.MoonEvents),
	Creatures = require(script.Creatures),
	Economy = require(script.Economy),
}
