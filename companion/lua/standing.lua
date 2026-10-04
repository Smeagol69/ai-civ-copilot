-- Where every known civilization stands on each road to victory.
-- Runs in InGame. Call shapes come from Firaxis' WorldRankings screens:
--   Game.IsVictoryEnabled(type), Game.GetVictoryProgressForTeam(type, team)
--   p:GetStats():GetNumTechsResearched() / GetTourism() / GetDiplomaticVictoryPoints()
--   p:GetCulture():GetTouristsTo() / GetStaycationers()
--   p:GetReligion():GetReligionInMajorityOfCities()
--   city:IsOriginalCapital(), city:GetOriginalOwner()
-- Every read is try()'d: a missing ruleset feature leaves a named gap.

local me = Game.GetLocalPlayer()
local dip = Players[me]:GetDiplomacy()
local out = { turn = Game.GetCurrentGameTurn(), me = me, victories = {}, players = {} }

for r in GameInfo.Victories() do
  local on = try('victory.enabled', function() return Game.IsVictoryEnabled(r.VictoryType) end)
  if on then out.victories[#out.victories + 1] = r.VictoryType end
end

local majors = 0
for i = 0, 63 do
  local p = Players[i]
  if p and p:IsAlive() and p:IsMajor() then
    majors = majors + 1
    local known = (i == me) or dip:HasMet(i)
    local cfg = PlayerConfigurations[i]
    local o = { id = i, me = (i == me), known = known }
    if known then
      o.civ = L(cfg:GetCivilizationShortDescription())
      o.score = try('score', function() return p:GetScore() end)
      o.cities = try('cities', function() return p:GetCities():GetCount() end)
      o.techs = try('techs', function() return p:GetStats():GetNumTechsResearched() end)
      o.civics = try('civics', function()
        local n, cu = 0, p:GetCulture()
        for c in GameInfo.Civics() do if cu:HasCivic(c.Index) then n = n + 1 end end
        return n
      end)
      o.science = try('science', function() return p:GetTechs():GetScienceYield() end)
      o.culture = try('culture', function() return p:GetCulture():GetCultureYield() end)
      o.tourism = try('tourism', function() return p:GetStats():GetTourism() end)
      o.touristsTo = try('touristsTo', function() return p:GetCulture():GetTouristsTo() end)
      o.staycationers = try('staycationers', function() return p:GetCulture():GetStaycationers() end)
      o.diploPoints = try('diploPoints', function() return p:GetStats():GetDiplomaticVictoryPoints() end)
      o.military = try('military', function() return p:GetStats():GetMilitaryStrengthWithoutTreasury() end)
      o.faith = try('faith', function() return p:GetReligion():GetFaithYield() end)
      o.religion = try('religion', function()
        local rel = p:GetReligion():GetReligionTypeCreated()
        return rel >= 0 and GameInfo.Religions[rel].ReligionType or nil
      end)
      o.majorityReligion = try('majorityReligion', function()
        local rel = p:GetReligion():GetReligionInMajorityOfCities()
        return rel >= 0 and GameInfo.Religions[rel].ReligionType or nil
      end)
      o.capitalsHeld = try('capitals', function()
        local n = 0
        for _, c in p:GetCities():Members() do
          if c:IsOriginalCapital() and c:GetOriginalOwner() ~= i then n = n + 1 end
        end
        return n
      end)
      o.progress = {}
      for _, v in ipairs(out.victories) do
        o.progress[v] = try('progress.' .. v, function() return Game.GetVictoryProgressForTeam(v, p:GetTeam()) end)
      end
    end
    out.players[#out.players + 1] = o
  end
end
out.majorsAlive = majors
out.gaps = __gaps
emitJson(out)
