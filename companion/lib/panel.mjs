// What each in-game panel button does.
//
// The panel sends { kind: "quick", key, sel } where sel is what the player
// has selected in the game (cityId/cityOwner/cityName, unitId/unitOwner/
// unitType/unitName, x/y). Every key maps to exactly one handler here:
//   info    answered from the game's own numbers (solvers, reads) - instant,
//           no AI, no cost
//   action  a typed action (performAction) on the selection - confirmed by
//           the game's read-back
//   ai      a preset question for the model, with the selection in it
//   buttons a dynamic button list sent back to the panel (unit operations,
//           saved abilities)
// Handlers return { text, kind?, buttons? }.

import { performAction } from "./actions.mjs";
import * as solve from "./solvers.mjs";
import { UI_STATE } from "./game.mjs";
import * as dig from "./discovery.mjs";
import { analyzeStanding, formatStanding } from "./strategy.mjs";
import { formatEvents, formatSituation } from "./events.mjs";

const r1 = (n) => (typeof n === "number" ? Math.round(n * 10) / 10 : n);
const pretty = (t) =>
  String(t || "?")
    .replace(/^(UNIT|BUILDING|DISTRICT|PROJECT|TECH|CIVIC|RESOURCE|UNITOPERATION|UNITCOMMAND|IMPROVEMENT|FEATURE|TERRAIN|CIVILIZATION|GOVERNMENT|POLICY)_/, "")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
const signed = (n) => (n >= 0 ? `+${r1(n)}` : `${r1(n)}`);

// ------------------------------------------------------------ formatting
export function formatOverview(snap) {
  const s = solve.empireSummary(snap);
  const lines = [
    `${s.civ} (${s.leader}), turn ${s.turn}, ${pretty(s.era)}. Score ${s.score}.`,
    `Gold ${r1(s.gold)} (${signed(s.goldPerTurn)}/turn)  Faith ${r1(s.faith)} (${signed(s.faithPerTurn)})`,
    `Science ${r1(s.sciencePerTurn)}/turn  Culture ${r1(s.culturePerTurn)}/turn${s.favor != null ? `  Favor ${s.favor}` : ""}`,
    `Researching: ${s.researching ? `${pretty(s.researching.type)} (${s.researching.turns} turns)` : "nothing"}`,
    `Civic: ${s.civic ? `${pretty(s.civic.type)} (${s.civic.turns} turns)` : "nothing"}`,
    `${s.cityCount} cities, ${s.population} citizens, ${s.unitCount} units. Government: ${pretty(s.government)}.`,
  ];
  if (s.eraScore != null) lines.push(`Era score ${s.eraScore} (dark age below ${s.darkAgeThreshold}, golden at ${s.goldenAgeThreshold}).`);
  return lines.join("\n");
}

export function formatProduction(snap) {
  const p = solve.productionOverview(snap);
  const lines = p.cities.map((c) => `- ${c.name}: ${c.building ? `${pretty(c.building)} (${c.turnsLeft} turns)` : "IDLE"}, pop ${c.population}, prod ${c.production}`);
  if (p.idle.length) lines.push(`Idle: ${p.idle.join(", ")}`);
  if (p.housingCapped.length) lines.push(`Out of housing: ${p.housingCapped.join(", ")}`);
  if (p.unhappy.length) lines.push(`Short of amenities: ${p.unhappy.join(", ")}`);
  return lines.join("\n") || "No cities.";
}

export function formatThreats(snap) {
  const t = solve.threatReport(snap);
  const lines = [`At war with: ${t.atWarWith.length ? t.atWarWith.join(", ") : "nobody"}.`];
  if (!t.threats.length) lines.push("No foreign military units visible near your territory.");
  for (const u of t.threats.slice(0, 10)) {
    lines.push(`- ${u.hostile ? "HOSTILE " : ""}${pretty(u.type)} (${u.ownerName}) at (${u.x},${u.y}), ${u.nearestCity ? `${u.nearestCity.distance} from ${u.nearestCity.name}` : ""}, ${u.hp} hp`);
  }
  lines.push("Only units you can see; fogged units are unknown.");
  return lines.join("\n");
}

export function formatIdle(snap) {
  const r = solve.findUnits(snap, { idleOnly: true });
  if (!r.count) return "No units are waiting for orders.";
  return [`${r.count} unit(s) waiting for orders:`, ...r.units.map((u) => `- ${pretty(u.type)} at (${u.x},${u.y}), ${u.moves} moves`)].join("\n");
}

export function formatRivals(snap) {
  const r = solve.rivalComparison(snap);
  return r.ranking
    .map((p, i) => `${i + 1}. ${p.civ}${p.me ? " (you)" : ""}: score ${p.score}, ${p.cities ?? "?"} cities, military ${p.militaryStrength ?? "?"}, ${p.techs ?? "?"} techs${p.atWar ? ", AT WAR" : ""}`)
    .join("\n");
}

