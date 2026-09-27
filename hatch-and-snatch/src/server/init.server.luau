--!strict
-- Server bootstrap. For now: validate all config data so content mistakes fail loudly
-- the moment you press Play. Services (Egg, Hatch, Growth, Economy, Steal, Event,
-- Monetization) get wired in here next — see docs/GDD.md §10.
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Config = require(ReplicatedStorage.Shared.Config)

local function validateConfig(): { string }
	local problems: { string } = {}
	local seen: { [string]: boolean } = {}
	local perBiome: { [string]: number } = {}

	for _, creature in Config.Creatures do
		if seen[creature.id] then
			table.insert(problems, `duplicate creature id: {creature.id}`)
		end
		seen[creature.id] = true
		if Config.Biomes[creature.biome] == nil then
			table.insert(problems, `{creature.id}: unknown biome {creature.biome}`)
		end
		if Config.Rarities[creature.rarity] == nil then
			table.insert(problems, `{creature.id}: unknown rarity {creature.rarity}`)
		end
		perBiome[creature.biome] = (perBiome[creature.biome] or 0) + 1
	end

	for biomeId in Config.Biomes do
		if (perBiome[biomeId] or 0) == 0 then
			table.insert(problems, `biome {biomeId} has no creatures`)
		end
	end

	local mutationTotal = 0
	for _, mutation in Config.Mutations do
		mutationTotal += mutation.chance
	end
	if mutationTotal >= 1 then
		table.insert(problems, `mutation chances sum to {mutationTotal} (must be < 1)`)
	end

	return problems
end

local problems = validateConfig()
if #problems > 0 then
	error("[HatchAndSnatch] Config invalid:\n  " .. table.concat(problems, "\n  "))
end

print(`[HatchAndSnatch] Config OK — {#Config.Creatures} creatures loaded`)
