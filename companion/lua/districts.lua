-- Where a city can place a district, and the adjacency bonus on each spot -
-- the numbers the district placement lens shows. Runs in InGame. Call shapes
-- from AdjacencyBonusSupport.lua:
--   CityManager.GetOperationTargets(pCity, CityOperationTypes.BUILD,
--     { [CityOperationTypes.PARAM_DISTRICT_TYPE] = district.Hash })[CityOperationResults.PLOTS]
--   plot:GetAdjacencyYield(me, cityID, eDistrict, yieldIndex)
--   plot:GetAdjacencyBonusTooltip(me, cityID, eDistrict, yieldIndex)
-- P.cityId: a city of the local player. P.districts: list of DISTRICT_* types
-- (default: every district the city can place now). P.top: spots per district (default 3).

local me = Game.GetLocalPlayer()
local pCity = CityManager.GetCity(me, P.cityId)
if pCity == nil then emitJson({ error = 'no city ' .. tostring(P.cityId) .. ' of the local player' }) return end

local out = { city = L(pCity:GetName()), cityId = pCity:GetID(), districts = {} }
local wanted = nil
if P.districts then
  wanted = {}
  for _, d in ipairs(P.districts) do wanted[d] = true end
end
local yields = {}
for y in GameInfo.Yields() do yields[#yields + 1] = y end

for d in GameInfo.Districts() do
  if (wanted == nil or wanted[d.DistrictType]) and d.DistrictType ~= 'DISTRICT_CITY_CENTER' and d.DistrictType ~= 'DISTRICT_WONDER' then
    local entry = try('district.' .. d.DistrictType, function()
      local params = {}
      params[CityOperationTypes.PARAM_DISTRICT_TYPE] = d.Hash
      local res = CityManager.GetOperationTargets(pCity, CityOperationTypes.BUILD, params)
      local plots = res and res[CityOperationResults.PLOTS]
      if plots == nil or #plots == 0 then return nil end
      local spots = {}
      for _, plotId in ipairs(plots) do
        local plot = Map.GetPlotByIndex(plotId)
        local spot = { x = plot:GetX(), y = plot:GetY(), total = 0, bonus = {} }
        for _, y in ipairs(yields) do
          local n = plot:GetAdjacencyYield(me, pCity:GetID(), d.Index, y.Index)
          if n and n > 0 then
            spot.bonus[y.YieldType] = n
            spot.total = spot.total + n
          end
        end
        spots[#spots + 1] = spot
      end
      table.sort(spots, function(a, b) return a.total > b.total end)
      local top = {}
      for i = 1, math.min(P.top or 3, #spots) do
        local s = spots[i]
        s.why = try('tooltip', function()
          local parts = {}
          for yt, _ in pairs(s.bonus) do
            local tip = Map.GetPlot(s.x, s.y):GetAdjacencyBonusTooltip(me, pCity:GetID(), d.Index, GameInfo.Yields[yt].Index)
            if tip and tip ~= '' then parts[#parts + 1] = L(tip) end
          end
          return table.concat(parts, ' ')
        end)
        top[#top + 1] = s
      end
      return { type = d.DistrictType, name = L(d.Name), spots = #spots, best = top }
    end)
    if entry then out.districts[#out.districts + 1] = entry end
  end
end
table.sort(out.districts, function(a, b) return ((a.best[1] and a.best[1].total) or 0) > ((b.best[1] and b.best[1].total) or 0) end)
out.gaps = __gaps
emitJson(out)
