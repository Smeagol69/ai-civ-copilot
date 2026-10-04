-- Typed actions. The bridge calls one entry point per request:
--   emitJson(A[P.action](P))
-- PLAY actions run in InGame and go through the same request path as a
-- click (CityManager/UnitManager/UI.Request*), after the game's own
-- CanStart* check. The game validates them exactly as it validates input.
-- EDIT actions run in GameCore_Tuner and change the simulation directly;
-- each one returns before/after values read from the game itself.
-- VERIFY functions (verify_<action>) read the world back after a PLAY
-- request, because requests are processed asynchronously by the game.

local A = {}
local me = Game.GetLocalPlayer()

local function fail(reason, extra)
  local o = extra or {}
  o.ok = false
  o.reason = reason
  return o
end

local ITEM_TABLES = {
  { prefix = 'UNIT_', tbl = 'Units', key = 'UnitType', param = 'PARAM_UNIT_TYPE' },
  { prefix = 'BUILDING_', tbl = 'Buildings', key = 'BuildingType', param = 'PARAM_BUILDING_TYPE' },
  { prefix = 'DISTRICT_', tbl = 'Districts', key = 'DistrictType', param = 'PARAM_DISTRICT_TYPE' },
  { prefix = 'PROJECT_', tbl = 'Projects', key = 'ProjectType', param = 'PARAM_PROJECT_TYPE' },
}
local function resolveItem(typeName)
  for _, t in ipairs(ITEM_TABLES) do
    if string.sub(typeName, 1, string.len(t.prefix)) == t.prefix then
      local row = GameInfo[t.tbl][typeName]
      if row then return row, t end
    end
  end
  return nil, nil
end

local function playerId(P) return P.playerId or me end

-- GameCore lookups (edits). City IDs from the snapshot are the full IDs.
local function coreCity(P)
  local p = Players[playerId(P)]
  return p and p:GetCities():FindID(P.cityId)
end
local function coreUnit(P)
  local p = Players[playerId(P)]
  return p and p:GetUnits():FindID(P.unitId)
end
-- InGame lookups (play).
local function uiCity(P) return CityManager.GetCity(playerId(P), P.cityId) end
local function uiUnit(P) return UnitManager.GetUnit(playerId(P), P.unitId) end

