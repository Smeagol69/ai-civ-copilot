-- AI Civ Copilot in-game panel.
-- The panel never talks to the network: Civ VI's Lua cannot. It queues the
-- player's questions in ExposedMembers.AICivCopilot.outbox; the companion
-- bridge polls that through the FireTuner socket and answers by firing
-- LuaEvents.AICivCopilot_Reply(id, kind, text).

include("InstanceManager");

local m_LogIM = InstanceManager:new("LogEntry", "Text", Controls.LogStack);
local m_NextId = 1;
local m_Pending = {};   -- id -> status label instance
local MAX_ENTRIES = 80;
local m_Count = 0;

ExposedMembers.AICivCopilot = ExposedMembers.AICivCopilot or {};
local Mailbox = ExposedMembers.AICivCopilot;
Mailbox.outbox = Mailbox.outbox or {};
Mailbox.version = 1;

local COLOR_YOU = "[COLOR:200,190,140,255]";
local COLOR_AI = "[COLOR:220,230,240,255]";
local COLOR_DIM = "[COLOR:140,160,180,255]";
local COLOR_ERR = "[COLOR:240,120,110,255]";

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

local function SetStatus(text)
	Controls.Status:SetText(text);
end

local function Send()
	local text = Controls.InputBox:GetText();
	if text == nil or text == "" then return; end
	local id = m_NextId;
	m_NextId = m_NextId + 1;
	table.insert(Mailbox.outbox, { id = id, text = text, turn = Game.GetCurrentGameTurn() });
	Controls.InputBox:SetText("");
	AddEntry(COLOR_YOU .. "You:[ENDCOLOR] " .. Escape(text));
	m_Pending[id] = AddEntry(COLOR_DIM .. "queued for the copilot...[ENDCOLOR]");
	if (Mailbox.bridgeTicks or 0) == 0 then
		SetStatus("bridge not seen yet");
	end
end

local function OnReply(id, kind, text)
	SetStatus("bridge connected");
	if kind == "status" then
		local inst = m_Pending[id];
		if inst then
			inst.Text:SetText(COLOR_DIM .. Escape(text) .. "[ENDCOLOR]");
			ScrollToEnd();
		end
		SetStatus(Escape(text));
		return;
	end
	local inst = m_Pending[id];
	if inst then
		inst.Text:SetText("");
		m_Pending[id] = nil;
	end
	if kind == "error" then
		AddEntry(COLOR_ERR .. Escape(text) .. "[ENDCOLOR]");
	else
		AddEntry(COLOR_AI .. "Copilot:[ENDCOLOR] " .. Escape(text));
	end
	SetStatus("ready");
	if Controls.Panel:IsHidden() then
		Controls.ToggleButton:SetText("AI *");
	end
end

local function Toggle()
	local hide = not Controls.Panel:IsHidden();
	Controls.Panel:SetHide(hide);
	Controls.ToggleButton:SetText("AI");
	if not hide then
		Controls.InputBox:TakeFocus();
		ScrollToEnd();
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

function Initialize()
	ContextPtr:SetInputHandler(OnInput, true);
	Controls.ToggleButton:RegisterCallback(Mouse.eLClick, Toggle);
	Controls.CloseButton:RegisterCallback(Mouse.eLClick, Toggle);
	Controls.SendButton:RegisterCallback(Mouse.eLClick, Send);
	Controls.InputBox:RegisterCommitCallback(Send);
	LuaEvents.AICivCopilot_Reply.Add(OnReply);
	AddEntry(COLOR_DIM .. "Ask about your empire, or tell the copilot to change the game. Type 'new' to start a fresh conversation.[ENDCOLOR]");
end

Initialize();
