// A free turn plan: everything that needs doing this turn, most urgent first,
// built only from the game's own numbers and calculators - no AI call.
//
// Inputs (all read live): the snapshot, situation.lua (wars, deals, moods,
// end-turn blocker), advisor.lua (the game's Grand Strategic AI picks),
// planning.lua (eurekas, great people, envoys) and combat.lua (attack
// previews for units next to enemies).

import * as solve from "./solvers.mjs";

const pretty = (t) =>
  String(t || "?")
    .replace(/^(UNIT|BUILDING|DISTRICT|PROJECT|TECH|CIVIC|IMPROVEMENT|ENDTURN_BLOCKING|DIPLO_STATE)_/, "")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
const untag = (t) => String(t ?? "").replace(/\[(ICON|COLOR|ENDCOLOR)[^\]]*\]/g, "").replace(/\s+/g, " ").trim();

async function safe(fn) {
  try {
    return await fn();
  } catch (err) {
    return { error: err.message };
  }
}

// game: Game (situation/advisor/planning/combat); snap: a fresh snapshot.
export async function planTurn(game, snap) {
  const situation = await safe(() => game.situation());
  const advisor = await safe(() => game.advisor(["tech", "civic", "build", "settle", "builder"]));
  const planning = await safe(() => game.planning(["boosts", "greatpeople", "envoys"]));
  const wrap = snap.meta?.wrapX ? snap.meta.mapWidth || 0 : 0;

  const urgent = [];
  const todo = [];
  const tips = [];

  // 1. Decisions forced on the player.
  for (const d of situation.deals || []) urgent.push(`Deal from ${d.civ}: they give ${d.gives?.join(", ") || "nothing"}, ask ${d.asks?.join(", ") || "nothing"}. (Ask AI > Advise me for the best answer.)`);
  if (situation.wars?.length) urgent.push(`At war with ${situation.wars.join(", ")}.`);

  // 2. Threats and attacks: the engine's own combat preview for each of our
  // units that has a hostile unit within 2 tiles.
  const threats = solve.threatReport(snap);
  const hostile = threats.threats.filter((t) => t.hostile);
  for (const t of hostile.slice(0, 4)) {
    urgent.push(`${pretty(t.type)} (${t.ownerName}) at (${t.x},${t.y})${t.nearestCity ? `, ${t.nearestCity.distance} tiles from ${t.nearestCity.name}` : ""}.`);
  }
  const fighters = (snap.units || []).filter((u) => (u.combat > 0 || u.ranged > 0) && u.moves > 0);
  for (const u of fighters) {
    const near = hostile.filter((t) => solve.hexDistance(u.x, u.y, t.x, t.y, wrap) <= Math.max(2, u.range || 0));
    if (!near.length) continue;
    const c = await safe(() => game.combat(u.id, { targets: near.map((t) => ({ player: t.owner, id: t.id })) }));
    const best = (c.results || []).find((r) => r.canAttackNow && !r.dies && r.damageToDefender >= r.damageToAttacker);
    if (best) {
      todo.push(`Attack with ${pretty(u.type)} (${u.x},${u.y}) -> ${pretty(best.type)} at (${best.x},${best.y}): deal ${best.damageToDefender}, take ${best.damageToAttacker}${best.kills ? " - kills it" : ""}.`);
    } else if (c.results?.length) {
      const r = c.results[0];
      tips.push(`${pretty(u.type)} (${u.x},${u.y}) vs ${pretty(r.type)}: deal ${r.damageToDefender}, take ${r.damageToAttacker} - ${r.canAttackNow ? "a bad trade, hold or fortify" : "cannot attack it yet"}.`);
    }
  }

  // 3. Research and civics.
  const me = snap.me || {};
  const boosts = planning.boosts || { techs: [], civics: [] };
  const researching = snap.techs?.researching || me.researching;
  const topTech = advisor.techs?.[0];
  if (!researching) todo.push(`Choose research: the game suggests ${topTech ? `${topTech.name}` : "anything"}${advisor.techs?.[1] ? `, then ${advisor.techs[1].name}` : ""}.`);
  const civic = me.civic;
  if (!civic?.type) todo.push(`Choose a civic: the game suggests ${advisor.civics?.[0]?.name || "anything"}.`);
  const curBoost = researching && boosts.techs.find((b) => b.type === (researching.type || researching));
  if (curBoost) tips.push(`Eureka for current research ${curBoost.name}: ${untag(curBoost.how)}`);
  const easy = boosts.techs.filter((b) => b.available).slice(0, 2);
  for (const b of easy) if (b !== curBoost) tips.push(`Eureka within reach - ${b.name}: ${untag(b.how)}`);
  const civBoost = boosts.civics.find((b) => b.type === civic?.type);
  if (civBoost) tips.push(`Inspiration for current civic ${civBoost.name}: ${untag(civBoost.how)}`);

  // 4. Cities.
  const prod = solve.productionOverview(snap);
  for (const name of prod.idle) {
    const rec = (advisor.cities || []).find((c) => c.name === name)?.recommended?.[0];
    todo.push(`${name} is idle: the game suggests ${rec ? rec.name : "anything"}.`);
  }
  if (prod.housingCapped.length) tips.push(`Out of housing: ${prod.housingCapped.join(", ")} (build a Granary, farms, or a water source).`);
  if (prod.unhappy.length) tips.push(`Short of amenities: ${prod.unhappy.join(", ")} (luxuries, entertainment, policies).`);

  // 5. Civilian units with work to do.
  const sites = advisor.settle || [];
  for (const u of (snap.units || []).filter((x) => x.type === "UNIT_SETTLER" && x.moves > 0)) {
    if (!sites.length) {
      todo.push(`Settler at (${u.x},${u.y}): no recommended sites in view - explore.`);
      continue;
    }
    const ranked = sites.map((s, i) => ({ ...s, rank: i + 1, d: solve.hexDistance(u.x, u.y, s.x, s.y, wrap) })).sort((a, b) => a.rank - b.rank);
    const here = ranked.find((s) => s.d === 0);
    if (here && here.rank === 1) todo.push(`Settler at (${u.x},${u.y}): settle here - it is the game's #1 site (${here.pros.slice(0, 2).join("; ")}).`);
    else todo.push(`Settler at (${u.x},${u.y}): best site (${ranked[0].x},${ranked[0].y}), ${ranked[0].d} tiles away${ranked[0].pros?.length ? ` - ${ranked[0].pros[0]}` : ""}.`);
  }
  for (const b of advisor.builders || []) {
    const r = b.recommended?.[0];
    if (r) todo.push(`Builder at (${b.x},${b.y}): ${r.name} at (${r.x},${r.y}).`);
  }
  const idle = solve.findUnits(snap, { idleOnly: true });
  const handled = new Set([...(snap.units || []).filter((x) => x.type === "UNIT_SETTLER").map((x) => x.id), ...(advisor.builders || []).map((b) => b.id)]);
  const others = idle.units.filter((u) => !handled.has(u.id));
  if (others.length) todo.push(`${others.length} other unit(s) waiting for orders: ${others.slice(0, 5).map((u) => `${pretty(u.type)} (${u.x},${u.y})`).join(", ")}.`);

  // 6. Great people and envoys.
  for (const g of (planning.greatPeople || []).filter((x) => x.canRecruit)) todo.push(`Recruit ${g.person} (${pretty(String(g.class).replace(/^GREAT_PERSON_CLASS_/, ""))}) - you have the points.`);
  if (planning.envoys?.toGive > 0) todo.push(`Send ${planning.envoys.toGive} envoy(s).`);

  // 7. Economy warnings.
  if ((me.goldPerTurn ?? 0) < 0) tips.push(`Gold per turn is ${me.goldPerTurn}: cut units or buildings, or trade for gold.`);

  const lines = [`Turn ${snap.meta?.turn ?? situation.turn ?? "?"} plan:`];
  if (urgent.length) lines.push("Urgent:", ...urgent.map((x) => `! ${x}`));
  if (todo.length) lines.push("Do this turn:", ...todo.map((x) => `- ${x}`));
  if (tips.length) lines.push("Worth knowing:", ...tips.map((x) => `- ${x}`));
  if (situation.blocking) lines.push(`The game is waiting on: ${pretty(situation.blocking)}.`);
  if (!urgent.length && !todo.length) lines.push("Nothing needs you right now - end the turn.");
  const gaps = [situation, advisor, planning].filter((x) => x?.error).map((x) => x.error);
  if (gaps.length) lines.push(`(Could not read: ${gaps.join("; ")})`);
  lines.push("(Built from the game's own numbers - free, no AI.)");
  return { text: lines.join("\n"), urgent, todo, tips };
}
