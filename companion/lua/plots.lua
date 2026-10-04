-- Tiles around a point, as the local player can see them.
-- Params: P.x, P.y, P.radius (<= 6), P.revealAll (bool: ignore fog)
--
-- The disc is walked with Map.GetPlotXYWithRangeCheck, as Firaxis' scripts
-- do (MapUtilities.lua): it wraps x across the east-west seam and returns nil
-- past the poles, so no out-of-range coordinate ever reaches a native call.
-- Coordinates are always taken from the returned plot.

local me = Game.GetLocalPlayer()
local vis = PlayersVisibility[me]
local W, H = Map.GetGridSize()
if type(P.x) ~= 'number' or type(P.y) ~= 'number' or P.x ~= math.floor(P.x) or P.y ~= math.floor(P.y)
   or P.x < 0 or P.x >= W or P.y < 0 or P.y >= H then
  emitJson({ error = 'center is off the map', width = W, height = H })
  return
end
local r = math.max(0, math.min(math.floor(tonumber(P.radius) or 2), 6))
local out = {}
for dy = -r, r do
  for dx = -r, r do
    local p = Map.GetPlotXYWithRangeCheck(P.x, P.y, dx, dy, r)
    if p then
      local x, y = p:GetX(), p:GetY()
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
        -- InGame GetYield includes improvements and districts, as the tile
        -- tooltip shows (PlotToolTip.lua); GameCore's leaves them out.
        t.yields = {}
        for i, yn in ipairs(YIELDS) do t.yields[yn] = p:GetYield(i - 1) end
        if t.visible then
          -- Every layer (MapLayers.ANY): traders, religious units and spies
          -- are not on the default layer. Shipped shape: MapSearchPanel.lua.
          local units = {}
          local list = Units.GetUnitsInPlotLayerID(x, y, MapLayers.ANY)
          if list then
            for _, u in ipairs(list) do
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
