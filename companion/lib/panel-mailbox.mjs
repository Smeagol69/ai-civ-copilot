// Lua snippets for the panel mailbox protocol: draining outbox/taken/events
// (POLL_LUA, run in UI_STATE against the app-wide ExposedMembers.AICivCopilot)
// and pushing a reply or button update back (REPLY_LUA/BUTTONS_LUA).
//
// Every panel (re)initialization stamps Mailbox.generation once, and every
// request it queues (AICivCopilotPanel.lua's Queue()) carries that same
// value. A reply/button update captured under an older generation must not
// land in a newer one's UI or clear its taken entry - a previous game's
// in-flight AI work is not evidence about a newer game. The check here only
// suppresses a *confirmed* mismatch (both sides known and different);
// either side unknown (no panel has set a generation yet) is let through,
// since there is nothing concrete to contradict.
export const POLL_LUA = `
local mp, cloud, humans = false, false, nil
local mpOk = pcall(function() mp = GameConfiguration.IsNetworkMultiplayer() end)
local cloudOk = pcall(function() cloud = GameConfiguration.IsPlayByCloud() end)
pcall(function() humans = GameConfiguration.GetHumanPlayerCount() end)
local factsOk = mpOk and cloudOk
local m = ExposedMembers and ExposedMembers.AICivCopilot
if m == nil then emitJson({ panel = false, mp = mp, cloud = cloud, humans = humans, factsOk = factsOk }) return end
local q = m.outbox or {}
m.outbox = {}
m.taken = m.taken or {}
local recovered = {}
if P.recover then for _, r in pairs(m.taken) do recovered[#recovered + 1] = r end end
for _, r in ipairs(q) do if r.id and r.id ~= 0 then m.taken[r.id] = r end end
local ev = m.events or {}
m.events = {}
m.bridgeTicks = (m.bridgeTicks or 0) + 1
emitJson({ panel = true, version = m.version, generation = m.generation, questions = q, recovered = recovered, events = ev, turn = Game.GetCurrentGameTurn(), mp = mp, cloud = cloud, humans = humans, factsOk = factsOk })
`;

export const REPLY_LUA = `
local m = ExposedMembers and ExposedMembers.AICivCopilot
local current = m and m.generation
if current ~= nil and P.generation ~= nil and P.generation ~= current then return end
if m and m.taken and (P.kind == "answer" or P.kind == "error") then m.taken[P.id] = nil end
LuaEvents.AICivCopilot_Reply(P.generation, P.id, P.kind, P.text)`;

export const BUTTONS_LUA = `
local m = ExposedMembers and ExposedMembers.AICivCopilot
local current = m and m.generation
if current ~= nil and P.generation ~= nil and P.generation ~= current then return end
LuaEvents.AICivCopilot_Buttons(P.generation, P.group, P.items)`;
