-- Typed actions. The bridge calls one entry point per request:
--   emitJson(A[P.action](P))
-- PLAY actions run in InGame and go through the same request path as a
-- click (CityManager/UnitManager/UI.Request*), after the game's own
-- CanStart* check. The game validates them exactly as it validates input.
-- EDIT actions run in GameCore_Tuner and change the simulation directly;
-- each one returns before/after values read from the game itself.
-- VERIFY functions (verify_<action>) read the world back after a PLAY
-- request, because requests are processed asynchronously. A play action
-- hands its verify whatever it needs in `verifyArgs`.
--
-- Native engine functions do not validate their arguments: a bad id or
-- index can crash the game (2026-10-04). Every id, index and coordinate is
-- checked here before it reaches one, and every call shape below is copied
-- from Firaxis' own scripts (cited where it is not obvious).

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
  if type(typeName) ~= 'string' then return nil, nil end
  for _, t in ipairs(ITEM_TABLES) do
    if string.sub(typeName, 1, string.len(t.prefix)) == t.prefix then
      local row = GameInfo[t.tbl][typeName]
      if row then return row, t end
    end
  end
  return nil, nil
end

-- A player id the engine actually handed out (PlayerManager.IsValid is how
-- the shipped UI checks ids before using them).
local function validPlayer(id)
  if type(id) ~= 'number' or id < 0 or id > 63 or math.floor(id) ~= id then return false end
  if Players[id] == nil then return false end
  local ok, valid = pcall(PlayerManager.IsValid, id)
  return ok and valid == true
end
local function playerId(P) return P.playerId or me end
local function checkPlayer(P)
  local pid = playerId(P)
  if not validPlayer(pid) then return nil, fail('not a valid player id: ' .. tostring(pid)) end
  return pid
end
local function checkOther(P)
  local pid, err = checkPlayer(P)
  if not pid then return nil, nil, err end
  if not validPlayer(P.otherId) then return nil, nil, fail('not a valid player id: ' .. tostring(P.otherId)) end
  if P.otherId == pid then return nil, nil, fail('a player cannot do this with itself') end
  return pid, P.otherId
end

local function plotAt(P)
  if type(P.x) ~= 'number' or type(P.y) ~= 'number' then return nil, fail('x and y are required') end
  local p = Map.GetPlot(P.x, P.y)
  if not p then return nil, fail('no plot at ' .. tostring(P.x) .. ',' .. tostring(P.y)) end
  return p
end

-- GameCore lookups (edits). City IDs from the snapshot are the full IDs.
local function coreCity(P)
  local pid = checkPlayer(P)
  return pid and Players[pid]:GetCities():FindID(P.cityId)
end
local function coreUnit(P)
  local pid = checkPlayer(P)
  return pid and Players[pid]:GetUnits():FindID(P.unitId)
end
-- InGame lookups (play).
local function uiCity(P)
  local pid = checkPlayer(P)
  return pid and CityManager.GetCity(pid, P.cityId)
end
local function uiUnit(P)
  local pid = checkPlayer(P)
  return pid and UnitManager.GetUnit(pid, P.unitId)
end

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

local function countUnits(pid, unitType)
  local n = 0
  for _, u in Players[pid]:GetUnits():Members() do
    local r = GameInfo.Units[u:GetType()]
    if unitType == nil or (r and r.UnitType == unitType) then n = n + 1 end
  end
  return n
end

------------------------------------------------------------------ PLAY
-- Production follows ProductionPanel.GetBuildInsertMode: a plain click is
-- VALUE_REPLACE_AT position 0 (replace the current item, keep the rest of
-- the queue); the queue panel appends. VALUE_EXCLUSIVE wipes the whole
-- queue - a live test lost a queued Scout that way - so it is opt-in only.
--   mode current   (default) replace the current item, keep the queue
--   mode append    add to the end of the queue
--   mode exclusive the queue becomes just this item
local MAX_QUEUE_SIZE = 7 -- ProductionPanel.lua

local function countQueued(bq, row, t)
  local n = 0
  for i = 0, bq:GetSize() - 1 do
    local e = bq:GetAt(i)
    if e and e[t.key] == row.Index then n = n + 1 end
  end
  return n
end

