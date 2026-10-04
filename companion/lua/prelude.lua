-- Prepended to every Lua body the bridge sends. Runs inside the pcall wrapper
-- that TunerClient.exec builds, so `emit` is already in scope.
-- Civ VI runs Havok Script (Lua 5.1 dialect): no goto, no //, no bit ops.

local J = {}

local function jstr(s)
  s = string.gsub(s, '[%c"\\]', function(c)
    if c == '"' then return '\\"' end
    if c == '\\' then return '\\\\' end
    if c == '\n' then return '\\n' end
    if c == '\r' then return '\\r' end
    if c == '\t' then return '\\t' end
    return string.format('\\u%04x', string.byte(c))
  end)
  return '"' .. s .. '"'
end

local function isArray(t)
  local n = 0
  for k, _ in pairs(t) do
    if type(k) ~= 'number' or k < 1 or math.floor(k) ~= k then return false end
    n = n + 1
  end
  for i = 1, n do if t[i] == nil then return false end end
  return true
end

local function enc(v, out, depth)
  local tv = type(v)
  if v == nil then out[#out + 1] = 'null'
  elseif tv == 'boolean' then out[#out + 1] = v and 'true' or 'false'
  elseif tv == 'number' then
    if v ~= v or v == math.huge or v == -math.huge then out[#out + 1] = 'null'
    elseif v == math.floor(v) and math.abs(v) < 1e15 then out[#out + 1] = string.format('%d', v)
    else out[#out + 1] = string.format('%.4f', v) end
  elseif tv == 'string' then out[#out + 1] = jstr(v)
  elseif tv == 'table' then
    if depth > 24 then out[#out + 1] = '"<depth>"'; return end
    if next(v) == nil then out[#out + 1] = '[]'; return end
    if isArray(v) then
      out[#out + 1] = '['
      for i = 1, #v do
        if i > 1 then out[#out + 1] = ',' end
        enc(v[i], out, depth + 1)
      end
      out[#out + 1] = ']'
    else
      out[#out + 1] = '{'
      local first = true
      for k, val in pairs(v) do
        if not first then out[#out + 1] = ',' end
        first = false
        out[#out + 1] = jstr(tostring(k))
        out[#out + 1] = ':'
        enc(val, out, depth + 1)
      end
      out[#out + 1] = '}'
    end
  else
    out[#out + 1] = jstr('<' .. tv .. '>')
  end
end

function J.encode(v)
  local out = {}
  enc(v, out, 0)
  return table.concat(out)
end

-- Emit a value as JSON in fixed-size chunks ("J" lines). The bridge joins
-- them. Chunking keeps every print well under any engine line limit.
local CHUNK = 900
local function emitJson(v)
  local s = J.encode(v)
  local i = 1
  local n = string.len(s)
  while i <= n do
    emit('J' .. string.sub(s, i, i + CHUNK - 1))
    i = i + CHUNK
  end
end

-- Run fn and record a failure by name instead of aborting the whole call.
-- An unavailable API leaves a named gap; it never guesses a value.
local __gaps = {}
local function try(name, fn, ...)
  local ok, res = pcall(fn, ...)
  if ok then return res end
  __gaps[#__gaps + 1] = name .. ': ' .. tostring(res)
  return nil
end

local function L(key)
  if key == nil then return nil end
  local ok, s = pcall(Locale.Lookup, key)
  if ok then return s end
  return key
end

local YIELDS = { 'FOOD', 'PRODUCTION', 'GOLD', 'SCIENCE', 'CULTURE', 'FAITH' }
