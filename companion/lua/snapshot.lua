-- Whole-empire snapshot. Runs in the InGame (UI) Lua state, which has the
-- local player's full read view: the same data the game's own panels show.
-- Every optional section is wrapped in try(); an API that fails leaves a
-- named entry in `gaps` rather than a guessed value.
-- Params: P.includeBuildable (bool), P.foreignRadius (int)

local me = Game.GetLocalPlayer()
if me == nil or me < 0 then
  emitJson({ error = 'no local player (main menu or loading?)' })
  return
end
local pMe = Players[me]
local S = { gaps = __gaps }

-- Hash -> type name for every producible thing, built once per call.
local hashName = {}
for r in GameInfo.Units() do hashName[r.Hash] = r.UnitType end
for r in GameInfo.Buildings() do hashName[r.Hash] = r.BuildingType end
for r in GameInfo.Districts() do hashName[r.Hash] = r.DistrictType end
for r in GameInfo.Projects() do hashName[r.Hash] = r.ProjectType end

S.meta = try('meta', function()
  local m = {
    turn = Game.GetCurrentGameTurn(),
    localPlayer = me,
    mapWidth = select(1, Map.GetGridSize()),
    mapHeight = select(2, Map.GetGridSize()),
    plotCount = Map.GetPlotCount(),
  }
  -- The map wraps east-west on most map types; distances must wrap too.
  m.wrapX = try('meta.wrapX', function() return Map.IsWrapX() end)
  m.wrapY = try('meta.wrapY', function() return Map.IsWrapY() end)
  m.maxTurns = try('meta.maxTurns', function() return GameConfiguration.GetValue('GAME_MAX_TURNS') end)
  -- Live: Game.GetGameSpeedType does not exist in InGame; the shipped UI
  -- uses GameConfiguration.GetGameSpeedType(), which returns a hash.
  m.gameSpeed = try('meta.gameSpeed', function()
    local v = GameConfiguration.GetGameSpeedType()
    for r in GameInfo.GameSpeeds() do
      if r.Hash == v or r.Index == v then return r.GameSpeedType end
    end
    return v
  end)
  m.era = try('meta.era', function()
    local r = GameInfo.Eras[Game.GetEras():GetCurrentEra()]
    return r and r.EraType
  end)
  return m
end)

