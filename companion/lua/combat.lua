-- Combat preview: what the game predicts if one of the local player's units
-- attacks. The engine's own simulation, as the unit panel shows it on hover.
-- Runs in InGame. Call shapes from UnitPanel.lua:
--   CombatManager.SimulateAttackVersus(attacker:GetComponentID(), defender:GetComponentID(), eCombatType)
--   CombatManager.CanAttackTarget(attacker:GetComponentID(), defender:GetComponentID(), eCombatType)
--   eCombatType: nil = melee, CombatTypes.RANGED, or CombatTypes.BOMBARD when
--   attacker:GetBombardCombat() > attacker:GetRangedCombat()
--   results[CombatResultParameters.ATTACKER|DEFENDER][COMBAT_STRENGTH|STRENGTH_MODIFIER|
--   DAMAGE_TO|FINAL_DAMAGE_TO|MAX_HIT_POINTS|DEFENSE_DAMAGE_TO|MAX_DEFENSE_HIT_POINTS]
-- P.attackerId: the attacking unit (local player's).
-- P.targets: optional list of { player, id }; default every visible foreign
--   unit within P.radius (default 6) of the attacker.
-- P.ranged: true for a ranged/bombard attack (default: ranged if the unit has
--   ranged strength, melee otherwise).

local me = Game.GetLocalPlayer()
local attacker = UnitManager.GetUnit(me, P.attackerId)
if attacker == nil then emitJson({ error = 'no unit ' .. tostring(P.attackerId) .. ' of the local player' }) return end

local ranged = P.ranged
if ranged == nil then ranged = attacker:GetRangedCombat() > 0 or attacker:GetBombardCombat() > 0 end
local eCombatType = nil
if ranged then
  eCombatType = CombatTypes.RANGED
  if attacker:GetBombardCombat() > attacker:GetRangedCombat() then eCombatType = CombatTypes.BOMBARD end
end

local out = {
  attacker = { id = attacker:GetID(), type = GameInfo.Units[attacker:GetType()].UnitType, x = attacker:GetX(), y = attacker:GetY(),
    hp = attacker:GetMaxDamage() - attacker:GetDamage(), moves = attacker:GetMovesRemaining(), attacks = attacker:GetAttacksRemaining() },
  mode = ranged and ((eCombatType == CombatTypes.BOMBARD) and 'bombard' or 'ranged') or 'melee',
  results = {},
}
if attacker:GetCombat() == 0 and attacker:GetReligiousStrength() == 0 then
  emitJson({ error = 'this unit cannot fight', attacker = out.attacker }) return
end

local targets = {}
if P.targets then
  for _, t in ipairs(P.targets) do
    local u = UnitManager.GetUnit(t.player, t.id)
    if u then targets[#targets + 1] = u end
  end
else
  local vis = PlayersVisibility[me]
  local radius = P.radius or 6
  for i = 0, 63 do
    local p = Players[i]
    if i ~= me and p and p:IsAlive() then
      for _, u in p:GetUnits():Members() do
        if u:GetCombat() > 0 and vis:IsVisible(u:GetX(), u:GetY())
          and Map.GetPlotDistance(attacker:GetX(), attacker:GetY(), u:GetX(), u:GetY()) <= radius then
          targets[#targets + 1] = u
        end
      end
    end
  end
end

for _, d in ipairs(targets) do
  local r = { player = d:GetOwner(), id = d:GetID(), type = GameInfo.Units[d:GetType()].UnitType, x = d:GetX(), y = d:GetY(),
    hp = d:GetMaxDamage() - d:GetDamage(), distance = Map.GetPlotDistance(attacker:GetX(), attacker:GetY(), d:GetX(), d:GetY()) }
  r.owner = try('owner', function() return L(PlayerConfigurations[d:GetOwner()]:GetCivilizationShortDescription()) end)
  local ok = try('sim', function()
    local res = CombatManager.SimulateAttackVersus(attacker:GetComponentID(), d:GetComponentID(), eCombatType)
    if res == nil then return false end
    local a = res[CombatResultParameters.ATTACKER]
    local df = res[CombatResultParameters.DEFENDER]
    r.attackerStrength = a[CombatResultParameters.COMBAT_STRENGTH] + a[CombatResultParameters.STRENGTH_MODIFIER]
    r.defenderStrength = df[CombatResultParameters.COMBAT_STRENGTH] + df[CombatResultParameters.STRENGTH_MODIFIER]
    r.damageToDefender = df[CombatResultParameters.DAMAGE_TO]
    r.damageToAttacker = a[CombatResultParameters.DAMAGE_TO]
    r.defenderHpAfter = df[CombatResultParameters.MAX_HIT_POINTS] - df[CombatResultParameters.FINAL_DAMAGE_TO]
    r.attackerHpAfter = a[CombatResultParameters.MAX_HIT_POINTS] - a[CombatResultParameters.FINAL_DAMAGE_TO]
    r.kills = df[CombatResultParameters.FINAL_DAMAGE_TO] >= df[CombatResultParameters.MAX_HIT_POINTS]
    r.dies = a[CombatResultParameters.FINAL_DAMAGE_TO] >= a[CombatResultParameters.MAX_HIT_POINTS]
    -- UnitPanel asks CanAttackTarget with the combat type the simulation chose.
    local simType = res[CombatResultParameters.COMBAT_TYPE]
    if simType ~= nil then
      r.canAttackNow = CombatManager.CanAttackTarget(attacker:GetComponentID(), d:GetComponentID(), simType)
    end
    return true
  end)
  if ok then out.results[#out.results + 1] = r end
end
table.sort(out.results, function(x, y) return (x.damageToDefender or 0) - (x.damageToAttacker or 0) > (y.damageToDefender or 0) - (y.damageToAttacker or 0) end)
out.gaps = __gaps
emitJson(out)