export function formatTurnBrief(snap) {
  const s = solve.empireSummary(snap);
  const p = solve.productionOverview(snap);
  const t = solve.threatReport(snap);
  const idle = solve.findUnits(snap, { idleOnly: true });
  const lines = [`Turn ${s.turn}: gold ${r1(s.gold)} (${signed(s.goldPerTurn)}), science ${r1(s.sciencePerTurn)}, culture ${r1(s.culturePerTurn)}.`];
  if (!s.researching) lines.push("! Nothing is being researched.");
  else if (s.researching.turns <= 1) lines.push(`Research: ${pretty(s.researching.type)} finishes this turn.`);
  if (!s.civic) lines.push("! No civic in progress.");
  if (p.idle.length) lines.push(`! Idle cities: ${p.idle.join(", ")}.`);
  if (p.housingCapped.length) lines.push(`Housing full: ${p.housingCapped.join(", ")}.`);
  if (p.unhappy.length) lines.push(`Short of amenities: ${p.unhappy.join(", ")}.`);
  if (t.hostileCount) lines.push(`! ${t.hostileCount} hostile unit(s) in sight.`);
  if (idle.count) lines.push(`${idle.count} unit(s) need orders.`);
  if (s.goldPerTurn < 0) lines.push("! Gold per turn is negative.");
  if (lines.length === 1) lines.push("Nothing urgent.");
  return lines.join("\n");
}

// The game's own advisor (advisor.lua), for the selection or the empire.
export function formatAdvisor(a, { cityId, settleOnly, builderId } = {}) {
  if (!a || a.error) return `The game's advisor is not readable: ${a?.error || "no data"}`;
  const lines = [];
  if (!settleOnly && builderId === undefined) {
    if (a.techs) lines.push(`Research: ${a.techs.length ? a.techs.map((t) => `${t.name} (${t.score})`).join(", ") : "no recommendation"}.`);
    if (a.civics) lines.push(`Civics: ${a.civics.length ? a.civics.map((t) => `${t.name} (${t.score})`).join(", ") : "no recommendation"}.`);
    for (const c of a.cities || []) {
      if (cityId !== undefined && c.id !== cityId) continue;
      lines.push(`${c.name} should build: ${c.recommended?.length ? c.recommended.map((r) => `${r.name} (${r.score})`).join(", ") : "no recommendation"}.`);
    }
  }
  if (a.settle && builderId === undefined && cityId === undefined) {
    if (!a.settle.length) lines.push("No recommended city sites right now.");
    a.settle.forEach((s, i) => {
      lines.push(`City site ${i + 1}: (${s.x},${s.y})`);
      if (s.pros?.length) lines.push(`  + ${s.pros.join("; ")}`);
      if (s.cons?.length) lines.push(`  - ${s.cons.join("; ")}`);
    });
  }
  for (const b of a.builders || []) {
    if (builderId !== undefined && b.id !== builderId) continue;
    if (cityId !== undefined || settleOnly) continue;
    lines.push(`Builder at (${b.x},${b.y})${b.city ? ` near ${b.city}` : ""}, ${b.charges} charges: ${b.recommended?.length ? b.recommended.map((r) => `${r.name} at (${r.x},${r.y})`).join(", ") : "no recommendation (move it inside a city's borders)"}.`);
  }
  if (!lines.length) lines.push("The game has no recommendation for this.");
  lines.push("(The game's own advisor - engine scores, not the AI.)");
  return lines.join("\n");
}

export function formatCombat(c) {
  if (!c || c.error) return `Attack odds: ${c?.error || "no data"}.`;
  const a = c.attacker;
  const head = `${pretty(a.type)} (${a.hp} hp, ${a.moves} moves, ${a.attacks} attack${a.attacks === 1 ? "" : "s"} left), ${c.mode}:`;
  if (!c.results?.length) return `${head}\nNo visible enemy combat units within range.`;
  const lines = [head];
  for (const r of c.results.slice(0, 8)) {
    const outcome = r.kills ? "KILLS it" : r.dies ? "YOUR UNIT DIES" : `it ends at ${r.defenderHpAfter} hp, you at ${r.attackerHpAfter} hp`;
    lines.push(`- ${pretty(r.type)} (${r.owner || `player ${r.player}`}) at (${r.x},${r.y}), ${r.distance} away: ${r.attackerStrength} vs ${r.defenderStrength}, deal ${r.damageToDefender} / take ${r.damageToAttacker} - ${outcome}${r.canAttackNow ? " [can attack now]" : ""}`);
  }
  lines.push("(The game's own combat preview; actual results vary a little.)");
  return lines.join("\n");
}

