-- Offline WH3 MCP poll-bootstrap fixture.
-- Run in a standalone Lua interpreter with:
--   WH3_MCP_LUA_PATH=/path/to/pack/script/_lib/mod/wh3_mcp.lua \
--   WH3_MCP_BOOTSTRAP_SCENARIO=valid_timer lua lua_poll_bootstrap_harness.lua

local target = os.getenv("WH3_MCP_LUA_PATH")
local scenario = os.getenv("WH3_MCP_BOOTSTRAP_SCENARIO") or "valid_timer"
assert(target and target ~= "", "WH3_MCP_LUA_PATH is required")

local registrations = 0
local removals = 0
local listeners = {}
local campaign = false
local registered_callback = nil

local function timer(opts)
    opts = opts or {}
    return {
        repeat_real_callback = function(self, callback, interval, name)
            registrations = registrations + 1
            if opts.throw_register then error("registration exploded") end
            assert(type(callback) == "function")
            registered_callback = callback
            assert(type(interval) == "number")
            assert(name == "wh3_mcp_poll")
        end,
        remove_real_callback = function(self, name)
            removals = removals + 1
            assert(name == "wh3_mcp_poll")
        end,
    }
end

local core_tm = nil
local campaign_tm = nil

if scenario == "boolean_get_tm" then
    core_tm = true
elseif scenario == "nil_get_tm" then
    core_tm = nil
elseif scenario == "missing_repeat" then
    core_tm = {}
elseif scenario == "thrown_registration" then
    core_tm = timer({ throw_register = true })
elseif scenario == "campaign_fallback" then
    campaign = true
    core_tm = true
    campaign_tm = timer()
elseif scenario == "valid_timer" or scenario == "duplicate_load" or scenario == "controlled_rebind" or
       scenario == "duplicate_request" or scenario == "context_not_ready" or scenario == "invalid_protocol" or
       scenario == "older_session" then
    core_tm = timer()
else
    error("unknown scenario: " .. tostring(scenario))
end

core = {
    is_campaign = function(self) return campaign end,
    is_battle = function(self) return false end,
    get_tm = function(self) return core_tm end,
    add_listener = function(self, name, event, condition, callback, persistent)
        listeners[name] = callback
    end,
    remove_listener = function(self, name)
        listeners[name] = nil
    end,
}

cm = campaign_tm
bm = nil
UIComponent = function(v) return v end
common = { get_localised_string = function(v) return v end }

-- Keep the fixture isolated from any protocol marker left by another run.
os.remove("wh3_mcp_command.json")
os.remove("wh3_mcp_result.json")
os.remove("wh3_mcp_starting_campaign.marker")
os.remove("wh3_mcp_quitting.marker")
os.remove("wh3_mcp_session_v2.json")
os.remove("wh3_mcp_debug.log")
_G.__wh3_mcp_runtime_v2 = nil

if scenario == "context_not_ready" then
    local f = assert(io.open("wh3_mcp_session_v2.json", "w"))
    f:write('{"protocol":2,"session_id":"S1","last_request_id":5}')
    f:close()
end

dofile(target)
local runtime = assert(_G.__wh3_mcp_runtime_v2, "runtime singleton was not created")

if scenario == "boolean_get_tm" or scenario == "nil_get_tm" or scenario == "missing_repeat" then
    assert(registrations == 0, "unsupported core timer must not be registered")
    assert(runtime.callback_registered == false, "unsupported timer must not claim ready")
elseif scenario == "thrown_registration" then
    assert(registrations == 1, "registration should have been attempted exactly once")
    assert(runtime.callback_registered == false, "thrown registration must fail closed")
elseif scenario == "campaign_fallback" then
    assert(registrations == 1, "campaign fallback should register once")
    assert(runtime.callback_registered == true)
    assert(runtime.callback_owner_kind == "campaign_manager")
elseif scenario == "valid_timer" then
    assert(registrations == 1, "valid timer should register once")
    assert(runtime.callback_registered == true)
    assert(runtime.callback_owner_kind == "core_timer_manager")
