--!strict
-- Economy tunables + pure helper math (no Roblox services, safe on client and server).
local Types = require(script.Parent.Types)
local Rarities = require(script.Parent.Rarities)
local Stages = require(script.Parent.Stages)
local Finishes = require(script.Parent.Finishes)
local Mutations = require(script.Parent.Mutations)

local Tunables = {
	-- Growth: stage N -> N+1 takes base × rarity growthFactor (runs offline too)
	growthSeconds = {
		Baby = 30 * 60, -- Baby -> Juvenile
		Juvenile = 3 * 60 * 60, -- Juvenile -> Adult
	} :: { [Types.StageId]: number },

	offlineCapSeconds = 8 * 60 * 60,
	homegrownBonus = 0.25,
	rebirthBonusPerLevel = 0.10,

	-- Stealing / base defence
	lockDurationSeconds = 60,
	lockCooldownSeconds = 45,
	newPlayerProtectionSeconds = 10 * 60,
	nurserySlotsBase = 1,
	nurserySlotsMax = 3,
	pedestalsBase = 10,
	pedestalsMax = 30,
	basePlotsPerServer = 8,

	-- Moon events
	moonEventIntervalSeconds = 60 * 60,
}

export type CreatureInstanceStats = {
	rarity: Types.RarityId,
	stage: Types.StageId,
	finish: string,
	mutation: string?,
	homegrown: boolean,
}

local finishById: { [string]: Types.Finish } = {}
for _, finish in Finishes do
	finishById[finish.id] = finish
end

local mutationById: { [string]: Types.Mutation } = {}
for _, mutation in Mutations do
	mutationById[mutation.id] = mutation
end

-- Cash per second for one creature, before server-wide multipliers (events, passes, rebirth).
local function cashPerSecond(stats: CreatureInstanceStats): number
	local rarity = Rarities[stats.rarity]
	local stage = Stages[stats.stage]
	local finish = finishById[stats.finish] or finishById.Normal
	local bonus = 1
	if stats.mutation then
		local mutation = mutationById[stats.mutation]
		if mutation then
			bonus += mutation.valueBonus
		end
	end
	if stats.homegrown then
		bonus += Tunables.homegrownBonus
	end
	return rarity.baseCashPerSec * stage.earningsMultiplier * finish.earningsMultiplier * bonus
end

-- Seconds to grow from `stage` to the next stage (nil when already Adult).
local function secondsToNextStage(rarityId: Types.RarityId, stage: Types.StageId): number?
	local base = Tunables.growthSeconds[stage]
	if base == nil then
		return nil
	end
	return base * Rarities[rarityId].growthFactor
end

-- Rolls a finish rarest-first. `activeEventId` enables event-only finishes;
-- `chanceMultiplier` comes from moon events / luck boosts. `rng` is injected for testability.
local function rollFinish(rng: Random, activeEventId: string?, chanceMultiplier: number): string
	local ordered = table.clone(Finishes)
	table.sort(ordered, function(a, b)
		return (a.oneIn or 0) > (b.oneIn or 0)
	end)
	for _, finish in ordered do
		local oneIn = finish.oneIn
		local eligible = oneIn ~= nil and (finish.eventOnly == nil or finish.eventOnly == activeEventId)
		if eligible and rng:NextNumber() < chanceMultiplier / (oneIn :: number) then
			return finish.id
		end
	end
	return "Normal"
end

-- Rolls at most one genetic mutation.
local function rollMutation(rng: Random): string?
	local roll = rng:NextNumber()
	local cumulative = 0
	for _, mutation in Mutations do
		cumulative += mutation.chance
		if roll < cumulative then
			return mutation.id
		end
	end
	return nil
end

local Economy = table.freeze({
	tunables = Tunables,
	cashPerSecond = cashPerSecond,
	secondsToNextStage = secondsToNextStage,
	rollFinish = rollFinish,
	rollMutation = rollMutation,
})

return Economy