// Game text carries icon and colour markup ([ICON_Citizen], [COLOR_..]).
const untag = (t) => String(t ?? "").replace(/\[(ICON|COLOR|ENDCOLOR|NEWLINE)[^\]]*\]/g, (m) => (m.startsWith("[NEWLINE") ? " " : "")).replace(/\s+/g, " ").trim();

export function formatBoosts(p) {
  const b = p?.boosts;
  if (!b) return `Eurekas: ${p?.error || "not readable"}.`;
  const line = (x) => `- ${x.name}${x.available ? " (available now)" : ""}: ${untag(x.how)}`;
  const lines = ["Next eurekas (research boosts), cheapest first:", ...b.techs.slice(0, 8).map(line)];
  lines.push("Next inspirations (civic boosts):", ...b.civics.slice(0, 6).map(line));
  return lines.join("\n");
}

export function formatGreatPeople(p) {
  const list = p?.greatPeople;
  if (!list) return `Great people: ${p?.error || "not readable"}.`;
  if (!list.length) return "No great people on the timeline yet.";
  return list.map((g) => {
    const cls = pretty(String(g.class || "").replace(/^GREAT_PERSON_CLASS_/, ""));
    const buy = [g.goldCost ? `${g.goldCost} gold` : null, g.faithCost ? `${g.faithCost} faith` : null].filter(Boolean).join(" or ");
    const mine = g.myPoints != null ? `, you have ${Math.round(g.myPoints)} (+${Math.round((g.myPointsPerTurn || 0) * 10) / 10}/turn)` : "";
    return `- ${cls}: ${g.person || "?"}, needs ${g.cost} points${mine}${g.claimedBy ? `, taken by ${g.claimedBy}` : ""}${buy ? `; buy for ${buy}` : ""}${g.canRecruit ? " - YOU CAN RECRUIT NOW" : ""}${g.does ? `. ${untag(g.does)}` : ""}`;
  }).join("\n");
}

export function formatEnvoys(p) {
  const e = p?.envoys;
  if (!e) return `City-states: ${p?.error || "not readable"}.`;
  const lines = [`Envoys to send: ${e.toGive} (+${Math.round((e.pointsPerTurn || 0) * 10) / 10} influence/turn).`];
  if (!e.cityStates.length) lines.push("You have not met any city-states yet.");
  for (const c of e.cityStates) lines.push(`- ${c.name}: your envoys ${c.myEnvoys}, suzerain ${c.iAmSuzerain ? "YOU" : c.suzerain || "nobody"}`);
  if (p.deals?.length) {
    lines.push("Deals in force:");
    for (const d of p.deals) lines.push(`- with ${d.with}: ${d.from} give ${d.what}${d.turnsLeft != null ? `, ${d.turnsLeft} turns left` : ""}`);
  }
  return lines.join("\n");
}

export function formatDistricts(d) {
  if (!d || d.error) return `District spots: ${d?.error || "no data"}.`;
  if (!d.districts.length) return `${d.city} cannot place any district right now.`;
  const lines = [`${d.city} - best district spots (adjacency bonus):`];
  for (const x of d.districts) {
    const b = x.best[0];
    const bonus = b && b.total ? Object.entries(b.bonus).map(([k, v]) => `+${v} ${pretty(k.replace(/^YIELD_/, ""))}`).join(" ") : "no bonus anywhere";
    lines.push(`- ${x.name}: (${b?.x},${b?.y}) ${bonus}${x.best[1]?.total ? `; next (${x.best[1].x},${x.best[1].y}) +${x.best[1].total}` : ""}`);
  }
  return lines.join("\n");
}

export function formatResources(snap) {
  const res = snap.resources || [];
  if (!res.length) return "No strategic or luxury resources.";
  return res.map((r) => `- ${pretty(r.type)}: ${r.amount}${r.cap ? ` / ${r.cap}` : ""} (${r.class === "RESOURCECLASS_LUXURY" ? "luxury" : "strategic"})`).join("\n");
}

export function formatCity(c) {
  if (!c) return "That city is not in the snapshot.";
  const y = c.yields || {};
  const lines = [
    `${c.name}${c.capital ? " (capital)" : ""} at (${c.x},${c.y}), population ${c.population}.`,
    `Food ${r1(y.FOOD)} Prod ${r1(y.PRODUCTION)} Gold ${r1(y.GOLD)} Sci ${r1(y.SCIENCE)} Cul ${r1(y.CULTURE)} Faith ${r1(y.FAITH)}`,
    `Building: ${c.production?.item ? `${pretty(c.production.item)} (${c.production.turnsLeft} turns)` : "nothing"}.`,
    `Housing ${c.housing}, amenities ${c.amenities}/${c.amenitiesNeeded}, grows in ${c.turnsToGrow} turns.`,
    `Districts: ${(c.districts || []).filter((d) => d.type !== "DISTRICT_CITY_CENTER").map((d) => pretty(d.type)).join(", ") || "none"}.`,
    `Buildings: ${(c.buildings || []).map(pretty).join(", ") || "none"}.`,
  ];
  const quick = (c.canProduce || []).slice().sort((a, b) => a.turns - b.turns).slice(0, 6);
  if (quick.length) lines.push(`Quickest to build: ${quick.map((q) => `${pretty(q.type)} ${q.turns}t`).join(", ")}.`);
  return lines.join("\n");
}

