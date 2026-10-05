// The panel's button catalog. The bridge sends it to the panel when it
// connects (LuaEvents.AICivCopilot_Buttons("tabs", TABS)), so a new button
// appears in game as soon as the bridge restarts - no game reload. The
// panel's own TABS table is the offline fallback and keeps the local toggles.
// needs: "city" or "unit" = requires that selection; confirm = click twice.

export const TABS = [
  {
    key: "info", label: "Info",
    buttons: [
      { key: "plan_turn", label: "Plan my turn", tip: "Free: everything to do this turn, most urgent first - from the game's own advisor, combat preview and boosts" },
      { key: "overview", label: "Overview", tip: "Gold, science, culture, faith, research and civic at a glance" },
      { key: "production", label: "Production", tip: "What every city builds; idle, crowded and unhappy cities" },
      { key: "threats", label: "Threats", tip: "Visible foreign military near your territory, hostile first" },
      { key: "idle", label: "Idle units", tip: "Units waiting for orders" },
      { key: "rivals", label: "Rivals", tip: "Score, cities, military and techs of every civ you have met" },
      { key: "turnbrief", label: "Turn brief", tip: "What needs your attention this turn" },
      { key: "resources", label: "Resources", tip: "Strategic and luxury resources you have" },
      { key: "researchqueue", label: "Research queue", tip: "Current research and civic, and what is queued after them" },
      { key: "recent", label: "Recent changes", tip: "The last changes the copilot made to the game" },
      { key: "standing", label: "Victory standing", tip: "Where you and every known civ stand on each road to victory" },
      { key: "events", label: "What happened", tip: "Events this turn and last: research, cities, wars, deals, notifications" },
      { key: "situation", label: "Diplomacy", tip: "Wars, deals on the table, and how every civ you have met feels about you and why" },
      { key: "game_advisor", label: "Game's advice", tip: "Free: what the game's own advisor recommends - research, civics, builds, city sites, builders" },
      { key: "eurekas", label: "Eurekas", tip: "Free: the next research and civic boosts and exactly how to trigger them" },
      { key: "great_people", label: "Great people", tip: "Free: who is available, their cost, your points, and what each does" },
      { key: "city_states", label: "City-states", tip: "Free: envoys to send, suzerains, and the trade deals in force" },
    ],
  },
  {
    key: "city", label: "City",
    buttons: [
      { key: "city_details", label: "City details", needs: "city", tip: "Everything about the selected city" },
      { key: "city_ai", label: "What to build?", needs: "city", tip: "The AI picks production for the selected city" },
      { key: "city_advice", label: "Game's pick", needs: "city", tip: "Free: what the game's own advisor recommends this city builds, with scores" },
      { key: "district_spots", label: "District spots", needs: "city", tip: "Free: the best tile for each district this city can place, by adjacency bonus" },
      { key: "finish_production", label: "Finish build", needs: "city", tip: "Complete the selected city's current production now" },
      { key: "pop_up", label: "+1 Citizen", needs: "city", tip: "Add a citizen to the selected city" },
      { key: "pop_down", label: "-1 Citizen", needs: "city", tip: "Remove a citizen from the selected city" },
      { key: "city_tiles", label: "Tiles around", needs: "city", tip: "Terrain, resources and units around the selected city" },
      { key: "look_city", label: "Look at city", needs: "city", tip: "Move the camera to the selected city" },
    ],
  },
  {
    key: "unit", label: "Unit", dynamic: "unitops", dynamicTitle: "Available now:",
    buttons: [
      { key: "unit_ops", label: "What can it do?", needs: "unit", tip: "List what the selected unit can do right now, as buttons" },
      { key: "unit_ai", label: "Use it well", needs: "unit", tip: "The AI suggests (and can carry out) the best use of this unit" },
      { key: "builder_advice", label: "Builder advice", needs: "unit", tip: "Free: the game's recommended improvements for the selected builder" },
      { key: "attack_odds", label: "Attack odds", needs: "unit", tip: "Free: the game's combat preview against every visible enemy within 6 tiles" },
      { key: "heal", label: "Full heal", needs: "unit", tip: "Restore the selected unit to full health" },
      { key: "moves", label: "Restore moves", needs: "unit", tip: "Give the selected unit its movement and attacks back" },
      { key: "xp", label: "+50 XP", needs: "unit", tip: "Give the selected unit 50 experience" },
      { key: "fortify", label: "Fortify", needs: "unit", tip: "Fortify the selected unit" },
      { key: "sleep", label: "Sleep", needs: "unit", tip: "Put the selected unit to sleep" },
      { key: "skip", label: "Skip turn", needs: "unit", tip: "Skip the selected unit's turn" },
      { key: "kill", label: "Remove unit", needs: "unit", confirm: true, tip: "Remove the selected unit (click twice)" },
      { key: "look_unit", label: "Look at unit", needs: "unit", tip: "Move the camera to the selected unit" },
    ],
  },
  {
    key: "empire", label: "Empire",
    buttons: [
      { key: "gold_100", label: "+100 Gold", tip: "Add 100 gold" },
      { key: "gold_1000", label: "+1000 Gold", tip: "Add 1000 gold" },
      { key: "gold_m100", label: "-100 Gold", tip: "Remove 100 gold" },
      { key: "faith_100", label: "+100 Faith", tip: "Add 100 faith" },
      { key: "faith_1000", label: "+1000 Faith", tip: "Add 1000 faith" },
      { key: "finish_research", label: "Finish research", tip: "Complete the current research" },
      { key: "finish_civic", label: "Finish civic", tip: "Complete the current civic" },
      { key: "end_turn", label: "End turn", confirm: true, tip: "End the turn (click twice)" },
    ],
  },
  {
    key: "map", label: "Map",
    buttons: [
      { key: "spawn_settler", label: "Spawn Settler", tip: "Create a Settler at the selected unit or city" },
      { key: "spawn_builder", label: "Spawn Builder", tip: "Create a Builder at the selected unit or city" },
      { key: "spawn_trader", label: "Spawn Trader", tip: "Create a Trader at the selected unit or city" },
      { key: "spawn_scout", label: "Spawn Scout", tip: "Create a Scout at the selected unit or city" },
      { key: "spawn_warrior", label: "Spawn Warrior", tip: "Create a Warrior at the selected unit or city" },
      { key: "tile_info", label: "Tile info", tip: "What is on the selected unit's or city's tile" },
      { key: "settle_spots", label: "Settle spots", tip: "Free: the game's best city sites, with its reasons for and against" },
      { key: "reveal_map", label: "Reveal map", confirm: true, tip: "Reveal the whole map (click twice; cannot be undone)" },
    ],
  },
  {
    key: "ai", label: "Ask AI",
    buttons: [
      { key: "strategy_ai", label: "Best strategy", tip: "The AI picks your road to victory and the next moves, from your standing and trends" },
      { key: "advise", label: "Advise me", tip: "The AI reviews your empire and says what to do next" },
      { key: "build_ai", label: "Plan production", tip: "The AI picks production for every city" },
      { key: "research_ai", label: "Plan research", tip: "The AI plans your next techs" },
      { key: "civic_ai", label: "Plan civics", tip: "The AI plans your next civics and policies" },
      { key: "expand_ai", label: "Where to settle", tip: "The AI looks for good city sites" },
      { key: "war_ai", label: "War check", tip: "The AI assesses threats and your defences" },
      { key: "economy_ai", label: "Fix my economy", tip: "The AI looks at gold, amenities, housing and trade" },
      { key: "explore_ai", label: "Learn a skill", tip: "The AI discovers a new game function and saves it as an ability" },
    ],
  },
  {
    key: "dig", label: "Dig",
    buttons: [
      { key: "dig_map", label: "Map the API", tip: "Free: map every game function against Firaxis' own scripts and find what can be changed" },
      { key: "dig_probe", label: "Probe getters", tip: "Free, read-only: call safe getters live and record what they return" },
      { key: "dig_frontier", label: "Frontier", tip: "The next features worth unlocking" },
      { key: "dig_status", label: "Dig status", tip: "How far the digging has got" },
      { key: "dig_ai", label: "Dig deeper", tip: "AI: prove one new game function and save it as an ability" },
      { key: "dig3_ai", label: "Dig x3", tip: "AI: unlock three new features" },
    ],
  },
  {
    key: "abilities", label: "Skills", dynamic: "abilities", dynamicTitle: "Saved abilities:",
    buttons: [
      { key: "abilities_list", label: "Refresh list", tip: "Reload the copilot's saved abilities" },
    ],
  },
];
