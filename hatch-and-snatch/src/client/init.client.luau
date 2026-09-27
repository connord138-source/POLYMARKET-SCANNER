--!strict
-- Client bootstrap. Next up: HUD (cash, lock timer, moon event banner), creature
-- movement controller (procedural bounding run, head-tracking, spring tails), VFX.
-- The client is presentation only — the server never trusts it for cash/steals.
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Config = require(ReplicatedStorage.Shared.Config)

print(`[HatchAndSnatch] Client ready — {#Config.Creatures} creatures in config`)