export function formatTiles(t) {
  if (!t || t.error) return `Cannot read tiles: ${t?.error || "no data"}`;
  const tiles = t.tiles || [];
  const resources = tiles.filter((x) => x.resource).map((x) => `${pretty(x.resource)} (${x.x},${x.y})${x.improvement ? "" : " unimproved"}`);
  const units = tiles.flatMap((x) => (x.units || []).map((u) => `${pretty(u.type)} p${u.owner} (${x.x},${x.y})`));
  if (tiles.length === 1) {
    const x = tiles[0];
    return [
      `(${x.x},${x.y}): ${pretty(x.terrain)}${x.hills ? " hills" : ""}${x.feature ? `, ${pretty(x.feature)}` : ""}${x.river ? ", river" : ""}.`,
      `${x.resource ? `Resource ${pretty(x.resource)}. ` : ""}${x.improvement ? `Improvement ${pretty(x.improvement)}. ` : ""}${x.district ? `District ${pretty(x.district)}. ` : ""}Owner ${x.owner}. Appeal ${x.appeal}.`,
      `Yields: ${Object.entries(x.yields || {}).filter(([, v]) => v).map(([k, v]) => `${pretty(k)} ${v}`).join(", ") || "none"}.`,
      units.length ? `Units: ${units.join(", ")}.` : "",
    ].filter(Boolean).join("\n");
  }
  return [
    `${tiles.length} tiles within ${t.radius} of (${t.center?.[0]},${t.center?.[1]}).`,
    `Resources: ${resources.join(", ") || "none"}.`,
    `Units: ${units.join(", ") || "none visible"}.`,
  ].join("\n");
}

// One line for any typed action result.
export function formatAction(label, r) {
  if (!r) return `${label}: no answer from the game.`;
  if (!r.ok) {
    const why = r.reason || r.verified?.reason || "the game did not confirm it";
    const extra = r.failureReasons?.length ? ` (${r.failureReasons.join("; ")})` : "";
    return `${label}: not done - ${why}${extra}.`;
  }
  const v = r.verified || {};
  const parts = [];
  if (r.before !== undefined && r.after !== undefined && typeof r.before !== "object") parts.push(`${r1(r.before)} -> ${r1(r.after)}`);
  if (r.damageBefore !== undefined) parts.push(`damage ${r.damageBefore} -> ${r.damageAfter}`);
  if (r.unitId !== undefined && r.at) parts.push(`new unit ${r.unitId} at (${r.at[0]},${r.at[1]})`);
  if (r.completedNow === false) parts.push("completes when the game next processes it");
  if (v.turnNow !== undefined) parts.push(`now turn ${v.turnNow}`);
  if (v.enRoute) parts.push("en route");
  if (r.killed) parts.push(`${pretty(r.killed)} removed`);
  return `${label}: done${parts.length ? ` (${parts.join(", ")})` : ""}.`;
}

// ------------------------------------------------------------ AI prompts
function selText(sel = {}) {
  const parts = [];
  if (sel.cityId !== undefined) parts.push(`city ${sel.cityName} (id ${sel.cityId}, owner ${sel.cityOwner})`);
  if (sel.unitId !== undefined) parts.push(`unit ${sel.unitName} ${sel.unitType} (id ${sel.unitId}, owner ${sel.unitOwner}) at (${sel.x},${sel.y})`);
  return parts.length ? `The player has selected: ${parts.join("; ")}.` : "";
}