S.me = try('me', function()
  local cfg = PlayerConfigurations[me]
  local tr = pMe:GetTreasury()
  local te = pMe:GetTechs()
  local cu = pMe:GetCulture()
  local re = pMe:GetReligion()
  local o = {
    id = me,
    civ = cfg:GetCivilizationTypeName(),
    civName = L(cfg:GetCivilizationShortDescription()),
    leader = cfg:GetLeaderTypeName(),
    leaderName = L(cfg:GetLeaderName()),
    score = pMe:GetScore(),
    gold = tr:GetGoldBalance(),
    goldYield = tr:GetGoldYield(),
    goldMaintenance = tr:GetTotalMaintenance(),
    goldPerTurn = tr:GetGoldYield() - tr:GetTotalMaintenance(),
    science = te:GetScienceYield(),
    culture = cu:GetCultureYield(),
    faith = re:GetFaithBalance(),
    faithYield = re:GetFaithYield(),
  }
  o.favor = try('me.favor', function() return pMe:GetFavor() end)
  o.favorPerTurn = try('me.favorPerTurn', function() return pMe:GetFavorPerTurn() end)
  o.tourism = try('me.tourism', function() return pMe:GetStats():GetTourism() end)
  o.militaryStrength = try('me.military', function() return pMe:GetStats():GetMilitaryStrengthWithoutTreasury() end)
  o.eraScore = try('me.eraScore', function() return Game.GetEras():GetPlayerCurrentScore(me) end)
  o.darkAgeThreshold = try('me.darkAge', function() return Game.GetEras():GetPlayerDarkAgeThreshold(me) end)
  o.goldenAgeThreshold = try('me.goldenAge', function() return Game.GetEras():GetPlayerGoldenAgeThreshold(me) end)
  o.government = try('me.government', function()
    local g = cu:GetCurrentGovernment()
    return g >= 0 and GameInfo.Governments[g].GovernmentType or nil
  end)
  o.policies = try('me.policies', function()
    local out = {}
    for i = 0, cu:GetNumPolicySlots() - 1 do
      local p = cu:GetSlotPolicy(i)
      local st = GameInfo.GovernmentSlots[cu:GetSlotType(i)]
      out[#out + 1] = { slot = i, slotType = st and st.GovernmentSlotType, policy = (p >= 0 and GameInfo.Policies[p].PolicyType) or nil }
    end
    return out
  end)
  o.religion = try('me.religion', function()
    local r = re:GetReligionTypeCreated()
    return r >= 0 and GameInfo.Religions[r].ReligionType or nil
  end)
  local t = te:GetResearchingTech()
  if t >= 0 then
    o.researching = { type = GameInfo.Technologies[t].TechnologyType, turns = te:GetTurnsToResearch(t),
      progress = te:GetResearchProgress(t), cost = te:GetResearchCost(t) }
  end
  local c = cu:GetProgressingCivic()
  if c >= 0 then
    o.civic = { type = GameInfo.Civics[c].CivicType, turns = try('me.civicTurns', function() return cu:GetTurnsLeft() end),
      progress = try('me.civicProgress', function() return cu:GetCulturalProgress(c) end),
      cost = try('me.civicCost', function() return cu:GetCultureCost(c) end) }
  end
  return o
end)

S.techs = try('techs', function()
  local te = pMe:GetTechs()
  local done, avail = {}, {}
  for r in GameInfo.Technologies() do
    if te:HasTech(r.Index) then done[#done + 1] = r.TechnologyType
    elseif te:CanResearch(r.Index) then
      avail[#avail + 1] = { type = r.TechnologyType, era = r.EraType, cost = te:GetResearchCost(r.Index),
        progress = te:GetResearchProgress(r.Index), turns = te:GetTurnsToResearch(r.Index),
        boosted = te:HasBoostBeenTriggered(r.Index) }
    end
  end
  return { researched = done, available = avail }
end)

S.civics = try('civics', function()
  local cu = pMe:GetCulture()
  local done, avail = {}, {}
  for r in GameInfo.Civics() do
    if cu:HasCivic(r.Index) then done[#done + 1] = r.CivicType
    elseif cu:CanProgress(r.Index) then
      avail[#avail + 1] = { type = r.CivicType, era = r.EraType,
        cost = try('civic.cost', function() return cu:GetCultureCost(r.Index) end),
        progress = try('civic.progress', function() return cu:GetCulturalProgress(r.Index) end),
        boosted = try('civic.boost', function() return cu:HasBoostBeenTriggered(r.Index) end) }
    end
  end
  return { completed = done, available = avail }
end)

local function cityRecord(c)
  local o = { id = c:GetID(), name = L(c:GetName()), x = c:GetX(), y = c:GetY(),
    population = c:GetPopulation(), capital = c:IsCapital(), yields = {} }
  for i, y in ipairs(YIELDS) do o.yields[y] = c:GetYield(i - 1) end
  local g = c:GetGrowth()
  o.housing = try('city.housing', function() return g:GetHousing() end)
  o.amenities = try('city.amenities', function() return g:GetAmenities() end)
  o.amenitiesNeeded = try('city.amenitiesNeeded', function() return g:GetAmenitiesNeeded() end)
  o.turnsToGrow = try('city.growth', function() return g:GetTurnsUntilGrowth() end)
  o.foodSurplus = try('city.food', function() return g:GetFoodSurplus() end)
  o.loyalty = try('city.loyalty', function()
    local ci = c:GetCulturalIdentity()
    return { value = ci:GetLoyalty(), max = ci:GetMaxLoyalty(), perTurn = ci:GetLoyaltyPerTurn() }
  end)
  local bq = c:GetBuildQueue()
  o.production = try('city.production', function()
    if bq:GetSize() == 0 then return { item = nil, queueSize = 0 } end
    local h = bq:GetCurrentProductionTypeHash()
    return { item = hashName[h], turnsLeft = bq:GetTurnsLeft(), queueSize = bq:GetSize() }
  end)
  o.districts = try('city.districts', function()
    local out = {}
    for _, d in c:GetDistricts():Members() do
      local r = GameInfo.Districts[d:GetType()]
      out[#out + 1] = { type = r and r.DistrictType, x = d:GetX(), y = d:GetY(), pillaged = d:IsPillaged(), complete = d:IsComplete() }
    end
    return out
  end)
  o.buildings = try('city.buildings', function()
    local out = {}
    local b = c:GetBuildings()
    for r in GameInfo.Buildings() do
      if b:HasBuilding(r.Index) then out[#out + 1] = r.BuildingType end
    end
    return out
  end)
  if P.includeBuildable then
    o.canProduce = try('city.canProduce', function()
      local out = {}
      local function scan(iter, key)
        for r in iter() do
          if bq:CanProduce(r.Hash, true) then
            out[#out + 1] = { type = r[key], turns = bq:GetTurnsLeft(r.Hash) }
          end
        end
      end
      scan(GameInfo.Units, 'UnitType')
      scan(GameInfo.Buildings, 'BuildingType')
      scan(GameInfo.Districts, 'DistrictType')
      scan(GameInfo.Projects, 'ProjectType')
      return out
    end)
  end
  return o
end

S.cities = try('cities', function()
  local out = {}
  for _, c in pMe:GetCities():Members() do out[#out + 1] = cityRecord(c) end
  return out
end)

-- UnitManager.GetActivityType returns a value of the ActivityTypes enum;
-- name it by reverse lookup (there is no GameInfo table for activities).
local activityNames = {}
pcall(function() for k, v in pairs(ActivityTypes) do activityNames[v] = k end end)
local function activityName(a) return activityNames[a] or a end

S.units = try('units', function()
  local out = {}
  for _, u in pMe:GetUnits():Members() do
    if u:GetX() >= 0 then
      local r = GameInfo.Units[u:GetType()]
      local o = { id = u:GetID(), type = r and r.UnitType, name = L(u:GetName()), x = u:GetX(), y = u:GetY(),
        hp = u:GetMaxDamage() - u:GetDamage(), maxHp = u:GetMaxDamage(),
        moves = u:GetMovesRemaining(), maxMoves = u:GetMaxMoves(),
        combat = r and r.Combat, ranged = r and r.RangedCombat, range = r and r.Range,
        formationClass = r and r.FormationClass }
      o.charges = try('unit.charges', function() return u:GetBuildCharges() end)
      o.xp = try('unit.xp', function() return u:GetExperience():GetExperiencePoints() end)
      o.level = try('unit.level', function() return u:GetExperience():GetLevel() end)
      o.activity = try('unit.activity', function() return activityName(UnitManager.GetActivityType(u)) end)
      -- The game's own "needs orders" test (UnitFlagManager.lua dims units with it).
      o.ready = try('unit.ready', function() return u:IsReadyToSelect() end)
      out[#out + 1] = o
    end
  end
  return out
end)

S.players = try('players', function()
  local out = {}
  local dip = pMe:GetDiplomacy()
  for i = 0, 63 do
    local p = Players[i]
    if p and i ~= me and p:IsAlive() and (p:IsMajor() or (p.IsMinor and p:IsMinor())) and dip:HasMet(i) then
      local cfg = PlayerConfigurations[i]
      local o = { id = i, major = p:IsMajor(), civ = cfg:GetCivilizationTypeName(),
        civName = L(cfg:GetCivilizationShortDescription()), leader = cfg:GetLeaderTypeName(),
        atWar = dip:IsAtWarWith(i), score = p:GetScore() }
      o.cities = try('players.cities', function() return p:GetCities():GetCount() end)
      o.militaryStrength = try('players.military', function() return p:GetStats():GetMilitaryStrengthWithoutTreasury() end)
      if p:IsMajor() then
        o.diplomaticState = try('players.diploState', function()
          local s = p:GetDiplomaticAI():GetDiplomaticStateIndex(me)
          local r = GameInfo.DiplomaticStates[s]
          return r and r.StateType or s
        end)
        o.techs = try('players.techs', function()
          local n = 0
          local te = p:GetTechs()
          for r in GameInfo.Technologies() do if te:HasTech(r.Index) then n = n + 1 end end
          return n
        end)
      else
        o.suzerain = try('players.suzerain', function() return p:GetInfluence():GetSuzerain() end)
        o.myEnvoys = try('players.envoys', function() return p:GetInfluence():GetTokensReceived(me) end)
      end
      out[#out + 1] = o
    end
  end
  return out
end)

-- Foreign units the local player can currently see, near anything we own.
S.visibleForeignUnits = try('visibleForeignUnits', function()
  local vis = PlayersVisibility[me]
  local radius = P.foreignRadius or 6
  local anchors = {}
  for _, c in pMe:GetCities():Members() do anchors[#anchors + 1] = { c:GetX(), c:GetY() } end
  for _, u in pMe:GetUnits():Members() do if u:GetX() >= 0 then anchors[#anchors + 1] = { u:GetX(), u:GetY() } end end
  local out = {}
  for i = 0, 63 do
    local p = Players[i]
    if p and i ~= me and p:IsAlive() then
      for _, u in p:GetUnits():Members() do
        local x, y = u:GetX(), u:GetY()
        if x >= 0 and vis:IsVisible(x, y) then
          local near = 999
          for _, a in ipairs(anchors) do
            local d = Map.GetPlotDistance(x, y, a[1], a[2])
            if d < near then near = d end
          end
          if near <= radius then
            local r = GameInfo.Units[u:GetType()]
            out[#out + 1] = { owner = i, id = u:GetID(), type = r and r.UnitType, x = x, y = y,
              hp = u:GetMaxDamage() - u:GetDamage(), combat = r and r.Combat, ranged = r and r.RangedCombat,
              distanceToNearestOwned = near, barbarian = p:IsBarbarian() }
          end
        end
      end
    end
  end
  return out
end)

S.resources = try('resources', function()
  local res = pMe:GetResources()
  local out = {}
  for r in GameInfo.Resources() do
    if r.ResourceClassType == 'RESOURCECLASS_STRATEGIC' or r.ResourceClassType == 'RESOURCECLASS_LUXURY' then
      local n = res:GetResourceAmount(r.Index)
      if n and n > 0 then
        local o = { type = r.ResourceType, class = r.ResourceClassType, amount = n }
        if r.ResourceClassType == 'RESOURCECLASS_STRATEGIC' then
          o.cap = try('resources.cap', function() return res:GetResourceStockpileCap(r.Index) end)
        end
        out[#out + 1] = o
      end
    end
  end
  return out
end)

S.exploration = try('exploration', function()
  local vis = PlayersVisibility[me]
  local land, revealed = 0, 0
  for i = 0, Map.GetPlotCount() - 1 do
    local p = Map.GetPlotByIndex(i)
    if not p:IsWater() then
      land = land + 1
      if vis:IsRevealed(p:GetX(), p:GetY()) then revealed = revealed + 1 end
    end
  end
  return { landPlots = land, revealedLand = revealed }
end)

emitJson(S)