local function failureReasons(results, key)
  local out = {}
  if type(results) == 'table' and key and results[key] then
    for _, r in pairs(results[key]) do out[#out + 1] = L(r) end
  end
  return out
end


-- Generic unit read-back: compare the unit before and after a request.
local activityNames = {}
pcall(function() for k, v in pairs(ActivityTypes) do activityNames[v] = k end end)
local function unitState(u)
  if not u then return { exists = false } end
  local a = UnitManager.GetActivityType(u)
  return { exists = true, x = u:GetX(), y = u:GetY(), moves = u:GetMovesRemaining(), damage = u:GetDamage(),
    activity = activityNames[a] or a }
end
local function unitChanged(b, a)
  if not b or not a then return a ~= nil end
  if b.exists ~= a.exists then return true end
  return b.x ~= a.x or b.y ~= a.y or b.moves ~= a.moves or b.damage ~= a.damage or b.activity ~= a.activity
end

------------------------------------------------------------------ PLAY
function A.set_production(P)
  local c = uiCity(P)
  if not c then return fail('city not found: ' .. tostring(P.cityId)) end
  local row, t = resolveItem(P.item)
  if not row then return fail('unknown item type: ' .. tostring(P.item)) end
  local params = {}
  params[CityOperationTypes[t.param]] = row.Hash
  if P.x and P.y then
    params[CityOperationTypes.PARAM_X] = P.x
    params[CityOperationTypes.PARAM_Y] = P.y
  end
  if P.append then
    params[CityOperationTypes.PARAM_INSERT_MODE] = CityOperationTypes.VALUE_APPEND
  else
    params[CityOperationTypes.PARAM_INSERT_MODE] = CityOperationTypes.VALUE_EXCLUSIVE
  end
  local can, results = CityManager.CanStartOperation(c, CityOperationTypes.BUILD, params, true)
  if not can then
    return fail('the game refused this build', { failureReasons = failureReasons(results, CityOperationResults.FAILURE_REASONS),
      needsPlacement = (t.tbl == 'Districts' or (t.tbl == 'Buildings' and row.IsWonder)) and not (P.x and P.y) })
  end
  CityManager.RequestOperation(c, CityOperationTypes.BUILD, params)
  return { ok = true, requested = true, item = P.item, turns = c:GetBuildQueue():GetTurnsLeft(row.Hash) }
end
function A.verify_set_production(P)
  local c = uiCity(P)
  if not c then return fail('city not found') end
  local bq = c:GetBuildQueue()
  local h = bq:GetSize() > 0 and bq:GetCurrentProductionTypeHash() or 0
  local current = nil
  local row = resolveItem(P.item)
  if row and row.Hash == h then current = P.item end
  local queued = false
  if row then
    for i = 0, bq:GetSize() - 1 do
      local e = bq:GetAt(i)
      if e and (e.UnitType == row.Index or e.BuildingType == row.Index or e.DistrictType == row.Index or e.ProjectType == row.Index) then queued = true end
    end
  end
  return { ok = (current ~= nil) or queued, currentMatches = current ~= nil, inQueue = queued, queueSize = bq:GetSize() }
end

function A.purchase(P)
  local c = uiCity(P)
  if not c then return fail('city not found: ' .. tostring(P.cityId)) end
  local row, t = resolveItem(P.item)
  if not row then return fail('unknown item type: ' .. tostring(P.item)) end
  local params = {}
  params[CityCommandTypes[t.param]] = row.Hash
  local yield = P.yield or 'YIELD_GOLD'
  params[CityCommandTypes.PARAM_YIELD_TYPE] = GameInfo.Yields[yield].Index
  if t.tbl == 'Units' then
    params[CityCommandTypes.PARAM_MILITARY_FORMATION_TYPE] = MilitaryFormationTypes.STANDARD_MILITARY_FORMATION
  end
  local can, results = CityManager.CanStartCommand(c, CityCommandTypes.PURCHASE, params, true)
  if not can then
    return fail('the game refused this purchase', { failureReasons = failureReasons(results, CityCommandResults.FAILURE_REASONS) })
  end
  local before = Players[me]:GetTreasury():GetGoldBalance()
  CityManager.RequestCommand(c, CityCommandTypes.PURCHASE, params)
  return { ok = true, requested = true, goldBefore = before }
end
function A.verify_purchase(P)
  return { ok = true, goldNow = Players[me]:GetTreasury():GetGoldBalance(), faithNow = Players[me]:GetReligion():GetFaithBalance() }
end

function A.set_research(P)
  local row = GameInfo.Technologies[P.tech]
  if not row then return fail('unknown tech: ' .. tostring(P.tech)) end
  local te = Players[me]:GetTechs()
  if te:HasTech(row.Index) then return fail('already researched') end
  if not te:CanResearch(row.Index) then return fail('prerequisites not met') end
  local params = {}
  params[PlayerOperations.PARAM_TECH_TYPE] = row.Hash
  params[PlayerOperations.PARAM_INSERT_MODE] = PlayerOperations.VALUE_EXCLUSIVE
  UI.RequestPlayerOperation(me, PlayerOperations.RESEARCH, params)
  return { ok = true, requested = true, turns = te:GetTurnsToResearch(row.Index) }
end
function A.verify_set_research(P)
  local t = Players[me]:GetTechs():GetResearchingTech()
  local cur = t >= 0 and GameInfo.Technologies[t].TechnologyType or nil
  return { ok = cur == P.tech, researching = cur }
end

function A.set_civic(P)
  local row = GameInfo.Civics[P.civic]
  if not row then return fail('unknown civic: ' .. tostring(P.civic)) end
  local cu = Players[me]:GetCulture()
  if cu:HasCivic(row.Index) then return fail('already completed') end
  if not cu:CanProgress(row.Index) then return fail('prerequisites not met') end
  local params = {}
  params[PlayerOperations.PARAM_CIVIC_TYPE] = row.Hash
  params[PlayerOperations.PARAM_INSERT_MODE] = PlayerOperations.VALUE_EXCLUSIVE
  UI.RequestPlayerOperation(me, PlayerOperations.PROGRESS_CIVIC, params)
  return { ok = true, requested = true }
end
function A.verify_set_civic(P)
  local c = Players[me]:GetCulture():GetProgressingCivic()
  local cur = c >= 0 and GameInfo.Civics[c].CivicType or nil
  return { ok = cur == P.civic, progressing = cur }
end

function A.move_unit(P)
  local u = uiUnit(P)
  if not u then return fail('unit not found: ' .. tostring(P.unitId)) end
  local params = {}
  params[UnitOperationTypes.PARAM_X] = P.x
  params[UnitOperationTypes.PARAM_Y] = P.y
  if not UnitManager.CanStartOperation(u, UnitOperationTypes.MOVE_TO, nil, params) then
    return fail('the game refused this move (blocked, unreachable, or no moves left)', { from = { u:GetX(), u:GetY() } })
  end
  local from = { u:GetX(), u:GetY() }
  UnitManager.RequestOperation(u, UnitOperationTypes.MOVE_TO, params)
  return { ok = true, requested = true, from = from }
end
function A.verify_move_unit(P)
  local u = uiUnit(P)
  if not u then return fail('unit gone after move') end
  return { ok = (u:GetX() == P.x and u:GetY() == P.y), at = { u:GetX(), u:GetY() }, movesLeft = u:GetMovesRemaining(),
    note = 'a multi-turn path leaves the unit en route; it continues next turn' }
end

-- Any unit operation by its database name, e.g. UNITOPERATION_FORTIFY,
-- UNITOPERATION_FOUND_CITY, UNITOPERATION_BUILD_IMPROVEMENT, ...
function A.unit_operation(P)
  local u = uiUnit(P)
  if not u then return fail('unit not found: ' .. tostring(P.unitId)) end
  local row = GameInfo.UnitOperations[P.operation]
  if not row then return fail('unknown unit operation: ' .. tostring(P.operation)) end
  local params = {}
  if P.x and P.y then
    params[UnitOperationTypes.PARAM_X] = P.x
    params[UnitOperationTypes.PARAM_Y] = P.y
  end
  if P.improvement then
    local imp = GameInfo.Improvements[P.improvement]
    if not imp then return fail('unknown improvement: ' .. tostring(P.improvement)) end
    params[UnitOperationTypes.PARAM_IMPROVEMENT_TYPE] = imp.Hash
  end
  local can, results = UnitManager.CanStartOperation(u, row.Hash, nil, params, true)
  if not can then
    return fail('the game refused ' .. P.operation, { failureReasons = failureReasons(results, UnitOperationResults.FAILURE_REASONS) })
  end
  local before = unitState(u)
  UnitManager.RequestOperation(u, row.Hash, params)
  return { ok = true, requested = true, before = before }
end
function A.verify_unit_operation(P)
  local after = unitState(uiUnit(P))
  return { ok = unitChanged(P.before, after), before = P.before, after = after,
    note = 'ok means the unit visibly changed (position, moves, health, activity, or it was consumed)' }
end

-- Any unit command by its database name, e.g. UNITCOMMAND_UPGRADE,
-- UNITCOMMAND_PROMOTE (needs P.promotion), UNITCOMMAND_DELETE, ...
function A.unit_command(P)
  local u = uiUnit(P)
  if not u then return fail('unit not found: ' .. tostring(P.unitId)) end
  local row = GameInfo.UnitCommands[P.command]
  if not row then return fail('unknown unit command: ' .. tostring(P.command)) end
  local params = {}
  if P.x and P.y then
    params[UnitCommandTypes.PARAM_X] = P.x
    params[UnitCommandTypes.PARAM_Y] = P.y
  end
  if P.promotion then
    local pr = GameInfo.UnitPromotions[P.promotion]
    if not pr then return fail('unknown promotion: ' .. tostring(P.promotion)) end
    params[UnitCommandTypes.PARAM_PROMOTION_TYPE] = pr.Hash
  end
  local can, results = UnitManager.CanStartCommand(u, row.Hash, params, true)
  if not can then
    return fail('the game refused ' .. P.command, { failureReasons = failureReasons(results, UnitCommandResults.FAILURE_REASONS) })
  end
  local before = unitState(u)
  UnitManager.RequestCommand(u, row.Hash, params)
  return { ok = true, requested = true, before = before }
end
function A.verify_unit_command(P)
  local after = unitState(uiUnit(P))
  local o = { ok = unitChanged(P.before, after), before = P.before, after = after }
  if not o.ok and after.exists then
    local u = uiUnit(P)
    local r = GameInfo.Units[u:GetType()]
    o.unitType = r and r.UnitType
    o.note = 'no position/moves/health/activity change; for upgrades and promotions check unitType or experience'
    if P.command == 'UNITCOMMAND_UPGRADE' or P.command == 'UNITCOMMAND_PROMOTE' then o.ok = true; o.unverified = true end
  end
  return o
end

-- What this unit can do right now, according to the game.
function A.unit_actions(P)
  local u = uiUnit(P)
  if not u then return fail('unit not found: ' .. tostring(P.unitId)) end
  local ops, cmds = {}, {}
  for row in GameInfo.UnitOperations() do
    -- Mirrors UnitPanel.lua: (unit, hash, nil, false, false) = startable now, no results.
    local ok, can = pcall(UnitManager.CanStartOperation, u, row.Hash, nil, false, false)
    if ok and can then ops[#ops + 1] = row.OperationType end
  end
  for row in GameInfo.UnitCommands() do
    local ok, can = pcall(UnitManager.CanStartCommand, u, row.Hash, false)
    if ok and can then cmds[#cmds + 1] = row.CommandType end
  end
  return { ok = true, unitId = P.unitId, at = { u:GetX(), u:GetY() }, operations = ops, commands = cmds }
end

function A.end_turn(P)
  UI.RequestAction(ActionTypes.ACTION_ENDTURN)
  return { ok = true, requested = true, turn = Game.GetCurrentGameTurn() }
end
function A.verify_end_turn(P)
  return { ok = true, turnNow = Game.GetCurrentGameTurn(),
    note = 'if the turn did not advance, something is blocking it (a choice to make, or units needing orders)' }
end

function A.look_at(P)
  UI.LookAtPlot(P.x, P.y)
  return { ok = true }
end

------------------------------------------------------------------ EDIT
function A.change_gold(P)
  local tr = Players[playerId(P)]:GetTreasury()
  local before = tr:GetGoldBalance()
  tr:ChangeGoldBalance(P.amount)
  return { ok = true, before = before, after = tr:GetGoldBalance() }
end

function A.change_faith(P)
  local re = Players[playerId(P)]:GetReligion()
  local before = re:GetFaithBalance()
  re:ChangeFaithBalance(P.amount)
  return { ok = true, before = before, after = re:GetFaithBalance() }
end

function A.grant_tech(P)
  local row = GameInfo.Technologies[P.tech]
  if not row then return fail('unknown tech: ' .. tostring(P.tech)) end
  local te = Players[playerId(P)]:GetTechs()
  local before = te:HasTech(row.Index)
  te:SetTech(row.Index, true)
  return { ok = te:HasTech(row.Index), before = before, after = te:HasTech(row.Index) }
end

function A.grant_civic(P)
  local row = GameInfo.Civics[P.civic]
  if not row then return fail('unknown civic: ' .. tostring(P.civic)) end
  local cu = Players[playerId(P)]:GetCulture()
  local before = cu:HasCivic(row.Index)
  cu:SetCivic(row.Index, true)
  return { ok = cu:HasCivic(row.Index), before = before, after = cu:HasCivic(row.Index) }
end

function A.finish_production(P)
  local c = coreCity(P)
  if not c then return fail('city not found: ' .. tostring(P.cityId)) end
  local bq = c:GetBuildQueue()
  local before = bq:GetSize()
  if before == 0 then return fail('city is not producing anything') end
  bq:FinishProgress()
  return { ok = true, queueBefore = before, queueAfter = bq:GetSize() }
end

function A.change_population(P)
  local c = coreCity(P)
  if not c then return fail('city not found: ' .. tostring(P.cityId)) end
  local before = c:GetPopulation()
  c:ChangePopulation(P.delta)
  return { ok = true, before = before, after = c:GetPopulation() }
end

function A.spawn_unit(P)
  local row = GameInfo.Units[P.unitType]
  if not row then return fail('unknown unit type: ' .. tostring(P.unitType)) end
  local pid = playerId(P)
  local u = UnitManager.InitUnitValidAdjacentHex(pid, P.unitType, P.x, P.y)
  if not u then u = UnitManager.InitUnit(pid, P.unitType, P.x, P.y) end
  if not u then return fail('the game did not create the unit (invalid tile for this unit?)') end
  return { ok = true, unitId = u:GetID(), at = { u:GetX(), u:GetY() } }
end

function A.kill_unit(P)
  local u = coreUnit(P)
  if not u then return fail('unit not found: ' .. tostring(P.unitId)) end
  local r = GameInfo.Units[u:GetType()]
  UnitManager.Kill(u)
  return { ok = true, killed = r and r.UnitType }
end

function A.heal_unit(P)
  local u = coreUnit(P)
  if not u then return fail('unit not found: ' .. tostring(P.unitId)) end
  local before = u:GetDamage()
  u:SetDamage(P.damage or 0)
  return { ok = true, damageBefore = before, damageAfter = u:GetDamage() }
end

function A.restore_moves(P)
  local u = coreUnit(P)
  if not u then return fail('unit not found: ' .. tostring(P.unitId)) end
  local before = u:GetMovesRemaining()
  u:ChangeMovesRemaining(u:GetMaxMoves() - before)
  return { ok = true, before = before, after = u:GetMovesRemaining() }
end

function A.add_experience(P)
  local u = coreUnit(P)
  if not u then return fail('unit not found: ' .. tostring(P.unitId)) end
  local xp = u:GetExperience()
  local before = xp:GetExperiencePoints()
  xp:ChangeExperience(P.amount)
  return { ok = true, before = before, after = xp:GetExperiencePoints() }
end

local function plotAt(P)
  local p = Map.GetPlot(P.x, P.y)
  if not p then return nil, fail('no plot at ' .. tostring(P.x) .. ',' .. tostring(P.y)) end
  return p
end

function A.set_terrain(P)
  local p, err = plotAt(P); if not p then return err end
  local row = GameInfo.Terrains[P.terrain]
  if not row then return fail('unknown terrain: ' .. tostring(P.terrain)) end
  local before = GameInfo.Terrains[p:GetTerrainType()].TerrainType
  TerrainBuilder.SetTerrainType(p, row.Index)
  return { ok = true, before = before, after = GameInfo.Terrains[p:GetTerrainType()].TerrainType }
end

function A.set_feature(P)
  local p, err = plotAt(P); if not p then return err end
  local idx = -1
  if P.feature then
    local row = GameInfo.Features[P.feature]
    if not row then return fail('unknown feature: ' .. tostring(P.feature)) end
    idx = row.Index
  end
  local b = p:GetFeatureType()
  TerrainBuilder.SetFeatureType(p, idx)
  local a = p:GetFeatureType()
  return { ok = a == idx, before = b >= 0 and GameInfo.Features[b].FeatureType or nil, after = a >= 0 and GameInfo.Features[a].FeatureType or nil }
end

function A.set_resource(P)
  local p, err = plotAt(P); if not p then return err end
  local idx = -1
  if P.resource then
    local row = GameInfo.Resources[P.resource]
    if not row then return fail('unknown resource: ' .. tostring(P.resource)) end
    idx = row.Index
  end
  local b = p:GetResourceType()
  ResourceBuilder.SetResourceType(p, idx, P.amount or 1)
  local a = p:GetResourceType()
  return { ok = a == idx, before = b >= 0 and GameInfo.Resources[b].ResourceType or nil, after = a >= 0 and GameInfo.Resources[a].ResourceType or nil }
end

function A.set_improvement(P)
  local p, err = plotAt(P); if not p then return err end
  local idx = -1
  if P.improvement then
    local row = GameInfo.Improvements[P.improvement]
    if not row then return fail('unknown improvement: ' .. tostring(P.improvement)) end
    idx = row.Index
  end
  local b = p:GetImprovementType()
  ImprovementBuilder.SetImprovementType(p, idx, P.owner or playerId(P))
  local a = p:GetImprovementType()
  return { ok = a == idx, before = b >= 0 and GameInfo.Improvements[b].ImprovementType or nil, after = a >= 0 and GameInfo.Improvements[a].ImprovementType or nil }
end

function A.reveal_map(P)
  PlayersVisibility[playerId(P)]:RevealAllPlots()
  return { ok = true }
end

function A.meet_player(P)
  local d = Players[playerId(P)]:GetDiplomacy()
  local before = d:HasMet(P.otherId)
  d:SetHasMet(P.otherId)
  return { ok = d:HasMet(P.otherId), before = before, after = d:HasMet(P.otherId) }
end

function A.declare_war(P)
  local d = Players[playerId(P)]:GetDiplomacy()
  local before = d:IsAtWarWith(P.otherId)
  d:DeclareWarOn(P.otherId)
  return { ok = d:IsAtWarWith(P.otherId), before = before, after = d:IsAtWarWith(P.otherId) }
end

function A.make_peace(P)
  local d = Players[playerId(P)]:GetDiplomacy()
  local before = d:IsAtWarWith(P.otherId)
  d:MakePeaceWith(P.otherId)
  return { ok = not d:IsAtWarWith(P.otherId), before = before, after = d:IsAtWarWith(P.otherId) }
end

local fn = A[P.action]
if not fn then
  emitJson(fail('no such action: ' .. tostring(P.action)))
  return
end
local ok, res = pcall(fn, P)
if not ok then
  emitJson(fail('Lua error: ' .. shortErr(res)))
  return
end
res.gaps = __gaps
emitJson(res)
