-- Full API surface scan for one Lua state. Lists every global and, for the
-- game's object types, the methods reachable from a live sample object.
-- The result is the capability catalog the copilot searches before it
-- writes new Lua: real names from the running game, not recollection.

local function methodsOf(v)
  local names, seen = {}, {}
  local function collect(t)
    if type(t) ~= 'table' then return end
    for k, val in pairs(t) do
      local key = tostring(k)
      if type(val) == 'function' and not seen[key] then seen[key] = true; names[#names + 1] = key end
    end
  end
  if type(v) == 'table' then pcall(collect, v) end
  local mt = nil
  pcall(function() mt = getmetatable(v) end)
  local depth = 0
  while type(mt) == 'table' and depth < 6 do
    depth = depth + 1
    pcall(collect, mt)
    local idx = rawget(mt, '__index')
    if type(idx) == 'table' then
      pcall(collect, idx)
      local nmt = nil
      pcall(function() nmt = getmetatable(idx) end)
      mt = nmt
    else
      mt = nil
    end
  end
  table.sort(names)
  return names
end

local R = { globals = {}, objects = {}, enums = {} }

-- Globals: tables get their function members listed; enum-like tables
-- (all number values) are listed as enums with their values.
for k, v in pairs(_G) do
  local key = tostring(k)
  local tv = type(v)
  if tv == 'function' then
    R.globals[key] = 'function'
  elseif tv == 'table' and key ~= '_G' and key ~= 'GameInfo' and key ~= 'Controls' and key ~= 'ExposedMembers' then
    local fns, nums, other = {}, {}, 0
    pcall(function()
      for k2, v2 in pairs(v) do
        if type(v2) == 'function' then fns[#fns + 1] = tostring(k2)
        elseif type(v2) == 'number' then nums[tostring(k2)] = v2
        else other = other + 1 end
      end
    end)
    table.sort(fns)
    if #fns > 0 then R.globals[key] = fns
    elseif next(nums) ~= nil and other == 0 then R.enums[key] = nums
    else R.globals[key] = tv end
  else
    R.globals[key] = tv
  end
end

-- Sample objects reachable from the local player.
local me = Game and Game.GetLocalPlayer and Game.GetLocalPlayer()
local function sample(name, getter)
  local ok, obj = pcall(getter)
  if ok and obj ~= nil then R.objects[name] = methodsOf(obj) end
end
if me and me >= 0 and Players then
  local p = Players[me]
  sample('Player', function() return p end)
  for _, acc in ipairs({ 'GetTechs', 'GetCulture', 'GetTreasury', 'GetReligion', 'GetDiplomacy', 'GetCities',
      'GetUnits', 'GetResources', 'GetStats', 'GetInfluence', 'GetGreatPeoplePoints', 'GetTrade', 'GetDiplomaticAI',
      'GetAi_Military', 'GetEspionage', 'GetGovernors', 'GetCongress', 'GetIdentity', 'GetProps' }) do
    sample('Player:' .. acc, function() return p[acc](p) end)
  end
  local city = nil
  pcall(function() for _, c in p:GetCities():Members() do city = c; break end end)
  if city then
    sample('City', function() return city end)
    for _, acc in ipairs({ 'GetBuildQueue', 'GetGrowth', 'GetBuildings', 'GetDistricts', 'GetCulturalIdentity',
        'GetGold', 'GetReligion', 'GetTrade', 'GetCityCitizens', 'GetOwnedPlots', 'GetPlot' }) do
      sample('City:' .. acc, function() return city[acc](city) end)
    end
    pcall(function()
      for _, d in city:GetDistricts():Members() do sample('District', function() return d end); break end
    end)
  end
  local unit = nil
  pcall(function() for _, u in p:GetUnits():Members() do unit = u; break end end)
  if unit then
    sample('Unit', function() return unit end)
    for _, acc in ipairs({ 'GetExperience', 'GetGreatPerson', 'GetAbility', 'GetPlot' }) do
      sample('Unit:' .. acc, function() return unit[acc](unit) end)
    end
  end
  sample('Plot', function() return Map.GetPlotByIndex(0) end)
  sample('PlayerVisibility', function() return PlayersVisibility[me] end)
  sample('PlayerConfiguration', function() return PlayerConfigurations[me] end)
  sample('Eras', function() return Game.GetEras() end)
end

-- GameInfo tables (the full database: units, buildings, techs, modifiers...).
pcall(function()
  local tables = {}
  for k, _ in pairs(GameInfo) do tables[#tables + 1] = tostring(k) end
  table.sort(tables)
  R.gameInfoTables = tables
end)

emitJson(R)