function A.set_production(P)
  local c = uiCity(P)
  if not c then return fail('city not found: ' .. tostring(P.cityId)) end
  local row, t = resolveItem(P.item)
  if not row then return fail('unknown item type: ' .. tostring(P.item)) end
  local mode = P.mode or (P.append and 'append') or 'current'
  if mode ~= 'current' and mode ~= 'append' and mode ~= 'exclusive' then return fail('mode must be current, append or exclusive') end
  if P.x ~= nil or P.y ~= nil then
    local p, err = plotAt(P); if not p then return err end
  end
  local bq = c:GetBuildQueue()
  local params = {}
  params[CityOperationTypes[t.param]] = row.Hash
  if P.x and P.y then
    params[CityOperationTypes.PARAM_X] = P.x
    params[CityOperationTypes.PARAM_Y] = P.y
  end
  if mode == 'append' then
    if bq:GetSize() - 1 >= MAX_QUEUE_SIZE then
      params[CityOperationTypes.PARAM_INSERT_MODE] = CityOperationTypes.VALUE_REPLACE_AT
      params[CityOperationTypes.PARAM_QUEUE_DESTINATION_LOCATION] = MAX_QUEUE_SIZE
    else
      params[CityOperationTypes.PARAM_INSERT_MODE] = CityOperationTypes.VALUE_APPEND
    end
  elseif mode == 'exclusive' then
    params[CityOperationTypes.PARAM_INSERT_MODE] = CityOperationTypes.VALUE_EXCLUSIVE
  else
    params[CityOperationTypes.PARAM_INSERT_MODE] = CityOperationTypes.VALUE_REPLACE_AT
    params[CityOperationTypes.PARAM_QUEUE_DESTINATION_LOCATION] = 0
  end
  local can, results = CityManager.CanStartOperation(c, CityOperationTypes.BUILD, params, true)
  if not can then
    return fail('the game refused this build', { failureReasons = failureReasons(results, CityOperationResults.FAILURE_REASONS),
      needsPlacement = (t.tbl == 'Districts' or (t.tbl == 'Buildings' and row.IsWonder)) and not (P.x and P.y) })
  end
  local verifyArgs = { mode = mode, countBefore = countQueued(bq, row, t), sizeBefore = bq:GetSize() }
  CityManager.RequestOperation(c, CityOperationTypes.BUILD, params)
  return { ok = true, requested = true, item = P.item, mode = mode, turns = bq:GetTurnsLeft(row.Hash), verifyArgs = verifyArgs }
end
function A.verify_set_production(P)
  local c = uiCity(P)
  if not c then return fail('city not found') end
  local row, t = resolveItem(P.item)
  local bq = c:GetBuildQueue()
  local size = bq:GetSize()
  local h = size > 0 and bq:GetCurrentProductionTypeHash() or 0
  local isCurrent = row ~= nil and row.Hash == h
  local count = row and countQueued(bq, row, t) or 0
  local o = { currentMatches = isCurrent, queued = count, queueSize = size }
  if P.mode == 'append' then
    o.ok = count > (P.countBefore or 0)
  else
    o.ok = isCurrent
    if P.mode == 'current' and type(P.sizeBefore) == 'number' and size < P.sizeBefore then
      o.ok = false
      o.reason = 'the rest of the queue was lost'
    end
  end
  return o
end

function A.purchase(P)
  local c = uiCity(P)
  if not c then return fail('city not found: ' .. tostring(P.cityId)) end
  local row, t = resolveItem(P.item)
  if not row then return fail('unknown item type: ' .. tostring(P.item)) end
  local yield = P.yield or 'YIELD_GOLD'
  if not GameInfo.Yields[yield] then return fail('unknown yield: ' .. tostring(yield)) end
  local params = {}
  params[CityCommandTypes[t.param]] = row.Hash
  params[CityCommandTypes.PARAM_YIELD_TYPE] = GameInfo.Yields[yield].Index
  if t.tbl == 'Units' then
    params[CityCommandTypes.PARAM_MILITARY_FORMATION_TYPE] = MilitaryFormationTypes.STANDARD_MILITARY_FORMATION
  end
  local can, results = CityManager.CanStartCommand(c, CityCommandTypes.PURCHASE, params, true)
  if not can then
    return fail('the game refused this purchase', { failureReasons = failureReasons(results, CityCommandResults.FAILURE_REASONS) })
  end
  local verifyArgs = {
    yield = yield,
    goldBefore = Players[me]:GetTreasury():GetGoldBalance(),
    faithBefore = Players[me]:GetReligion():GetFaithBalance(),
  }
  if t.tbl == 'Units' then verifyArgs.unitsBefore = countUnits(me, P.item) end
  CityManager.RequestCommand(c, CityCommandTypes.PURCHASE, params)
  return { ok = true, requested = true, verifyArgs = verifyArgs }
