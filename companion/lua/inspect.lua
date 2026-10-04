-- API introspection. Lists what a live value really exposes, so the copilot
-- can discover callable functions instead of guessing them.
-- The target expression is inlined by the bridge as __target (a function
-- returning the value), so any Lua expression valid in this state works.
-- Params: P.maxKeys (int), P.walkMeta (bool)

local function describe(v, maxKeys)
  local out = { type = type(v) }
  if type(v) ~= 'table' and type(v) ~= 'userdata' then
    if type(v) ~= 'function' then out.value = tostring(v) end
    return out
  end
  local fields, methods = {}, {}
  local seen = {}
  local function collect(t, origin)
    if type(t) ~= 'table' then return end
    for k, val in pairs(t) do
      local key = tostring(k)
      if not seen[key] then
        seen[key] = true
        if type(val) == 'function' then
          methods[#methods + 1] = key
        else
          local f = { name = key, type = type(val), from = origin }
          if type(val) ~= 'table' and type(val) ~= 'userdata' then f.value = tostring(val) end
          fields[#fields + 1] = f
        end
        if #fields + #methods >= maxKeys then return end
      end
    end
  end
  if type(v) == 'table' then
    local ok = pcall(collect, v, 'self')
    if not ok then out.iterateError = true end
  end
  if P.walkMeta ~= false then
    local mt = nil
    pcall(function() mt = getmetatable(v) end)
    local depth = 0
    while type(mt) == 'table' and depth < 6 do
      depth = depth + 1
      pcall(collect, mt, 'meta' .. depth)
      local idx = rawget(mt, '__index')
      if type(idx) == 'table' then
        pcall(collect, idx, 'index' .. depth)
        local nmt = nil
        pcall(function() nmt = getmetatable(idx) end)
        mt = nmt
      else
        mt = nil
      end
    end
  end
  table.sort(methods)
  table.sort(fields, function(a, b) return a.name < b.name end)
  out.methods = methods
  out.fields = fields
  return out
end

local ok, value = pcall(__target)
if not ok then
  emitJson({ error = 'target expression failed: ' .. tostring(value) })
  return
end
emitJson(describe(value, P.maxKeys or 2000))