export const AI_PROMPTS = {
  advise: () => "Advise me: look at what is happening right now and in the last turns. If anything needs a decision (a deal on the table, a war, an army near my cities, a city in trouble), give me the best plan of action for it first. Then the 3-5 most valuable things to do this turn, most important first. Be concrete (city, unit, item names). Do not change anything unless I ask.",
  situation_ai: () => "Something just happened that needs a decision (see Right now and Recent events: a deal offered, or war declared on me). Tell me the best response: for a deal, accept / reject / counter (with the exact change) and why, using my real numbers; for a war, which cities are in danger, how strong they are against me, and my plan for the next 3 turns. Keep it short and decisive. Do not change anything unless I ask.",
  turnadvice: () => "New turn. In at most 6 short lines: anything that needs a decision now first, then the best moves this turn (research, production, units, diplomacy). Only what matters this turn. Do not change anything.",
  build_ai: () => "For each of my cities, recommend what to build next and why, in one line per city. Then ask whether to set them.",
  research_ai: () => "Plan my next 5 techs: in order, with a one-line reason each and the turns from research_path. Ask before changing my research.",
  civic_ai: () => "Plan my next 3 civics and say which policies I should slot now and why. Ask before changing anything.",
  expand_ai: () => "Where should I settle my next cities? Look at the map around my territory with get_tiles and suggest up to 3 sites with coordinates and reasons.",
  war_ai: () => "Assess my military situation: threats, how defended each city is, and what I should build or move. Be specific.",
  economy_ai: () => "Look at my gold per turn, amenities, housing and trade routes and tell me the best fixes.",
  explore_ai: () => "Discover one useful game function you cannot use yet (search_api, search_game_scripts, inspect_api), prove it with a read-only probe, and save it as an ability with save_ability. Tell me what you added.",
  dig_ai: () => "Dig: call dig_frontier, take the highest-leverage write you can safely prove, read its Firaxis call sites, prove it with a small revertible run_lua (read, change, read, revert, read), save it with save_ability (description says what it does and that it was verified live), and dig_mark it. If it cannot be done safely, dig_mark it blocked with the reason and try the next one. Report the new feature in two lines.",
  dig3_ai: () => "Dig three times: repeat the dig procedure (dig_frontier -> read call sites -> revertible proof -> save_ability -> dig_mark) for three different frontier items, preferring different objects (unit, city, player). Report each new feature in one line.",
  strategy_ai: () => "What is my best strategy to win from here? Use victory_standing and standing_trends, then the solvers. Name the road to victory, why it beats the others for me now, the rival to watch, and the next 5 concrete moves (cities, units, research, civics, policies). Do not change anything.",
  city_ai: (sel) => `${selText(sel)} What should this city build next, and why? Give the top 3 options with turns. Ask before setting it.`,
  unit_ai: (sel) => `${selText(sel)} What is the best use of this unit right now? Use unit_actions to see what it can do. Suggest the action and ask before doing it.`,
};

// ------------------------------------------------------------ handlers
const need = (sel, what) => (what === "city" ? sel?.cityId !== undefined : sel?.unitId !== undefined);
// Edits take an owner; play actions act for the local player (the only one
// whose cities and units the player can select), so they take just the id.
const cityArgs = (sel) => ({ cityId: sel.cityId, playerId: sel.cityOwner });
const unitArgs = (sel) => ({ unitId: sel.unitId, playerId: sel.unitOwner });
const unitPlay = (sel) => ({ unitId: sel.unitId });

function spawnAt(snap, sel) {
  if (sel?.x !== undefined && sel?.y !== undefined) return { x: sel.x, y: sel.y };
  const cap = (snap.cities || []).find((c) => c.capital) || (snap.cities || [])[0];
  return cap ? { x: cap.x, y: cap.y } : null;
}

const RESEARCH_QUEUE_LUA = `
local me = Game.GetLocalPlayer()
local te, cu = Players[me]:GetTechs(), Players[me]:GetCulture()
local function list(q, tbl, key)
  local items, out = {}, {}
  if type(q) == 'table' then for i, v in pairs(q) do items[#items + 1] = { i = i, v = v } end end
  table.sort(items, function(a, b) return a.i < b.i end)
  for _, e in ipairs(items) do local r = GameInfo[tbl][e.v]; out[#out + 1] = r and r[key] or e.v end
  return out
end
emitJson({ techs = list(te:GetResearchQueue(), 'Technologies', 'TechnologyType'), civics = list(cu:GetCivicQueue(), 'Civics', 'CivicType') })
`;

function action(label, name, args) {
  return async (ctx) => {
    ctx.onProgress?.(`${label}...`);
    const r = await performAction(ctx.game, name, args, { journal: ctx.memory });
    ctx.markStale();
    return { text: formatAction(label, r) };
  };
}

