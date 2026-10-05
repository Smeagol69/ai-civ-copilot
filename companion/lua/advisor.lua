-- The game's own advisor: what Firaxis' Grand Strategic AI recommends for
-- the local player. Runs in InGame. Call shapes are the shipped screens':
--   p:GetGrandStrategicAI():GetTechRecommendations()       {TechHash, TechScore}     (TechTree)
--   p:GetGrandStrategicAI():GetCivicsRecommendations()     {CivicHash, CivicScore}   (CivicsTree)
--   p:GetGrandStrategicAI():GetSettlementRecommendations(n) {SettlingLocation, NumReasons,
--       SettleTitle<i>, SettleExplanation<i>, SettlePositive<i>, SettlingTooltip} (WorldViewIconsManager)
--   city:GetCityAI():GetBuildRecommendations()             {BuildItemHash, BuildItemScore} (ProductionPanel)
--   Cities.GetPlotPurchaseCity(plotIndex):GetCityAI():GetImprovementRecommendationsForBuilder(
--       unit:GetComponentID())                              {ImprovementLocation, ImprovementHash} (WorldViewIconsManager)
-- P.what: list of "tech", "civic", "settle", "build", "builder" (default all).
-- P.settleCount: how many city sites (default 5, the game's own number).

local me = Game.GetLocalPlayer()
local pMe = Players[me]
local want = {}
for _, w in ipairs(P.what or { 'tech', 'civic', 'settle', 'build', 'builder' }) do want[w] = true end
local out = { turn = Game.GetCurrentGameTurn() }
local gsai = try('grandai', function() return pMe:GetGrandStrategicAI() end)

local function byHash(tbl, key, hash)
  local row = GameInfo[tbl][hash]
  if row then return row[key], L(row.Name) end
  return nil, nil
end

-- Anything a city can build, from its hash.
local BUILD_TABLES = { { 'Units', 'UnitType' }, { 'Buildings', 'BuildingType' }, { 'Districts', 'DistrictType' }, { 'Projects', 'ProjectType' } }
local function buildItem(hash)
  for _, t in ipairs(BUILD_TABLES) do
    local row = GameInfo[t[1]][hash]
    if row then return row[t[2]], L(row.Name) end
  end
  return nil, nil
end

if gsai and want.tech then
  out.techs = try('tech', function()
    local list = {}
    for _, r in pairs(gsai:GetTechRecommendations() or {}) do
      local type, name = byHash('Technologies', 'TechnologyType', r.TechHash)
      list[#list + 1] = { type = type, name = name, score = r.TechScore }
    end
    table.sort(list, function(a, b) return (a.score or 0) > (b.score or 0) end)
    return list
  end)
end

if gsai and want.civic then
  out.civics = try('civic', function()
    local list = {}
    for _, r in pairs(gsai:GetCivicsRecommendations() or {}) do
      local type, name = byHash('Civics', 'CivicType', r.CivicHash)
      list[#list + 1] = { type = type, name = name, score = r.CivicScore }
    end
    table.sort(list, function(a, b) return (a.score or 0) > (b.score or 0) end)
    return list
  end)
end

if gsai and want.settle then
  out.settle = try('settle', function()
    local list = {}
    for _, r in pairs(gsai:GetSettlementRecommendations(P.settleCount or 5) or {}) do
      local plot = Map.GetPlotByIndex(r.SettlingLocation)
      local site = { x = plot and plot:GetX(), y = plot and plot:GetY(), pros = {}, cons = {} }
      if r.SettlingTooltip then site.tooltip = L(r.SettlingTooltip) end
      for i = 0, (r.NumReasons or 0) - 1 do
        local title = r['SettleTitle' .. tostring(i)]
        local details = r['SettleExplanation' .. tostring(i)]
        local text = (title and L(title) or '') .. ((details and details ~= '') and (': ' .. L(details)) or '')
        if r['SettlePositive' .. tostring(i)] == false then site.cons[#site.cons + 1] = text else site.pros[#site.pros + 1] = text end
      end
      list[#list + 1] = site
    end
    return list
  end)
end

if want.build then
  out.cities = {}
  for _, city in pMe:GetCities():Members() do
    local c = { id = city:GetID(), name = L(city:GetName()) }
    c.recommended = try('build', function()
      local list = {}
      for _, r in ipairs(city:GetCityAI():GetBuildRecommendations() or {}) do
        local type, name = buildItem(r.BuildItemHash)
        list[#list + 1] = { type = type, name = name, score = r.BuildItemScore }
      end
      return list
    end)
    out.cities[#out.cities + 1] = c
  end
end

if want.builder then
  out.builders = {}
  for _, unit in pMe:GetUnits():Members() do
    if unit:GetBuildCharges() > 0 then
      local b = { id = unit:GetID(), x = unit:GetX(), y = unit:GetY(), charges = unit:GetBuildCharges() }
      b.recommended = try('builder', function()
        local city = Cities.GetPlotPurchaseCity(Map.GetPlotIndex(unit:GetX(), unit:GetY()))
        if city == nil then return {} end
        b.city = L(city:GetName())
        local list = {}
        for _, r in pairs(city:GetCityAI():GetImprovementRecommendationsForBuilder(unit:GetComponentID()) or {}) do
          local plot = Map.GetPlotByIndex(r.ImprovementLocation)
          local type, name = byHash('Improvements', 'ImprovementType', r.ImprovementHash)
          list[#list + 1] = { type = type, name = name, x = plot and plot:GetX(), y = plot and plot:GetY() }
        end
        return list
      end)
      out.builders[#out.builders + 1] = b
    end
  end
end

out.gaps = __gaps
emitJson(out)
