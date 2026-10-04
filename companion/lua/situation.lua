-- What the player is facing right now: wars, how every known civ feels about
-- them (and why), deals on the table, and what blocks ending the turn.
-- Runs in InGame. Call shapes come from Firaxis' diplomacy screens:
--   p:GetDiplomaticAI():GetDiplomaticStateIndex(me) -> GameInfo.DiplomaticStates
--   p:GetDiplomaticAI():GetDiplomaticModifiers(me)  -> { {Score, Text}, ... }
--   DealManager.GetWorkingDeal(DealDirection.INCOMING, me, other), deal:Items(),
--   item:GetType/GetAmount/GetDuration/GetValueType/GetValueTypeNameID/GetFromPlayerID
--   DealManager.HasPendingDeal(me, other), DiplomacyManager.FindOpenSessionID(me, other)
--   NotificationManager.GetFirstEndTurnBlocking(me)  (ActionPanel)
-- Every read is try()'d: a missing piece leaves a named gap, never an error.

local me = Game.GetLocalPlayer()
local pMe = Players[me]
local dip = pMe:GetDiplomacy()
local out = { turn = Game.GetCurrentGameTurn(), me = me, civs = {}, deals = {}, wars = {} }

local function civName(id)
  return try('civ', function() return L(PlayerConfigurations[id]:GetCivilizationShortDescription()) end) or ('player ' .. id)
end

local function dealItems(pDeal, other)
  local gives, asks = {}, {}
  for item in pDeal:Items() do
    local t = item:GetType()
    local what
    if t == DealItemTypes.GOLD then
      what = (item:GetDuration() > 0) and (item:GetAmount() .. ' gold/turn for ' .. item:GetDuration() .. ' turns') or (item:GetAmount() .. ' gold')
    elseif t == DealItemTypes.RESOURCES then
      local r = GameInfo.Resources[item:GetValueType()]
      what = item:GetAmount() .. ' ' .. (r and L(r.Name) or 'resource') .. ((item:GetDuration() > 0) and (' for ' .. item:GetDuration() .. ' turns') or '')
    else
      local nameId = item:GetValueTypeNameID()
      what = (nameId and L(nameId)) or ('deal item type ' .. tostring(t))
    end
    if item:GetFromPlayerID() == other then gives[#gives + 1] = what else asks[#asks + 1] = what end
  end
  return gives, asks
end

for i = 0, 63 do
  local p = Players[i]
  if p and i ~= me and p:IsAlive() and p:IsMajor() and dip:HasMet(i) then
    local c = { id = i, civ = civName(i), atWar = dip:IsAtWarWith(i) }
    local ai = p:GetDiplomaticAI()
    local stateIndex = try('diplo.state', function() return ai:GetDiplomaticStateIndex(me) end)
    if stateIndex ~= nil then
      local row = GameInfo.DiplomaticStates[stateIndex]
      if row then
        c.mood = row.StateType
        c.moodLevel = row.RelationshipLevel
      end
    end
    c.reasons = try('diplo.modifiers', function()
      local list = {}
      for _, tip in ipairs(ai:GetDiplomaticModifiers(me) or {}) do
        if tip.Score ~= 0 then list[#list + 1] = { score = tip.Score, text = L(tip.Text) } end
      end
      table.sort(list, function(a, b) return math.abs(a.score) > math.abs(b.score) end)
      return list
    end)
    c.score = try('score', function() return p:GetScore() end)
    c.military = try('military', function() return p:GetStats():GetMilitaryStrengthWithoutTreasury() end)
    c.openSession = try('diplo.session', function() return DiplomacyManager.FindOpenSessionID(me, i) end)
    c.pendingDeal = try('deal.pending', function() return DealManager.HasPendingDeal(me, i) end)
    local deal = try('deal.incoming', function()
      local pDeal = DealManager.GetWorkingDeal(DealDirection.INCOMING, me, i)
      if pDeal == nil or pDeal:GetItemCount() == 0 then return nil end
      local gives, asks = dealItems(pDeal, i)
      return { from = i, civ = c.civ, gives = gives, asks = asks }
    end)
    if deal then out.deals[#out.deals + 1] = deal end
    if c.atWar then out.wars[#out.wars + 1] = c.civ end
    out.civs[#out.civs + 1] = c
  end
end

out.blocking = try('blocking', function()
  local b = NotificationManager.GetFirstEndTurnBlocking(me)
  for k, v in pairs(EndTurnBlockingTypes) do if v == b then return k end end
  return nil
end)

out.gaps = __gaps
emitJson(out)