// key -> { needs?, run(ctx, sel, snap) }
export const HANDLERS = {
  overview: { run: async (ctx) => ({ text: formatOverview(await ctx.snapshot()) }) },
  production: { run: async (ctx) => ({ text: formatProduction(await ctx.snapshot()) }) },
  threats: { run: async (ctx) => ({ text: formatThreats(await ctx.snapshot()) }) },
  idle: { run: async (ctx) => ({ text: formatIdle(await ctx.snapshot()) }) },
  rivals: { run: async (ctx) => ({ text: formatRivals(await ctx.snapshot()) }) },
  turnbrief: { run: async (ctx) => ({ text: formatTurnBrief(await ctx.snapshot()) }) },
  resources: { run: async (ctx) => ({ text: formatResources(await ctx.snapshot()) }) },
  researchqueue: {
    run: async (ctx) => {
      const snap = await ctx.snapshot();
      const { value } = await ctx.game.lua(UI_STATE, RESEARCH_QUEUE_LUA);
      const me = snap.me || {};
      return {
        text: [
          `Research: ${me.researching ? `${pretty(me.researching.type)} (${me.researching.turns} turns)` : "nothing"}; then ${(value?.techs || []).filter((t) => t !== me.researching?.type).map(pretty).join(", ") || "nothing queued"}.`,
          `Civic: ${me.civic ? `${pretty(me.civic.type)} (${me.civic.turns} turns)` : "nothing"}; then ${(value?.civics || []).filter((t) => t !== me.civic?.type).map(pretty).join(", ") || "nothing queued"}.`,
        ].join("\n"),
      };
    },
  },
  recent: {
    run: async (ctx) => {
      const recent = ctx.memory.recentJournal(40).filter((e) => e.type === "action" || e.type === "ability" || e.type === "lua").slice(-10);
      if (!recent.length) return { text: "The copilot has not changed anything yet." };
      const describe = (e) => {
        if (e.type === "action") {
          const a = Object.entries(e.args || {}).map(([k, v]) => `${k} ${v}`).join(", ");
          return `${pretty(e.action)}${a ? ` (${a})` : ""}`;
        }
        if (e.type === "ability") return `ability ${pretty(e.name)}`;
        const first = String(e.code || "").split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("--")) || "";
        return `Lua in ${e.state}: ${first.slice(0, 60)}`;
      };
      return { text: recent.map((e) => `- ${e.at.slice(11, 16)} ${describe(e)}${e.ok === false ? " - not done" : ""}`).join("\n") };
    },
  },

  city_details: { needs: "city", run: async (ctx, sel) => ({ text: formatCity((await ctx.snapshot()).cities?.find((c) => c.id === sel.cityId)) }) },
  city_tiles: { needs: "city", run: async (ctx, sel) => ({ text: formatTiles(await ctx.game.tiles(sel.x, sel.y, 2)) }) },
  finish_production: { needs: "city", run: (ctx, sel) => action("Finish build", "finish_production", cityArgs(sel))(ctx) },
  pop_up: { needs: "city", run: (ctx, sel) => action("+1 Citizen", "change_population", { ...cityArgs(sel), delta: 1 })(ctx) },
  pop_down: { needs: "city", run: (ctx, sel) => action("-1 Citizen", "change_population", { ...cityArgs(sel), delta: -1 })(ctx) },
  look_city: { needs: "city", run: (ctx, sel) => action("Look at city", "look_at", { x: sel.x, y: sel.y })(ctx) },

  unit_ops: {
    needs: "unit",
    run: async (ctx, sel) => {
      const r = await performAction(ctx.game, "unit_actions", unitPlay(sel));
      if (!r.ok) return { text: `Cannot list actions: ${r.reason}` };
      const items = [
        ...(r.operations || []).map((op) => ({ key: `unitop:${op}`, label: pretty(op), tip: op })),
        ...(r.commands || []).map((c) => ({ key: `unitcmd:${c}`, label: pretty(c), tip: c, confirm: /DELETE|GIFT/.test(c) || undefined })),
      ];
      return {
        text: items.length ? `${sel.unitName} can do ${items.length} thing(s) now - see the buttons above.` : `${sel.unitName} cannot do anything right now.`,
        buttons: { group: "unitops", items },
      };
    },
  },
  heal: { needs: "unit", run: (ctx, sel) => action("Full heal", "heal_unit", { ...unitArgs(sel), damage: 0 })(ctx) },
  moves: { needs: "unit", run: (ctx, sel) => action("Restore moves", "restore_moves", unitArgs(sel))(ctx) },
  xp: { needs: "unit", run: (ctx, sel) => action("+50 XP", "add_experience", { ...unitArgs(sel), amount: 50 })(ctx) },
  fortify: { needs: "unit", run: (ctx, sel) => action("Fortify", "unit_operation", { ...unitPlay(sel), operation: "UNITOPERATION_FORTIFY" })(ctx) },
  sleep: { needs: "unit", run: (ctx, sel) => action("Sleep", "unit_operation", { ...unitPlay(sel), operation: "UNITOPERATION_SLEEP" })(ctx) },
  skip: { needs: "unit", run: (ctx, sel) => action("Skip turn", "unit_operation", { ...unitPlay(sel), operation: "UNITOPERATION_SKIP_TURN" })(ctx) },
  kill: { needs: "unit", run: (ctx, sel) => action("Remove unit", "kill_unit", unitArgs(sel))(ctx) },
  look_unit: { needs: "unit", run: (ctx, sel) => action("Look at unit", "look_at", { x: sel.x, y: sel.y })(ctx) },

  gold_100: { run: (ctx) => action("+100 Gold", "change_gold", { amount: 100 })(ctx) },
  gold_1000: { run: (ctx) => action("+1000 Gold", "change_gold", { amount: 1000 })(ctx) },
  gold_m100: { run: (ctx) => action("-100 Gold", "change_gold", { amount: -100 })(ctx) },
  faith_100: { run: (ctx) => action("+100 Faith", "change_faith", { amount: 100 })(ctx) },
  faith_1000: { run: (ctx) => action("+1000 Faith", "change_faith", { amount: 1000 })(ctx) },
  finish_research: {
    run: async (ctx) => {
      const t = (await ctx.snapshot()).me?.researching?.type;
      if (!t) return { text: "Finish research: nothing is being researched." };
      return action(`Finish research (${pretty(t)})`, "grant_tech", { tech: t })(ctx);
    },
  },
  finish_civic: {
    run: async (ctx) => {
      const c = (await ctx.snapshot()).me?.civic?.type;
      if (!c) return { text: "Finish civic: no civic in progress." };
      return action(`Finish civic (${pretty(c)})`, "grant_civic", { civic: c })(ctx);
    },
  },
  end_turn: { run: (ctx) => action("End turn", "end_turn", {})(ctx) },

  ...Object.fromEntries(["settler", "builder", "trader", "scout", "warrior"].map((u) => [
    `spawn_${u}`,
    {
      run: async (ctx, sel) => {
        const at = spawnAt(await ctx.snapshot(), sel);
        if (!at) return { text: "Spawn: select a city or unit first (no cities found either)." };
        return action(`Spawn ${pretty(u)}`, "spawn_unit", { unitType: `UNIT_${u.toUpperCase()}`, x: at.x, y: at.y })(ctx);
      },
    },
  ])),
  tile_info: {
    run: async (ctx, sel) => {
      if (sel?.x === undefined) return { text: "Tile info: select a city or unit first." };
      return { text: formatTiles(await ctx.game.tiles(sel.x, sel.y, 0)) };
    },
  },
  reveal_map: { run: (ctx) => action("Reveal map", "reveal_map", {})(ctx) },

  events: {
    run: async (ctx) => {
      const events = ctx.memory.events.recent({ turns: 2, limit: 80 });
      let now = "";
      try {
        now = formatSituation(await ctx.game.situation());
      } catch (err) {
        now = `(situation not readable: ${err.message})`;
      }
      return { text: `${formatEvents(events)}\n\nNow:\n${now}` };
    },
  },
  situation: { run: async (ctx) => ({ text: formatSituation(await ctx.game.situation()) }) },
  game_advisor: { run: async (ctx) => ({ text: formatAdvisor(await ctx.game.advisor(["tech", "civic", "build", "settle", "builder"])) }) },
  city_advice: { needs: "city", run: async (ctx, sel) => ({ text: formatAdvisor(await ctx.game.advisor(["build"]), { cityId: sel.cityId }) }) },
  settle_spots: { run: async (ctx) => ({ text: formatAdvisor(await ctx.game.advisor(["settle"]), { settleOnly: true }) }) },
  eurekas: { run: async (ctx) => ({ text: formatBoosts(await ctx.game.planning(["boosts"])) }) },
  great_people: { run: async (ctx) => ({ text: formatGreatPeople(await ctx.game.planning(["greatpeople"])) }) },
  city_states: { run: async (ctx) => ({ text: formatEnvoys(await ctx.game.planning(["envoys", "deals"])) }) },
  district_spots: { needs: "city", run: async (ctx, sel) => ({ text: formatDistricts(await ctx.game.districts(sel.cityId)) }) },
  attack_odds: { needs: "unit", run: async (ctx, sel) => ({ text: formatCombat(await ctx.game.combat(sel.unitId, { radius: 6 })) }) },
  builder_advice: { needs: "unit", run: async (ctx, sel) => ({ text: formatAdvisor(await ctx.game.advisor(["builder"]), { builderId: sel.unitId }) }) },
  standing: {
    run: async (ctx) => {
      const s = await ctx.game.standing();
      ctx.memory.history.record(s);
      return { text: formatStanding(analyzeStanding(s)) };
    },
  },
  dig_map: {
    run: async (ctx) => {
      ctx.onProgress?.("Mapping the API...");
      const run = dig.mapApi(ctx.memory, ctx.files, ctx.memory.discovery);
      const s = dig.summary(ctx.memory.discovery);
      return { text: `Mapped ${s.total} functions in ${run.ms} ms: ${s.writes} can change the game (${s.writesWithEvidence} with Firaxis examples, ${s.writesInFiraxisCheatPanels} used in Firaxis' cheat panels). ${s.proven} proven so far. Next: Probe getters, or Dig deeper.` };
    },
  },
  dig_probe: {
    run: async (ctx) => {
      const r = await dig.probeBatch(ctx.game, ctx.memory.discovery, { limit: 120, onProgress: ctx.onProgress });
      if (!r.probed) return { text: `Probe: ${r.note}` };
      return { text: `Probed ${r.probed} getters live (${r.errors} refused a no-argument call). Probed so far: ${r.byStatus?.probed ?? 0} of ${r.total}.` };
    },
  },
  dig_frontier: {
    run: async (ctx) => {
      const f = dig.frontier(ctx.memory.discovery, { limit: 10 });
      if (!f.length) return { text: "The frontier is empty - run Map API first." };
      return { text: ["Next features to unlock (highest leverage first):", ...f.map((e) => `- ${e.holder}:${e.method} [${e.state === "InGame" ? "UI" : "core"}] ${e.contexts.includes("tuner") ? "(Firaxis cheat panel)" : ""}`)].join("\n") };
    },
  },
  dig_status: {
    run: async (ctx) => {
      const s = dig.summary(ctx.memory.discovery);
      const by = Object.entries(s.byStatus || {}).map(([k, v]) => `${k} ${v}`).join(", ");
      return { text: `Dig map: ${s.total} functions (${by}). ${s.writes} writers, ${s.writesWithEvidence} with Firaxis examples, ${s.proven} proven or saved, ${s.blocked} blocked. Abilities: ${ctx.memory.listAbilities().length}.` };
    },
  },
  abilities_list: {
    run: async (ctx) => {
      const items = abilityButtons(ctx.memory);
      return { text: items.length ? `${items.length} saved abilities - see the buttons above.` : "No saved abilities yet. Try Ask AI > Learn a skill.", buttons: { group: "abilities", items } };
    },
  },
};