elseif scenario == "duplicate_load" then
    assert(registrations == 1)
    local first_instance = runtime.instance
    dofile(target)
    local runtime2 = assert(_G.__wh3_mcp_runtime_v2)
    assert(runtime2 == runtime, "second copy must reuse singleton registry")
    assert(runtime2.instance == first_instance, "secondary copy must not replace owner")
    assert(registrations == 1, "secondary copy must not register a second poller")
    assert(runtime2.secondary_loads == 1)
elseif scenario == "controlled_rebind" then
    assert(registrations == 1)
    campaign = true
    cm = timer()
    assert(type(listeners.Wh3McpPollCampaignContext) == "function")
    listeners.Wh3McpPollCampaignContext()
    assert(removals == 1, "controlled rebind should remove only its owned callback")
    assert(registrations == 2, "controlled rebind should install one replacement")
    assert(runtime.callback_registered == true)
elseif scenario == "duplicate_request" then
    assert(type(registered_callback) == "function")
    local function exchange(raw)
        local f = assert(io.open("wh3_mcp_command.json", "w")); f:write(raw); f:close()
        registered_callback()
        local r = assert(io.open("wh3_mcp_result.json", "r")); local out = r:read("*a"); r:close()
        os.remove("wh3_mcp_result.json")
        return out
    end
    local hello = exchange('{"protocol":2,"session_id":"S1","request_id":1,"command":"__handshake","params":{}}')
    assert(hello:find('"status": "ok"'), hello)
    local first = exchange('{"protocol":2,"session_id":"S1","request_id":2,"command":"ping","params":{}}')
    local second = exchange('{"protocol":2,"session_id":"S1","request_id":2,"command":"ping","params":{}}')
    assert(first == second, "duplicate request must replay the cached reply byte-for-byte")
    local log = assert(io.open("wh3_mcp_debug.log", "r")):read("*a")
    local _, accepts = log:gsub("command_accept request=2 command=ping", "")
    assert(accepts == 1, "duplicate request dispatched more than once: " .. tostring(accepts))
elseif scenario == "context_not_ready" then
    assert(type(registered_callback) == "function")
    local function exchange(raw)
        local f = assert(io.open("wh3_mcp_command.json", "w")); f:write(raw); f:close()
        registered_callback()
        local r = assert(io.open("wh3_mcp_result.json", "r")); local out = r:read("*a"); r:close()
        os.remove("wh3_mcp_result.json")
        return out
    end
    local blocked = exchange('{"protocol":2,"session_id":"S1","request_id":6,"command":"ping","params":{}}')
    assert(blocked:find('"code": "NOT_READY"'), blocked)
    local hello = exchange('{"protocol":2,"session_id":"S1","request_id":7,"command":"__handshake","params":{}}')
    assert(hello:find('"status": "ok"'), hello)
    local ping = exchange('{"protocol":2,"session_id":"S1","request_id":8,"command":"ping","params":{}}')
    assert(ping:find('"pong": true'), ping)
elseif scenario == "invalid_protocol" then
    assert(type(registered_callback) == "function")
    local f = assert(io.open("wh3_mcp_command.json", "w"))
    f:write('{"protocol":1,"session_id":"S1","request_id":1,"command":"__handshake","params":{}}')
    f:close()
    registered_callback()
    local r = assert(io.open("wh3_mcp_result.json", "r")); local out = r:read("*a"); r:close()
    assert(out:find('"code": "PROTOCOL_MISMATCH"'), out)
elseif scenario == "older_session" then
    assert(type(registered_callback) == "function")
    local function exchange(raw)
        local f = assert(io.open("wh3_mcp_command.json", "w")); f:write(raw); f:close()
        registered_callback()
        local r = assert(io.open("wh3_mcp_result.json", "r")); local out = r:read("*a"); r:close()
        os.remove("wh3_mcp_result.json")
        return out
    end
    local newer = exchange('{"protocol":2,"session_id":"S-new","request_id":1,"command":"__handshake","params":{"server_started_at_ms":200}}')
    assert(newer:find('"status": "ok"'), newer)
    local older = exchange('{"protocol":2,"session_id":"S-old","request_id":1,"command":"__handshake","params":{"server_started_at_ms":100}}')
    assert(older:find('"code": "STALE_RESPONSE"'), older)
end

print("PASS " .. scenario .. " registrations=" .. registrations .. " removals=" .. removals)
