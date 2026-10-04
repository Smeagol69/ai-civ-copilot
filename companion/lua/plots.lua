-- Tiles around a point, as the local player can see them.
-- Params: P.x, P.y, P.radius (<= 6), P.revealAll (bool: ignore fog)

local me = Game.GetLocalPlayer()
local vis = PlayersVisibility[me]
local r = math.min(P.radius or 2, 6)
local out = {}
for dy = -r, r do
  for dx = -r, r do
    local x, y = P.x + dx, P.y + dy
    local p = Map.GetPlot(x, y)
    if p and Map.GetPlotDistance(P.x, P.y, x, y) <= r then
      local revealed = vis:IsRevealed(x, y)
      if revealed or P.revealAll then
        local t = { x = x, y = y, visible = vis:IsVisible(x, y), revealed = revealed }
        local tr = GameInfo.Terrains[p:GetTerrainType()]
        t.terrain = tr and tr.TerrainType
        local f = p:GetFeatureType()
        if f >= 0 then t.feature = GameInfo.Features[f].FeatureType end
        local res = p:GetResourceType()
        if res >= 0 then t.resource = GameInfo.Resources[res].ResourceType end
        local imp = p:GetImprovementType()
        if imp >= 0 then t.improvement = GameInfo.Improvements[imp].ImprovementType end
        local d = p:GetDistrictType()
        if d >= 0 then t.district = GameInfo.Districts[d].DistrictType end
        t.owner = p:GetOwner()
        t.water = p:IsWater()
        t.hills = try('plot.hills', function() return p:IsHills() end)
        t.river = try('plot.river', function() return p:IsRiver() end)
        t.appeal = try('plot.appeal', function() return p:GetAppeal() end)
        t.yields = {}
        for i, yn in ipairs(YIELDS) do t.yields[yn] = p:GetYield(i - 1) end
        if t.visible then
          local units = {}
          local us = Map.GetUnitsAt(x, y)
          if us then
            for u in us:Units() do
              local ur = GameInfo.Units[u:GetType()]
              units[#units + 1] = { owner = u:GetOwner(), id = u:GetID(), type = ur and ur.UnitType }
            end
          end
          if #units > 0 then t.units = units end
        end
        out[#out + 1] = t
      end
    end
  end
end
emitJson({ center = { P.x, P.y }, radius = r, tiles = out, gaps = __gaps })