export function abilityButtons(memory) {
  return memory.listAbilities().map((a) => ({
    key: `ability:${a.name}`,
    label: pretty(a.name).slice(0, 22),
    tip: `${a.description}${a.required?.length ? ` (uses the selection for: ${a.required.join(", ")})` : ""}`,
    confirm: a.kind && a.kind !== "query" ? true : undefined,
  }));
}

// Fill an ability's parameters from the selection.
function abilityParams(a, sel = {}) {
  const map = {
    cityId: sel.cityId, unitId: sel.unitId, x: sel.x, y: sel.y,
    playerId: sel.unitOwner ?? sel.cityOwner,
  };
  const params = {};
  for (const k of Object.keys(a.properties || {})) if (map[k] !== undefined) params[k] = map[k];
  const missing = (a.required || []).filter((k) => params[k] === undefined);
  return { params, missing };
}

// The one entry point the bridge calls for a panel button.
export async function handlePanelRequest(ctx, req, { ask } = {}) {
  const key = String(req.key || "");
  const sel = req.sel || {};

  if (AI_PROMPTS[key]) {
    if (!ask) return { kind: "error", text: "The AI is not available (no model client)." };
    if ((key === "city_ai" && !need(sel, "city")) || (key === "unit_ai" && !need(sel, "unit"))) {
      return { kind: "error", text: `Select a ${key === "city_ai" ? "city" : "unit"} in the game first.` };
    }
    const res = await ask(AI_PROMPTS[key](sel));
    return { text: res.answer };
  }

  if (key.startsWith("unitop:") || key.startsWith("unitcmd:")) {
    if (!need(sel, "unit")) return { kind: "error", text: "Select the unit in the game first." };
    const isOp = key.startsWith("unitop:");
    const name = key.slice(key.indexOf(":") + 1);
    return action(pretty(name), isOp ? "unit_operation" : "unit_command", { ...unitPlay(sel), [isOp ? "operation" : "command"]: name })(ctx);
  }

  if (key.startsWith("ability:")) {
    const a = ctx.memory.getAbility(key.slice("ability:".length));
    if (!a) return { kind: "error", text: "That ability no longer exists." };
    const { params, missing } = abilityParams(a, sel);
    if (missing.length) return { kind: "error", text: `${pretty(a.name)} needs: ${missing.join(", ")}. Select a city or unit, or ask the AI to run it.` };
    ctx.onProgress?.(`Running ${pretty(a.name)}...`);
    try {
      const { value, text } = await ctx.game.lua(a.state, a.lua, { params });
      ctx.memory.markAbilityUsed(a.name, !(value && value.ok === false));
      if (a.kind !== "query") ctx.markStale();
      const body = value !== undefined ? JSON.stringify(value, null, 1) : text.join("\n");
      return { text: `${pretty(a.name)}:\n${body.slice(0, 3000)}` };
    } catch (err) {
      return { kind: "error", text: `${pretty(a.name)} failed: ${err.message}` };
    }
  }

  const h = HANDLERS[key];
  if (!h) return { kind: "error", text: `Unknown button "${key}" - the panel and bridge versions may differ.` };
  if (h.needs && !need(sel, h.needs)) return { kind: "error", text: `Select a ${h.needs} in the game first.` };
  return h.run(ctx, sel);
}
