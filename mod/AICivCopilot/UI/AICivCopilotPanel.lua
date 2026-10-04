-- AI Civ Copilot in-game panel: a button for every feature.
--
-- The panel never talks to the network: Civ VI's Lua cannot. Each button
-- queues a request in ExposedMembers.AICivCopilot.outbox; the companion bridge
-- polls that through the FireTuner socket (bumping Mailbox.bridgeTicks each
-- time) and answers with LuaEvents.AICivCopilot_Reply(id, kind, text).
-- Buttons act on what is selected in the game (UI.GetHeadSelectedCity /
-- UI.GetHeadSelectedUnit), so nothing has to be typed. The text box is only
-- for free questions to the AI.
--
-- Request kinds: quick (a button: key + selection), ask (free text), new.
-- Reply kinds: status, answer, error, hello (bridge identity).
-- The bridge also sends LuaEvents.AICivCopilot_Buttons(group, items) to fill
-- the dynamic groups: "unitops" (what the selected unit can do right now) and
-- "abilities" (abilities the copilot has taught itself).

include("InstanceManager");

local m_LogIM = InstanceManager:new("LogEntry", "Text", Controls.LogStack);
local m_TabIM = InstanceManager:new("TabButton", "Button", Controls.TabStack);
local m_NextId = 1;
local m_Pending = {};
local m_Count = 0;
local MAX_ENTRIES = 120;
local PER_ROW = 4;

ExposedMembers.AICivCopilot = ExposedMembers.AICivCopilot or {};
local Mailbox = ExposedMembers.AICivCopilot;
Mailbox.outbox = Mailbox.outbox or {};
Mailbox.version = 3;