end
function A.verify_purchase(P)
  local gold = Players[me]:GetTreasury():GetGoldBalance()
  local faith = Players[me]:GetReligion():GetFaithBalance()
  local o = { goldBefore = P.goldBefore, goldNow = gold, faithBefore = P.faithBefore, faithNow = faith }
  if P.yield == 'YIELD_FAITH' then o.ok = faith < (P.faithBefore or faith) else o.ok = gold < (P.goldBefore or gold) end
  if P.unitsBefore ~= nil then
    o.unitsNow = countUnits(me, P.item)
    o.ok = o.ok and o.unitsNow > P.unitsBefore
  end
  return o
end

-- Research and civics follow the tech/civics tree (Screens/TechTree.lua,
-- Screens/CivicsTree.lua): the request carries the whole PATH to the target
-- (GetResearchPath / GetCivicPath), so far targets work, and the insert mode
-- decides what happens to the player's existing queue:
--   front   (default) research the target now, then continue the old queue
--   replace the queue becomes just the path (a plain click in the tree)
--   append  add the path after the existing queue (shift-click)
-- A plain EXCLUSIVE request wipes the queue: found live on 2026-10-04, when a
-- test switch erased a 7-civic plan. Queue values are row indices (the
-- choosers compare them with .Index); paths are passed back unchanged.
local function queueTypes(q, tbl, key)
  local out = {}
  if type(q) ~= 'table' then return out end
  local items = {}
  for i, v in pairs(q) do items[#items + 1] = { i = i, v = v } end
  table.sort(items, function(a, b) return a.i < b.i end)
  for _, e in ipairs(items) do
    local r = GameInfo[tbl][e.v]
    out[#out + 1] = r and r[key] or e.v
  end
  return out
end

local function hashesToTypes(path, tbl, key)
  local byHash = {}
  for r in GameInfo[tbl]() do byHash[r.Hash] = r[key] end
  local out = {}
  if type(path) == 'table' then
    local items = {}
    for i, h in pairs(path) do items[#items + 1] = { i = i, h = h } end
    table.sort(items, function(a, b) return a.i < b.i end)
    for _, e in ipairs(items) do out[#out + 1] = byHash[e.h] or e.h end
  end
  return out
end

local function requestTree(op, paramKey, payload, append)
  local params = {}
  params[PlayerOperations[paramKey]] = payload
  if append then
    params[PlayerOperations.PARAM_INSERT_MODE] = PlayerOperations.VALUE_APPEND
  else
    params[PlayerOperations.PARAM_INSERT_MODE] = PlayerOperations.VALUE_EXCLUSIVE
  end
  UI.RequestPlayerOperation(me, PlayerOperations[op], params)
end

local function setTreeTarget(P, spec)
  local row = GameInfo[spec.tbl][P[spec.arg]]
  if not row then return fail('unknown ' .. spec.arg .. ': ' .. tostring(P[spec.arg])) end
  local obj = spec.obj()
  -- Future Tech / Future Civic can be done again (Repeatable); the choosers
  -- re-offer them, so a completed repeatable is not "already done".
  local repeatable = row.Repeatable == true or row.Repeatable == 1
  if spec.has(obj, row.Index) and not repeatable then return fail('already ' .. spec.doneWord) end
  local mode = P.mode or 'front'
  if mode ~= 'front' and mode ~= 'replace' and mode ~= 'append' then return fail('mode must be front, replace or append') end
  local cur = spec.current(obj)
  if mode == 'front' and cur == P[spec.arg] then
    return { ok = true, requested = false, mode = mode, note = 'already the current ' .. spec.arg }
  end
  local queueBefore = queueTypes(spec.queue(obj), spec.tbl, spec.key)
  -- The in-progress item may not be part of the queue list; keep it in the plan.
  if cur and queueBefore[1] ~= cur then table.insert(queueBefore, 1, cur) end
  local payload, pathTypes
  if repeatable and spec.has(obj, row.Index) then
    payload, pathTypes = row.Hash, { P[spec.arg] } -- chooser shape: bare hash, EXCLUSIVE
    if mode == 'append' then return fail('a completed repeatable can only be chosen with mode front or replace') end
  else
    payload = spec.path(obj, row.Hash)
    pathTypes = hashesToTypes(payload, spec.tbl, spec.key)
    if #pathTypes == 0 then return fail('the game returned no path to ' .. tostring(P[spec.arg])) end
  end
  requestTree(spec.op, spec.param, payload, mode == 'append')
  if mode == 'front' then
    local inPath = {}
    for _, t in ipairs(pathTypes) do inPath[t] = true end
    for _, t in ipairs(queueBefore) do
      local r = GameInfo[spec.tbl][t]
      -- Re-append exactly as a shift-click in the tree does: the item's path
      -- with VALUE_APPEND (its prerequisites are already queued by now).
      if r and not inPath[t] and not spec.has(obj, r.Index) then requestTree(spec.op, spec.param, spec.path(obj, r.Hash), true) end
    end
  end
  return { ok = true, requested = true, mode = mode, path = pathTypes, queueBefore = queueBefore,
    verifyArgs = { mode = mode, path = pathTypes, queueBefore = queueBefore } }
end

local function verifyTreeTarget(P, spec)
  local obj = spec.obj()
  local queue = queueTypes(spec.queue(obj), spec.tbl, spec.key)
  local cur = spec.current(obj)
  local target = P[spec.arg]
  local present = {}
  for _, t in ipairs(queue) do present[t] = true end
  if cur then present[cur] = true end
  local o = { current = cur, queue = queue }
  local mode = P.mode or 'front'
  if mode == 'append' then
    o.ok = present[target] == true
  else
    -- The first not-yet-done step of the path must now be the current one.
    local first = nil
    if type(P.path) == 'table' then
      for _, t in ipairs(P.path) do
        local r = GameInfo[spec.tbl][t]
        if r and (not spec.has(obj, r.Index) or t == cur) then first = t; break end
      end
    end
    o.ok = (first ~= nil and cur == first) or cur == target
    o.expectedCurrent = first
  end
  if o.ok and mode ~= 'replace' and type(P.queueBefore) == 'table' then
    local lost = {}
    for _, t in ipairs(P.queueBefore) do
      local r = GameInfo[spec.tbl][t]
      if r and not present[t] and not spec.has(obj, r.Index) then lost[#lost + 1] = t end
    end
    o.queueKept = (#lost == 0)
    if #lost > 0 then
      o.lostFromQueue = lost
      o.ok = false
      o.reason = 'the target is set but part of the old queue is missing'
    end
  end
  return o
end

local RESEARCH = {
  tbl = 'Technologies', key = 'TechnologyType', arg = 'tech', doneWord = 'researched',
  op = 'RESEARCH', param = 'PARAM_TECH_TYPE',
  obj = function() return Players[me]:GetTechs() end,
  has = function(o, i) return o:HasTech(i) end,
  queue = function(o) return o:GetResearchQueue() end,
  path = function(o, h) return o:GetResearchPath(h) end,
  current = function(o)
    local t = o:GetResearchingTech()
    return t >= 0 and GameInfo.Technologies[t].TechnologyType or nil
  end,
}
local CIVICS = {
  tbl = 'Civics', key = 'CivicType', arg = 'civic', doneWord = 'completed',
  op = 'PROGRESS_CIVIC', param = 'PARAM_CIVIC_TYPE',
  obj = function() return Players[me]:GetCulture() end,
  has = function(o, i) return o:HasCivic(i) end,
  queue = function(o) return o:GetCivicQueue() end,
  path = function(o, h) return o:GetCivicPath(h) end,
  current = function(o)
    local c = o:GetProgressingCivic()
    return c >= 0 and GameInfo.Civics[c].CivicType or nil
  end,
}

function A.set_research(P) return setTreeTarget(P, RESEARCH) end
function A.verify_set_research(P) return verifyTreeTarget(P, RESEARCH) end
function A.set_civic(P) return setTreeTarget(P, CIVICS) end
function A.verify_set_civic(P) return verifyTreeTarget(P, CIVICS) end

-- An attack the game would treat as a declaration of war. The shipped UI
-- asks first (WorldInput.lua: IsAttackChangeWarState, then a confirm
-- dialog); CanStartOperation alone does not stop it.
local function startsWar(u, x, y)
  local ok, results = pcall(CombatManager.IsAttackChangeWarState, u:GetComponentID(), x, y)
  if ok and type(results) == 'table' and #results > 0 then return results end
  return nil
end

function A.move_unit(P)
  local u = uiUnit(P)
  if not u then return fail('unit not found: ' .. tostring(P.unitId)) end
  local p, err = plotAt(P); if not p then return err end
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
  local o = { at = { u:GetX(), u:GetY() }, movesLeft = u:GetMovesRemaining() }
  if u:GetX() == P.x and u:GetY() == P.y then
    o.ok = true
    return o
  end
  -- A multi-turn path leaves the unit en route with the target queued
  -- (WorldInput.lua reads it with UnitManager.GetQueuedDestination).
  local p = Map.GetPlot(P.x, P.y)
  local okq, dest = pcall(UnitManager.GetQueuedDestination, u)
  if okq and p and dest == p:GetIndex() then
    o.ok = true
    o.enRoute = true
  else
    o.ok = false
    o.reason = 'the unit is not at the target and has no route to it queued'
  end
  return o
end

-- Any unit operation by its database name, e.g. UNITOPERATION_FORTIFY,
-- UNITOPERATION_FOUND_CITY, UNITOPERATION_BUILD_IMPROVEMENT, ...
function A.unit_operation(P)
  local u = uiUnit(P)
  if not u then return fail('unit not found: ' .. tostring(P.unitId)) end
  local row = GameInfo.UnitOperations[P.operation]
  if not row then return fail('unknown unit operation: ' .. tostring(P.operation)) end
  local params = {}
  local x, y = P.x, P.y
  if P.improvement and x == nil and y == nil then
    -- UnitPanel.GetBuildImprovementParameters always targets the unit's tile.
    x, y = u:GetX(), u:GetY()
  end
  if x ~= nil or y ~= nil then
    local p, err = plotAt({ x = x, y = y }); if not p then return err end
    params[UnitOperationTypes.PARAM_X] = x
    params[UnitOperationTypes.PARAM_Y] = y
    local war = startsWar(u, x, y)
    if war and not P.allowWar then
      return fail('this would start a war with player(s) ' .. table.concat(war, ', ') .. '; pass allowWar=true only if the player asked for that', { wouldDeclareWarOn = war })
    end
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
  return { ok = true, requested = true, before = before, verifyArgs = { before = before } }
end
function A.verify_unit_operation(P)
  local after = unitState(uiUnit(P))
  return { ok = unitChanged(P.before, after), before = P.before, after = after,
    note = 'ok means the unit visibly changed (position, moves, health, activity, or it was consumed)' }
end

-- Any unit command by its database name, e.g. UNITCOMMAND_UPGRADE,
-- UNITCOMMAND_PROMOTE (with promotion), UNITCOMMAND_DELETE, ...
function A.unit_command(P)
  local u = uiUnit(P)
  if not u then return fail('unit not found: ' .. tostring(P.unitId)) end
  local row = GameInfo.UnitCommands[P.command]
  if not row then return fail('unknown unit command: ' .. tostring(P.command)) end
  local params = {}
  if P.x ~= nil or P.y ~= nil then
    local p, err = plotAt(P); if not p then return err end
    params[UnitCommandTypes.PARAM_X] = P.x
    params[UnitCommandTypes.PARAM_Y] = P.y
  end
  local verifyArgs = {}
  if P.promotion then
    local pr = GameInfo.UnitPromotions[P.promotion]
    if not pr then return fail('unknown promotion: ' .. tostring(P.promotion)) end
    -- UnitPromotionPopup.lua: the request carries the promotion's row Index,
    -- and only one the game lists as available right now.
    local _, res = UnitManager.CanStartCommand(u, UnitCommandTypes.PROMOTE, true, true)
    local offered = false
    if type(res) == 'table' and type(res[UnitCommandResults.PROMOTIONS]) == 'table' then
      for _, idx in pairs(res[UnitCommandResults.PROMOTIONS]) do if idx == pr.Index then offered = true end end
    end
    if not offered then return fail('the game does not offer ' .. P.promotion .. ' to this unit now') end
    params[UnitCommandTypes.PARAM_PROMOTION_TYPE] = pr.Index
    verifyArgs.promotionIndex = pr.Index
  end
  local can, results = UnitManager.CanStartCommand(u, row.Hash, params, true)
  if not can then
    return fail('the game refused ' .. P.command, { failureReasons = failureReasons(results, UnitCommandResults.FAILURE_REASONS) })
  end
  local before = unitState(u)
  local r0 = GameInfo.Units[u:GetType()]
  verifyArgs.before = before
  verifyArgs.typeBefore = r0 and r0.UnitType
  UnitManager.RequestCommand(u, row.Hash, params)
  return { ok = true, requested = true, before = before, verifyArgs = verifyArgs }
end
function A.verify_unit_command(P)
  local u = uiUnit(P)
  local after = unitState(u)
  local o = { before = P.before, after = after }
  if P.promotionIndex ~= nil then
    o.ok = u ~= nil and u:GetExperience():HasPromotion(P.promotionIndex) == true
    return o
  end
  if P.command == 'UNITCOMMAND_UPGRADE' and u then
    local r = GameInfo.Units[u:GetType()]
    o.unitType = r and r.UnitType
    o.ok = o.unitType ~= P.typeBefore
    return o
  end
  o.ok = unitChanged(P.before, after)
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
  local turn = Game.GetCurrentGameTurn()
  UI.RequestAction(ActionTypes.ACTION_ENDTURN)
  return { ok = true, requested = true, turn = turn, verifyArgs = { turn = turn } }
end
function A.verify_end_turn(P)
  local now = Game.GetCurrentGameTurn()
  local o = { turnBefore = P.turn, turnNow = now, ok = type(P.turn) == 'number' and now > P.turn }
  if not o.ok then o.reason = 'the turn has not advanced yet: AI turns may still be running, or something needs the player (a choice, or units needing orders)' end
  return o
end

function A.look_at(P)
  local p, err = plotAt(P); if not p then return err end
  UI.LookAtPlot(P.x, P.y)
  return { ok = true }
end

------------------------------------------------------------------ EDIT
function A.change_gold(P)
  local pid, err = checkPlayer(P); if not pid then return err end
  local tr = Players[pid]:GetTreasury()
  local before = tr:GetGoldBalance()
  tr:ChangeGoldBalance(P.amount)
  return { ok = true, before = before, after = tr:GetGoldBalance() }
end

function A.change_faith(P)
  local pid, err = checkPlayer(P); if not pid then return err end
  local re = Players[pid]:GetReligion()
  local before = re:GetFaithBalance()
  re:ChangeFaithBalance(P.amount)
  return { ok = true, before = before, after = re:GetFaithBalance() }
end

-- Grants go through the progress interface, as Firaxis' own tuner panel
-- does ("rather than just setting the tech so all the events get sent",
-- Debug/Player.ltp). The item may complete when the game next processes
-- research, so both the progress and the completion are reported.
function A.grant_tech(P)
  local pid, err = checkPlayer(P); if not pid then return err end
  local row = GameInfo.Technologies[P.tech]
  if not row then return fail('unknown tech: ' .. tostring(P.tech)) end
  local te = Players[pid]:GetTechs()
  if te:HasTech(row.Index) then return fail('already researched') end
  local cost = te:GetResearchCost(row.Index)
  local before = te:GetResearchProgress(row.Index)
  te:SetResearchProgress(row.Index, cost)
  local after = te:GetResearchProgress(row.Index)
  return { ok = te:HasTech(row.Index) or after >= cost, completedNow = te:HasTech(row.Index),
    progressBefore = before, progressAfter = after, cost = cost }
end

function A.grant_civic(P)
  local pid, err = checkPlayer(P); if not pid then return err end
  local row = GameInfo.Civics[P.civic]
  if not row then return fail('unknown civic: ' .. tostring(P.civic)) end
  local cu = Players[pid]:GetCulture()
  if cu:HasCivic(row.Index) then return fail('already completed') end
  local cost = cu:GetCultureCost(row.Index)
  -- GameCore's culture object has a progress setter but no getter, so the
  -- read-back is HasCivic; read InGame's GetCulturalProgress to see progress.
  cu:SetCulturalProgress(row.Index, cost)
  local done = cu:HasCivic(row.Index)
  local o = { ok = true, completedNow = done, progressSetTo = cost }
  if not done then o.note = 'progress is at full cost; the civic completes when the game next processes culture' end
  return o
end

-- GameCore's build queue has no GetSize (it is an InGame method); Firaxis'
-- City.ltp reads the item with CurrentlyBuilding().
function A.finish_production(P)
  local c = coreCity(P)
  if not c then return fail('city not found: ' .. tostring(P.cityId)) end
  local bq = c:GetBuildQueue()
  local before = bq:CurrentlyBuilding()
  if before == nil or before == '' or before == -1 then return fail('city is not producing anything') end
  local row, t = resolveItem(type(before) == 'string' and before or nil)
  local pid = playerId(P)
  local unitsBefore = (t and t.tbl == 'Units') and countUnits(pid, before) or nil
  bq:FinishProgress()
  local after = bq:CurrentlyBuilding()
  local o = { before = before, after = after }
  if t and t.tbl == 'Units' then
    o.unitsBefore, o.unitsAfter = unitsBefore, countUnits(pid, before)
    o.ok = o.unitsAfter > unitsBefore
  elseif t and t.tbl == 'Buildings' then
    o.ok = c:GetBuildings():HasBuilding(row.Index) == true
  else
    o.ok = after ~= before
  end
  return o
end

function A.change_population(P)
  local c = coreCity(P)
  if not c then return fail('city not found: ' .. tostring(P.cityId)) end
  if type(P.delta) ~= 'number' or P.delta == 0 or math.abs(P.delta) > 30 then return fail('delta must be a non-zero whole number up to 30') end
  local before = c:GetPopulation()
  if before + P.delta < 1 then return fail('a city cannot go below 1 citizen') end
  c:ChangePopulation(P.delta)
  return { ok = c:GetPopulation() == before + P.delta, before = before, after = c:GetPopulation() }
end

-- Shapes from the scenario scripts: InitUnitValidAdjacentHex(player, type,
-- x, y, n) with n = 1..3. Its return value is used nowhere in Firaxis' code,
-- so success is judged by counting the player's units, not by trusting it;
-- there is no blind InitUnit fallback that could double-spawn.
function A.spawn_unit(P)
  local pid, err = checkPlayer(P); if not pid then return err end
  local row = GameInfo.Units[P.unitType]
  if not row then return fail('unknown unit type: ' .. tostring(P.unitType)) end
  local p, perr = plotAt(P); if not p then return perr end
  if not PlayerManager.IsAlive(pid) then return fail('player ' .. pid .. ' is not alive') end
  local ids = {}
  for _, u in Players[pid]:GetUnits():Members() do ids[u:GetID()] = true end
  local radius = P.radius or 1
  if radius < 0 or radius > 3 then return fail('radius must be 0-3') end
  UnitManager.InitUnitValidAdjacentHex(pid, P.unitType, P.x, P.y, radius)
  local new = {}
  for _, u in Players[pid]:GetUnits():Members() do
    if not ids[u:GetID()] then new[#new + 1] = { unitId = u:GetID(), at = { u:GetX(), u:GetY() } } end
  end
  if #new == 0 then return fail('the game did not create the unit (no valid tile near ' .. P.x .. ',' .. P.y .. ' for it?)') end
  local o = { ok = true, unitId = new[1].unitId, at = new[1].at }
  if #new > 1 then o.created = new end
  return o
end

function A.kill_unit(P)
  local u = coreUnit(P)
  if not u then return fail('unit not found: ' .. tostring(P.unitId)) end
  local r = GameInfo.Units[u:GetType()]
  UnitManager.Kill(u)
  local gone = Players[playerId(P)]:GetUnits():FindID(P.unitId) == nil
  return { ok = gone, killed = r and r.UnitType }
end

-- Firaxis never leaves a unit at full damage (Debug/Unit.ltp kills it;
-- Tutorial.lua uses GetMaxDamage() - 1), so damage stays below the maximum.
function A.heal_unit(P)
  local u = coreUnit(P)
  if not u then return fail('unit not found: ' .. tostring(P.unitId)) end
  local dmg = P.damage or 0
  local max = u:GetMaxDamage()
  if dmg < 0 or dmg > max - 1 then return fail('damage must be between 0 and ' .. (max - 1) .. '; use kill_unit to remove a unit') end
  local before = u:GetDamage()
  u:SetDamage(dmg)
  return { ok = u:GetDamage() == dmg, damageBefore = before, damageAfter = u:GetDamage() }
end

-- As Debug/Unit.ltp "Restore Movement" does.
function A.restore_moves(P)
  local u = coreUnit(P)
  if not u then return fail('unit not found: ' .. tostring(P.unitId)) end
  local before = u:GetMovesRemaining()
  UnitManager.RestoreMovementToFormation(u)
  UnitManager.RestoreUnitAttacks(u)
  return { ok = u:GetMovesRemaining() >= before, before = before, after = u:GetMovesRemaining() }
end

function A.add_experience(P)
  local u = coreUnit(P)
  if not u then return fail('unit not found: ' .. tostring(P.unitId)) end
  local xp = u:GetExperience()
  local before = xp:GetExperiencePoints()
  xp:ChangeExperience(P.amount)
  return { ok = true, before = before, after = xp:GetExperiencePoints() }
end

local function terrainIsWater(row)
  return row ~= nil and (row.Water == true or row.Water == 1)
end

function A.set_terrain(P)
  local p, err = plotAt(P); if not p then return err end
  local row = GameInfo.Terrains[P.terrain]
  if not row then return fail('unknown terrain: ' .. tostring(P.terrain)) end
  local cur = GameInfo.Terrains[p:GetTerrainType()]
  if terrainIsWater(cur) ~= terrainIsWater(row) then
    -- No-argument plot methods only: nothing here can be called with a wrong
    -- shape (Map.GetUnitsAt takes a plot in GameCore but x,y in InGame).
    local occupied = p:IsCity() or p:GetDistrictType() >= 0 or p:IsUnit()
    if occupied then return fail('refusing a land/water change on a tile with a city, district or units') end
  end
  local before = cur.TerrainType
  TerrainBuilder.SetTerrainType(p, row.Index)
  local after = GameInfo.Terrains[p:GetTerrainType()].TerrainType
  return { ok = after == P.terrain, before = before, after = after }
end

-- Natural wonders are multi-plot features that WorldBuilder places and
-- removes as a whole (WorldBuilderPlacement.lua); one plot of one would be
-- left broken, so they are refused here.
function A.set_feature(P)
  local p, err = plotAt(P); if not p then return err end
  if p:IsNaturalWonder() then return fail('this tile is part of a natural wonder; refusing to change it') end
  local idx = -1
  if P.feature then
    local row = GameInfo.Features[P.feature]
    if not row then return fail('unknown feature: ' .. tostring(P.feature)) end
    if row.NaturalWonder == true or row.NaturalWonder == 1 then return fail('natural wonders cannot be placed one tile at a time') end
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
  local owner = P.owner
  if owner == nil then owner = playerId(P) end
  if owner ~= -1 and not validPlayer(owner) then return fail('not a valid owner id: ' .. tostring(owner)) end
  local idx = -1
  if P.improvement then
    local row = GameInfo.Improvements[P.improvement]
    if not row then return fail('unknown improvement: ' .. tostring(P.improvement)) end
    idx = row.Index
    -- NO_TEAM is -1 (TeamTypes does not exist in GameCore; the scenario
    -- scripts define a local NO_TEAM = -1 for this exact call).
    if not P.force and not ImprovementBuilder.CanHaveImprovement(p, idx, -1) then
      return fail('the game says this tile cannot have ' .. P.improvement .. ' (pass force=true to place it anyway)')
    end
  end
  local b = p:GetImprovementType()
  ImprovementBuilder.SetImprovementType(p, idx, owner)
  local a = p:GetImprovementType()
  return { ok = a == idx, before = b >= 0 and GameInfo.Improvements[b].ImprovementType or nil, after = a >= 0 and GameInfo.Improvements[a].ImprovementType or nil }
end

function A.reveal_map(P)
  local pid, err = checkPlayer(P); if not pid then return err end
  local vis = PlayersVisibility[pid]
  local before = vis:GetNumRevealedHexes()
  vis:RevealAllPlots()
  local after = vis:GetNumRevealedHexes()
  return { ok = after >= before, revealedBefore = before, revealedAfter = after, plotCount = Map.GetPlotCount() }
end

function A.meet_player(P)
  local pid, other, err = checkOther(P); if not pid then return err end
  local d = Players[pid]:GetDiplomacy()
  local before = d:HasMet(other)
  d:SetHasMet(other)
  return { ok = d:HasMet(other), before = before, after = d:HasMet(other) }
end

-- Scenario scripts declare with DeclareWarOn(id, WarTypes.FORMAL_WAR, true)
-- after CanDeclareWarOn(id, WarTypes.FORMAL_WAR, true).
function A.declare_war(P)
  local pid, other, err = checkOther(P); if not pid then return err end
  local warType = WarTypes[P.warType or 'FORMAL_WAR']
  if warType == nil then return fail('unknown war type: ' .. tostring(P.warType)) end
  local d = Players[pid]:GetDiplomacy()
  if d:IsAtWarWith(other) then return fail('already at war') end
  if not d:CanDeclareWarOn(other, warType, true) then return fail('the game says this war cannot be declared now') end
  d:DeclareWarOn(other, warType, true)
  return { ok = d:IsAtWarWith(other), before = false, after = d:IsAtWarWith(other) }
end

-- MakePeaceWith exists on GameCore diplomacy, but no Firaxis script calls it,
-- so its argument shape is unproven. It runs only when the caller accepts
-- that explicitly (experimental=true), after the game's own CanMakePeaceWith.
function A.make_peace(P)
  local pid, other, err = checkOther(P); if not pid then return err end
  if P.experimental ~= true then
    return fail('MakePeaceWith has no Firaxis call shape to copy; pass experimental=true to try it (a wrong shape can crash the game - save first)')
  end
  local d = Players[pid]:GetDiplomacy()
  if not d:IsAtWarWith(other) then return fail('not at war') end
  if not d:CanMakePeaceWith(other) then return fail('the game says peace cannot be made now') end
  d:MakePeaceWith(other)
  return { ok = not d:IsAtWarWith(other), before = true, after = d:IsAtWarWith(other) }
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
