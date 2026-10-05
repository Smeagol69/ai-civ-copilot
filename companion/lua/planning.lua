-- Planning inputs the game tracks but rarely shows in one place. Runs in
-- InGame. Call shapes from Firaxis' screens:
--   techs:HasTech(i) / HasBoostBeenTriggered(i) / CanTriggerBoost(i) / CanResearch(i)   (TechBoostsPanel, TechTree)
--   culture:HasCivic(i) / HasBoostBeenTriggered(i) / CanTriggerBoost(i)               (CivicBoostsPanel)
--   GameInfo.Boosts: TechnologyType / CivicType, TriggerDescription, Boost (percent)
--   Game.GetGreatPeople():GetTimeline() {Individual, Class, Cost, Claimant, Era}; CanRecruitPerson,
--     GetPatronizeCost(me, individual, YieldTypes.GOLD/FAITH); player:GetGreatPeoplePoints():GetPointsTotal/
--     GetPointsPerTurn(classID)                                                         (GreatPeoplePopup)
--   player:GetInfluence(): GetTokensToGive(), GetPointsPerTurn(); minor:GetInfluence():GetSuzerain(),
--     GetTokensReceived(id)                                                             (CityStates)
--   DealManager.GetPlayerDeals(me, other), deal:Items(), item:GetEnactedTurn()/GetDuration() (ReportScreen)
-- P.what: list of "boosts", "greatpeople", "envoys", "deals" (default all).

local me = Game.GetLocalPlayer()
local pMe = Players[me]
local dip = pMe:GetDiplomacy()
local turn = Game.GetCurrentGameTurn()
local want = {}
for _, w in ipairs(P.what or { 'boosts', 'greatpeople', 'envoys', 'deals' }) do want[w] = true end
local out = { turn = turn }

local function civName(id)
  return try('civ', function() return L(PlayerConfigurations[id]:GetCivilizationShortDescription()) end) or ('player ' .. id)
end

if want.boosts then
  out.boosts = try('boosts', function()
    local techs, culture = pMe:GetTechs(), pMe:GetCulture()
    local list = { techs = {}, civics = {} }
    for b in GameInfo.Boosts() do
      if b.TechnologyType then
        local t = GameInfo.Technologies[b.TechnologyType]
        if t and not techs:HasTech(t.Index) and not techs:HasBoostBeenTriggered(t.Index) and techs:CanTriggerBoost(t.Index) then
          list.techs[#list.techs + 1] = { type = t.TechnologyType, name = L(t.Name), how = b.TriggerDescription and L(b.TriggerDescription) or nil,
            percent = b.Boost, available = techs:CanResearch(t.Index), cost = t.Cost }
        end
      elseif b.CivicType then
        local c = GameInfo.Civics[b.CivicType]
        if c and not culture:HasCivic(c.Index) and not culture:HasBoostBeenTriggered(c.Index) and culture:CanTriggerBoost(c.Index) then
          list.civics[#list.civics + 1] = { type = c.CivicType, name = L(c.Name), how = b.TriggerDescription and L(b.TriggerDescription) or nil,
            percent = b.Boost, available = culture:CanProgress(c.Index), cost = c.Cost }
        end
      end
    end
    -- Cheapest first: those are the next ones the player will reach.
    table.sort(list.techs, function(a, b) return (a.cost or 0) < (b.cost or 0) end)
    table.sort(list.civics, function(a, b) return (a.cost or 0) < (b.cost or 0) end)
    return list
  end)
end

if want.greatpeople then
  out.greatPeople = try('greatpeople', function()
    local gp = Game.GetGreatPeople()
    local pts = pMe:GetGreatPeoplePoints()
    local list = {}
    for _, e in ipairs(gp:GetTimeline() or {}) do
      local cls = e.Class and GameInfo.GreatPersonClasses[e.Class]
      local ind = e.Individual and GameInfo.GreatPersonIndividuals[e.Individual]
      local g = { class = cls and cls.GreatPersonClassType, person = ind and L(ind.Name), cost = e.Cost,
        claimedBy = e.Claimant and civName(e.Claimant) or nil,
        does = (e.ActionEffectText and e.ActionEffectText ~= '' and L(e.ActionEffectText)) or (e.PassiveEffectText and L(e.PassiveEffectText)) or nil }
      if cls then
        g.myPoints = pts:GetPointsTotal(cls.Index)
        g.myPointsPerTurn = pts:GetPointsPerTurn(cls.Index)
      end
      if e.Individual ~= nil and e.Claimant == nil then
        g.canRecruit = gp:CanRecruitPerson(me, e.Individual)
        -- The engine reports 2147483647 when a person cannot be bought.
        local gold = gp:GetPatronizeCost(me, e.Individual, YieldTypes.GOLD)
        local faith = gp:GetPatronizeCost(me, e.Individual, YieldTypes.FAITH)
        if gold and gold < 2147483647 then g.goldCost = gold end
        if faith and faith < 2147483647 then g.faithCost = faith end
      end
      list[#list + 1] = g
    end
    return list
  end)
end

if want.envoys then
  out.envoys = try('envoys', function()
    local inf = pMe:GetInfluence()
    local r = { toGive = inf:GetTokensToGive(), pointsPerTurn = inf:GetPointsPerTurn(), cityStates = {} }
    for i = 0, 63 do
      local p = Players[i]
      if p and p:IsAlive() and p:IsMinor() and not p:IsBarbarian() and not p:IsFreeCities() and dip:HasMet(i) then
        local mi = p:GetInfluence()
        local suz = mi:GetSuzerain()
        r.cityStates[#r.cityStates + 1] = { id = i, name = civName(i), myEnvoys = mi:GetTokensReceived(me),
          suzerain = (suz ~= nil and suz >= 0) and civName(suz) or nil, iAmSuzerain = (suz == me) }
      end
    end
    return r
  end)
end

if want.deals then
  out.deals = try('deals', function()
    local list = {}
    for i = 0, 63 do
      local p = Players[i]
      if p and i ~= me and p:IsAlive() and p:IsMajor() and dip:HasMet(i) then
        for _, pDeal in ipairs(DealManager.GetPlayerDeals(me, i) or {}) do
          for item in pDeal:Items() do
            local t = item:GetType()
            local what
            if t == DealItemTypes.GOLD then
              what = item:GetAmount() .. ' gold' .. ((item:GetDuration() > 0) and '/turn' or '')
            elseif t == DealItemTypes.RESOURCES then
              local r = GameInfo.Resources[item:GetValueType()]
              what = item:GetAmount() .. ' ' .. (r and L(r.Name) or 'resource')
            else
              local nameId = item:GetValueTypeNameID()
              what = (nameId and L(nameId)) or ('deal item type ' .. tostring(t))
            end
            local d = item:GetDuration()
            list[#list + 1] = { with = civName(i), what = what, from = (item:GetFromPlayerID() == me) and 'you' or civName(i),
              turnsLeft = (d > 0) and (d - (turn - item:GetEnactedTurn())) or nil }
          end
        end
      end
    end
    return list
  end)
end

out.gaps = __gaps
emitJson(out)