-- needs: "city" or "unit" = requires that selection; confirm = click twice.
local TABS = {
	{ key = "info", label = "Info", buttons = {
		{ key = "overview",      label = "Overview",        tip = "Gold, science, culture, faith, research and civic at a glance" },
		{ key = "production",    label = "Production",      tip = "What every city builds; idle, crowded and unhappy cities" },
		{ key = "threats",       label = "Threats",         tip = "Visible foreign military near your territory, hostile first" },
		{ key = "idle",          label = "Idle units",      tip = "Units waiting for orders" },
		{ key = "rivals",        label = "Rivals",          tip = "Score, cities, military and techs of every civ you have met" },
		{ key = "turnbrief",     label = "Turn brief",      tip = "What needs your attention this turn" },
		{ key = "resources",     label = "Resources",       tip = "Strategic and luxury resources you have" },
		{ key = "researchqueue", label = "Research queue",  tip = "Current research and civic, and what is queued after them" },
		{ key = "recent",        label = "Recent changes",  tip = "The last changes the copilot made to the game" },
		{ key = "autobrief",     label = "Auto brief: off", localToggle = true, tip = "Post a Turn brief automatically at the start of each of your turns" },
	} },
	{ key = "city", label = "City", buttons = {
		{ key = "city_details",      label = "City details",     needs = "city", tip = "Everything about the selected city" },
		{ key = "city_ai",           label = "What to build?",   needs = "city", tip = "The AI picks production for the selected city" },
		{ key = "finish_production", label = "Finish build",     needs = "city", tip = "Complete the selected city's current production now" },
		{ key = "pop_up",            label = "+1 Citizen",       needs = "city", tip = "Add a citizen to the selected city" },
		{ key = "pop_down",          label = "-1 Citizen",       needs = "city", tip = "Remove a citizen from the selected city" },
		{ key = "city_tiles",        label = "Tiles around",     needs = "city", tip = "Terrain, resources and units around the selected city" },
		{ key = "look_city",         label = "Look at city",     needs = "city", tip = "Move the camera to the selected city" },
	} },
	{ key = "unit", label = "Unit", buttons = {
		{ key = "unit_ops",     label = "What can it do?", needs = "unit", tip = "List what the selected unit can do right now, as buttons" },
		{ key = "unit_ai",      label = "Use it well",     needs = "unit", tip = "The AI suggests (and can carry out) the best use of this unit" },
		{ key = "heal",         label = "Full heal",       needs = "unit", tip = "Restore the selected unit to full health" },
		{ key = "moves",        label = "Restore moves",   needs = "unit", tip = "Give the selected unit its movement and attacks back" },
		{ key = "xp",           label = "+50 XP",          needs = "unit", tip = "Give the selected unit 50 experience" },
		{ key = "fortify",      label = "Fortify",         needs = "unit", tip = "Fortify the selected unit" },
		{ key = "sleep",        label = "Sleep",           needs = "unit", tip = "Put the selected unit to sleep" },
		{ key = "skip",         label = "Skip turn",       needs = "unit", tip = "Skip the selected unit's turn" },
		{ key = "kill",         label = "Remove unit",     needs = "unit", confirm = true, tip = "Remove the selected unit (click twice)" },
		{ key = "look_unit",    label = "Look at unit",    needs = "unit", tip = "Move the camera to the selected unit" },
	}, dynamic = "unitops", dynamicTitle = "Available now:" },
	{ key = "empire", label = "Empire", buttons = {
		{ key = "gold_100",        label = "+100 Gold",       tip = "Add 100 gold" },
		{ key = "gold_1000",       label = "+1000 Gold",      tip = "Add 1000 gold" },
		{ key = "gold_m100",       label = "-100 Gold",       tip = "Remove 100 gold" },
		{ key = "faith_100",       label = "+100 Faith",      tip = "Add 100 faith" },
		{ key = "faith_1000",      label = "+1000 Faith",     tip = "Add 1000 faith" },
		{ key = "finish_research", label = "Finish research", tip = "Complete the current research" },
		{ key = "finish_civic",    label = "Finish civic",    tip = "Complete the current civic" },
		{ key = "end_turn",        label = "End turn",        confirm = true, tip = "End the turn (click twice)" },
	} },
	{ key = "map", label = "Map", buttons = {
		{ key = "spawn_settler", label = "Spawn Settler", tip = "Create a Settler at the selected unit or city" },
		{ key = "spawn_builder", label = "Spawn Builder", tip = "Create a Builder at the selected unit or city" },
		{ key = "spawn_trader",  label = "Spawn Trader",  tip = "Create a Trader at the selected unit or city" },
		{ key = "spawn_scout",   label = "Spawn Scout",   tip = "Create a Scout at the selected unit or city" },
		{ key = "spawn_warrior", label = "Spawn Warrior", tip = "Create a Warrior at the selected unit or city" },
		{ key = "tile_info",     label = "Tile info",     tip = "What is on the selected unit's or city's tile" },
		{ key = "reveal_map",    label = "Reveal map",    confirm = true, tip = "Reveal the whole map (click twice; cannot be undone)" },
	} },
	{ key = "ai", label = "Ask AI", buttons = {
		{ key = "advise",     label = "Advise me",       tip = "The AI reviews your empire and says what to do next" },
		{ key = "build_ai",   label = "Plan production", tip = "The AI picks production for every city" },
		{ key = "research_ai",label = "Plan research",   tip = "The AI plans your next techs" },
		{ key = "civic_ai",   label = "Plan civics",     tip = "The AI plans your next civics and policies" },
		{ key = "expand_ai",  label = "Where to settle", tip = "The AI looks for good city sites" },
		{ key = "war_ai",     label = "War check",       tip = "The AI assesses threats and your defences" },
		{ key = "economy_ai", label = "Fix my economy",  tip = "The AI looks at gold, amenities, housing and trade" },
		{ key = "explore_ai", label = "Learn a skill",   tip = "The AI discovers a new game function and saves it as an ability" },
	} },
	{ key = "abilities", label = "Abilities", buttons = {
		{ key = "abilities_list", label = "Refresh list", tip = "Reload the copilot's saved abilities" },
	}, dynamic = "abilities", dynamicTitle = "Saved abilities:" },
};

local m_Tab = TABS[1];
local m_Dynamic = { unitops = {}, abilities = {} };
local m_Confirm = nil;       -- { key, time }
local m_Clock = 0;
local m_ButtonsByNeed = { city = {}, unit = {} };
local m_TabButtons = {};     -- tab key -> its button

local COLOR_YOU = "[COLOR:200,190,140,255]";
local COLOR_AI = "[COLOR:220,230,240,255]";
local COLOR_DIM = "[COLOR:140,160,180,255]";
local COLOR_ERR = "[COLOR:240,120,110,255]";
local COLOR_OK = "[COLOR:140,210,140,255]";

local m_LastTicks = -1;
local m_SinceChange = 0;
local m_BridgeOnline = false;
local m_Busy = 0;
local m_Model = "";

local function Escape(s)
	s = tostring(s or "");
	s = string.gsub(s, "\r", "");
	s = string.gsub(s, "\n", "[NEWLINE]");
	return s;
end

local function ScrollToEnd()
	Controls.LogStack:CalculateSize();
	Controls.LogScroll:CalculateInternalSize();
	Controls.LogScroll:SetScrollValue(1);
end

local function AddEntry(text)
	if m_Count >= MAX_ENTRIES then
		m_LogIM:ResetInstances();
		m_Count = 0;
		m_Pending = {};
	end
	local inst = m_LogIM:GetInstance();
	inst.Text:SetText(text);
	m_Count = m_Count + 1;
	ScrollToEnd();
	return inst;
end

local function RefreshStatus(detail)
	local s;
	if not m_BridgeOnline then
		s = COLOR_ERR .. "Bridge offline[ENDCOLOR] - run Start AI Civ Copilot";
	elseif m_Busy > 0 then
		s = COLOR_OK .. "Connected[ENDCOLOR] - " .. (detail or "working...");
	else
		s = COLOR_OK .. "Connected[ENDCOLOR] - ready" .. (m_Model ~= "" and (" (" .. m_Model .. ")") or "");
	end
	Controls.Status:SetText(s);
end

-- What is selected in the game right now.
local function Selection()
	local sel = {};
	local c = UI.GetHeadSelectedCity();
	if c then
		sel.cityId = c:GetID();
		sel.cityOwner = c:GetOwner();
		sel.cityName = Locale.Lookup(c:GetName());
		sel.x, sel.y = c:GetX(), c:GetY();
	end
	local u = UI.GetHeadSelectedUnit();
	if u then
		sel.unitId = u:GetID();
		sel.unitOwner = u:GetOwner();
		local r = GameInfo.Units[u:GetType()];
		sel.unitType = r and r.UnitType;
		sel.unitName = Locale.Lookup(u:GetName());
		sel.x, sel.y = u:GetX(), u:GetY();
	end
	return sel;
end

local function RefreshSelection()
	local sel = Selection();
	local parts = {};
	if sel.cityName then parts[#parts + 1] = "city " .. sel.cityName; end
	if sel.unitName then parts[#parts + 1] = "unit " .. sel.unitName .. " (" .. sel.x .. "," .. sel.y .. ")"; end
	if #parts == 0 then
		Controls.Selection:SetText(COLOR_DIM .. "Select a city or unit in the game for City / Unit buttons.[ENDCOLOR]");
	else
		Controls.Selection:SetText("Selected: " .. table.concat(parts, ", "));
	end
	for _, b in ipairs(m_ButtonsByNeed.city) do b:SetDisabled(sel.cityId == nil); end
	for _, b in ipairs(m_ButtonsByNeed.unit) do b:SetDisabled(sel.unitId == nil); end
end

local function Queue(kind, text, key)
	local id = m_NextId;
	m_NextId = m_NextId + 1;
	table.insert(Mailbox.outbox, { id = id, kind = kind, text = text, key = key, sel = Selection(), turn = Game.GetCurrentGameTurn() });
	m_Busy = m_Busy + 1;
	if m_BridgeOnline then
		m_Pending[id] = AddEntry(COLOR_DIM .. "working...[ENDCOLOR]");
	else
		m_Pending[id] = AddEntry(COLOR_DIM .. "queued - it will run when the bridge connects[ENDCOLOR]");
	end
	RefreshStatus();
	return id;
end

local function OnButton(entry, button)
	if entry.localToggle then
		Mailbox.autoBrief = not Mailbox.autoBrief;
		entry.label = Mailbox.autoBrief and "Auto brief: on" or "Auto brief: off";
		if button then button:SetText(entry.label); end
		AddEntry(COLOR_DIM .. (Mailbox.autoBrief and "A Turn brief will be posted at the start of each turn." or "Auto brief is off.") .. "[ENDCOLOR]");
		return;
	end
	if entry.confirm then
		if not (m_Confirm and m_Confirm.key == entry.key and m_Clock - m_Confirm.time < 4) then
			m_Confirm = { key = entry.key, time = m_Clock };
			AddEntry(COLOR_ERR .. "Click [" .. entry.label .. "] again within 4 seconds to confirm.[ENDCOLOR]");
			return;
		end
		m_Confirm = nil;
	end
	AddEntry(COLOR_YOU .. "You:[ENDCOLOR] [" .. entry.label .. "]");
	Queue("quick", entry.label, entry.key);
end

local function Send()
	local text = Controls.InputBox:GetText();
	if text == nil or text == "" then return; end
	Controls.InputBox:SetText("");
	AddEntry(COLOR_YOU .. "You:[ENDCOLOR] " .. Escape(text));
	Queue("ask", text);
end

local function OnNew()
	m_LogIM:ResetInstances();
	m_Count = 0;
	m_Pending = {};
	m_Busy = 0;
	table.insert(Mailbox.outbox, { id = 0, kind = "new", text = "new" });
	AddEntry(COLOR_DIM .. "New conversation.[ENDCOLOR]");
	RefreshStatus();
end

-- Lay out the button area for the current tab, then fit the log below it.
local function Layout()
	local _, h = UIManager:GetScreenSizeVal();
	local panelH = math.max(460, math.min(940, h - 112 - 250));
	Controls.Panel:SetSizeY(panelH);
	Controls.PanelInner:SetSizeY(panelH - 2);
	Controls.PanelGradient:SetSizeY(panelH - 2);
	Controls.ButtonArea:CalculateSize();
	local logTop = 92 + Controls.ButtonArea:GetSizeY() + 8;
	Controls.LogDivider:SetOffsetY(logTop);
	Controls.LogScroll:SetOffsetY(logTop + 6);
	Controls.LogScroll:SetSizeY(math.max(120, panelH - 2 - (logTop + 6) - 50));
	Controls.Panel:ReprocessAnchoring();
	Controls.PanelInner:ReprocessAnchoring();
	Controls.InputRow:ReprocessAnchoring();
	ScrollToEnd();
end

local function AddRows(list)
	local row = nil;
	local n = 0;
	for _, entry in ipairs(list) do
		if n % PER_ROW == 0 then
			row = {};
			ContextPtr:BuildInstanceForControl("ButtonRow", row, Controls.ButtonArea);
		end
		local b = {};
		ContextPtr:BuildInstanceForControl("ActionButton", b, row.Row);
		b.Button:SetText(entry.label);
		b.Button:SetToolTipString(entry.tip or entry.label);
		b.Button:RegisterCallback(Mouse.eLClick, function() OnButton(entry, b.Button); end);
		if entry.needs == "city" or entry.needs == "unit" then
			table.insert(m_ButtonsByNeed[entry.needs], b.Button);
		end
		n = n + 1;
	end
end

local function ShowTab(tab)
	m_Tab = tab;
	Controls.ButtonArea:DestroyAllChildren();
	m_ButtonsByNeed = { city = {}, unit = {} };
	AddRows(tab.buttons);
	if tab.dynamic then
		local items = m_Dynamic[tab.dynamic] or {};
		if #items > 0 then
			local title = {};
			ContextPtr:BuildInstanceForControl("LogEntry", title, Controls.ButtonArea);
			title.Text:SetText(COLOR_DIM .. tab.dynamicTitle .. "[ENDCOLOR]");
			AddRows(items);
		end
	end
	for key, button in pairs(m_TabButtons) do button:SetSelected(key == tab.key); end
	RefreshSelection();
	Layout();
end

local function BuildTabs()
	m_TabIM:ResetInstances();
	for _, tab in ipairs(TABS) do
		local inst = m_TabIM:GetInstance();
		m_TabButtons[tab.key] = inst.Button;
		inst.Button:SetText(tab.label);
		inst.Button:RegisterCallback(Mouse.eLClick, function() ShowTab(tab); end);
	end
	Controls.TabStack:CalculateSize();
end

-- Dynamic button groups pushed by the bridge.
local function OnButtons(group, items)
	if type(items) ~= "table" then return; end
	m_Dynamic[group] = items;
	if m_Tab and m_Tab.dynamic == group and not Controls.Panel:IsHidden() then ShowTab(m_Tab); end
end

local function OnReply(id, kind, text)
	if kind == "hello" then
		m_Model = tostring(text or "");
		m_BridgeOnline = true;
		RefreshStatus();
		return;
	end
	if kind == "status" then
		local inst = m_Pending[id];
		if inst then
			inst.Text:SetText(COLOR_DIM .. Escape(text) .. "[ENDCOLOR]");
			ScrollToEnd();
		end
		RefreshStatus(Escape(text));
		return;
	end
	local inst = m_Pending[id];
	if inst then
		inst.Text:SetText("");
		m_Pending[id] = nil;
	end
	if m_Busy > 0 and id ~= 0 then m_Busy = m_Busy - 1; end
	if kind == "error" then
		AddEntry(COLOR_ERR .. Escape(text) .. "[ENDCOLOR]");
	else
		AddEntry(COLOR_AI .. "Copilot:[ENDCOLOR] " .. Escape(text));
	end
	RefreshStatus();
	if Controls.Panel:IsHidden() then
		Controls.ToggleButton:SetText("AI Copilot *");
	end
end

local function Toggle()
	local hide = not Controls.Panel:IsHidden();
	Controls.Panel:SetHide(hide);
	Controls.ToggleButton:SetText("AI Copilot");
	if not hide then
		ShowTab(m_Tab);
		Controls.InputBox:TakeFocus();
	end
end

local function OnInput(pInputStruct)
	local msg = pInputStruct:GetMessageType();
	if msg == KeyEvents.KeyUp then
		local key = pInputStruct:GetKey();
		-- Shipped scripts never reference Keys.A; 65 is its virtual-key code.
		if key == (Keys.A or 65) and pInputStruct:IsControlDown() and pInputStruct:IsShiftDown() then
			Toggle();
			return true;
		end
		if key == Keys.VK_ESCAPE and not Controls.Panel:IsHidden() and Controls.InputBox:HasFocus() then
			Controls.Panel:SetHide(true);
			return true;
		end
	end
	return false;
end

-- Heartbeat: the bridge bumps bridgeTicks on every poll (about twice a second).
local function OnUpdate(fDeltaTime)
	local dt = fDeltaTime or 0;
	m_Clock = m_Clock + dt;
	m_SinceChange = m_SinceChange + dt;
	local ticks = Mailbox.bridgeTicks or 0;
	if ticks ~= m_LastTicks then
		m_LastTicks = ticks;
		m_SinceChange = 0;
		if not m_BridgeOnline then
			m_BridgeOnline = true;
			RefreshStatus();
		end
	elseif m_BridgeOnline and m_SinceChange > 5 then
		m_BridgeOnline = false;
		RefreshStatus();
	end
end

local function OnTurnBegin()
	if Mailbox.autoBrief then
		AddEntry(COLOR_DIM .. "Turn " .. Game.GetCurrentGameTurn() .. "[ENDCOLOR]");
		Queue("quick", "Turn brief", "turnbrief");
	end
end

local function OnSelectionChanged()
	if not Controls.Panel:IsHidden() then
		RefreshSelection();
		if m_Tab and m_Tab.dynamic == "unitops" then
			m_Dynamic.unitops = {};
			ShowTab(m_Tab);
		end
	end
end

function Initialize()
	ContextPtr:SetInputHandler(OnInput, true);
	ContextPtr:SetUpdate(OnUpdate);
	Controls.ToggleButton:RegisterCallback(Mouse.eLClick, Toggle);
	Controls.CloseButton:RegisterCallback(Mouse.eLClick, Toggle);
	Controls.NewButton:RegisterCallback(Mouse.eLClick, OnNew);
	Controls.SendButton:RegisterCallback(Mouse.eLClick, Send);
	Controls.InputBox:RegisterCommitCallback(Send);
	LuaEvents.AICivCopilot_Reply.Add(OnReply);
	LuaEvents.AICivCopilot_Buttons.Add(OnButtons);
	Events.LocalPlayerTurnBegin.Add(OnTurnBegin);
	Events.CitySelectionChanged.Add(OnSelectionChanged);
	Events.UnitSelectionChanged.Add(OnSelectionChanged);
	BuildTabs();
	AddEntry(COLOR_DIM .. "Pick a tab and click a button. City and Unit buttons act on what you have selected in the game. Type a question below to ask the AI anything.[ENDCOLOR]");
	RefreshStatus();
end

Initialize();
