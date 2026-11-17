import fs from 'node:fs';
import path from 'node:path';
import { detectSessionContext } from './api_client.js';

const DEFAULT_CACHE_DIR = path.resolve(import.meta.dirname, '..', '.cache');

export class SeenCache {
  constructor(cacheFilePath = path.join(DEFAULT_CACHE_DIR, 'seen_cache.json')) {
    this.cacheFilePath = cacheFilePath;
    this.data = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.cacheFilePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.cacheFilePath, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          return parsed;
        }
      }
    } catch {
      // Ignore corrupt cache and rebuild cleanly.
    }
    return { run_id: null, cards: {}, relics: {}, powers: {}, glossary: {} };
  }

  _ensureRun(runId) {
    const normalized = runId || 'run_unknown';
    if (this.data.run_id !== normalized) {
      this.data = {
        run_id: normalized,
        cards: {},
        relics: {},
        powers: {},
        glossary: {},
      };
    }
  }

  hasCard(runId, key) {
    this._ensureRun(runId);
    return Boolean(this.data.cards[key]);
  }

  markCard(runId, key) {
    this._ensureRun(runId);
    this.data.cards[key] = 1;
  }

  hasRelic(runId, id) {
    this._ensureRun(runId);
    return Boolean(this.data.relics[id]);
  }

  markRelic(runId, id) {
    this._ensureRun(runId);
    this.data.relics[id] = 1;
  }

  hasPower(runId, id) {
    this._ensureRun(runId);
    return Boolean(this.data.powers[id]);
  }

  markPower(runId, id) {
    this._ensureRun(runId);
    this.data.powers[id] = 1;
  }

  hasGlossary(runId, term) {
    this._ensureRun(runId);
    return Boolean(this.data.glossary[term]);
  }

  markGlossary(runId, term) {
    this._ensureRun(runId);
    this.data.glossary[term] = 1;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.cacheFilePath), { recursive: true });
      fs.writeFileSync(this.cacheFilePath, JSON.stringify(this.data), 'utf8');
    } catch {
      // Cache persistence is best-effort.
    }
  }

  clear() {
    this.data = { run_id: null, cards: {}, relics: {}, powers: {}, glossary: {} };
    try {
      if (fs.existsSync(this.cacheFilePath)) {
        fs.unlinkSync(this.cacheFilePath);
      }
    } catch {
      // Ignore cleanup errors.
    }
  }
}

export function parseHpPair(hpValue, fallbackCur = null, fallbackMax = null) {
  if (typeof hpValue === 'string' && hpValue.includes('/')) {
    const [a, b] = hpValue.split('/');
    const cur = Number.parseInt(a.trim(), 10);
    const max = Number.parseInt(b.trim(), 10);
    if (Number.isFinite(cur) && Number.isFinite(max)) {
      return { current: cur, max };
    }
  }
  return {
    current: Number.isFinite(fallbackCur) ? fallbackCur : 0,
    max: Number.isFinite(fallbackMax) ? fallbackMax : 0,
  };
}

/**
 * Extracts card name + cost + rules text from compact `line` ("打击 [1费]：造成 6 点伤害。")
 * or raw card fields so seen-card deduplication works consistently across payloads.
 */
function splitCardLine(card) {
  if (typeof card.line === 'string' && card.line.length > 0) {
    const sepIdx = card.line.indexOf('：');
    const colonIdx = sepIdx >= 0 ? sepIdx : card.line.indexOf(': ');
    if (colonIdx >= 0) {
      const head = card.line.slice(0, colonIdx).trim();
      const desc = card.line.slice(colonIdx + (sepIdx >= 0 ? 1 : 2)).trim();
      return { head, desc };
    }
    return { head: card.line.trim(), desc: '' };
  }

  const name = card.name || card.card_id || 'Unknown';
  const title = card.upgraded && !String(name).endsWith('+') ? `${name}+` : name;
  const costs = [];
  if (card.costs_x) costs.push('X费');
  else if (card.energy_cost !== null && card.energy_cost !== undefined) costs.push(`${Math.max(0, card.energy_cost)}费`);
  if (card.star_costs_x) costs.push('X星');
  else if (card.star_cost > 0) costs.push(`${card.star_cost}星`);
  const head = costs.length > 0 ? `${title} [${costs.join('/')}]` : title;
  const desc = (card.resolved_rules_text || card.rules_text || '').trim();
  return { head, desc };
}

function getCardRuleKey(card) {
  const id = card.card_id || card.name || '';
  const upg = card.upgraded || String(card.line || '').includes('+') ? '1' : '0';
  return `${id}#${upg}`;
}

function getCardDynamicDamage(card) {
  if (Array.isArray(card.vs) && card.vs.length > 0) {
    return Math.max(...card.vs.map((v) => Number(v.damage ?? v.per_hit ?? 0) || 0));
  }
  if (Array.isArray(card.values)) {
    const dmg = card.values.find((v) => /damage/i.test(v.name));
    if (dmg) return Number(dmg.preview ?? dmg.current_value ?? dmg.base_value ?? 0) || 0;
  }
  if (Array.isArray(card.dynamic_values)) {
    const dmg = card.dynamic_values.find((v) => /damage/i.test(v.name));
    if (dmg) return Number(dmg.current_value ?? dmg.base_value ?? 0) || 0;
  }
  return 0;
}

function getCardDynamicBlock(card) {
  const list = card.values || card.dynamic_values;
  if (Array.isArray(list)) {
    const blk = list.find((v) => /block/i.test(v.name));
    if (blk) return Number(blk.preview ?? blk.current_value ?? blk.base_value ?? 0) || 0;
  }
  return 0;
}

/**
 * Computes deterministic combat math (incoming damage, block deficit, playable attack ceiling,
 * and fallback max-block / single-target kill estimates if mod threat summary is absent).
 */
export function computeCombatSummary(state) {
  const combat = state?.combat;
  if (!combat) return null;

  const player = combat.player || {};
  const hp = parseHpPair(player.hp, player.current_hp, player.max_hp);
  const block = Number(player.block ?? 0);
  const energy = Number(player.energy ?? 0);
  const enemies = Array.isArray(combat.enemies) ? combat.enemies : [];
  const hand = Array.isArray(combat.hand) ? combat.hand : [];
  const threat = combat.threat || null;

  let incoming = 0;
  let hasUnknownEnemyAttack = false;
  for (const enemy of enemies) {
    const alive = enemy.alive ?? enemy.is_alive ?? true;
    if (!alive) continue;
    for (const intent of enemy.intents || []) {
      if (intent.total_damage !== null && intent.total_damage !== undefined) {
        incoming += Math.max(0, Number(intent.total_damage) || 0);
      } else if (intent.damage !== null && intent.damage !== undefined) {
        const hits = Number(intent.hits ?? 1) || 1;
        incoming += Math.max(0, (Number(intent.damage) || 0) * hits);
      } else if (/attack/i.test(String(intent.intent_type || ''))) {
        hasUnknownEnemyAttack = true;
      }
    }
  }

  const finalIncoming = threat?.incoming !== undefined && threat?.incoming !== null
    ? Number(threat.incoming)
    : incoming;
  const selfDamage = Number(threat?.end_of_turn_self_damage ?? 0);
  const blockNeeded = threat?.block_needed !== undefined && threat?.block_needed !== null
    ? Number(threat.block_needed)
    : Math.max(0, finalIncoming - block);
  const unblocked = threat?.unblocked !== undefined && threat?.unblocked !== null
    ? Number(threat.unblocked)
    : Math.max(0, finalIncoming + selfDamage - block);
  const hpAfter = threat?.hp_after !== undefined && threat?.hp_after !== null
    ? Number(threat.hp_after)
    : hp.current - unblocked;
  const lethal = Boolean(threat?.lethal || combat.end_turn_will_kill_player || hpAfter <= 0);

  // Deterministic knapsack/greedy upper bound for playable attack damage within current energy.
  const playableAttacks = hand
    .filter((c) => c.playable && !c.costs_x && (c.type === 'attack' || String(c.card_type || '').toLowerCase() === 'attack'))
    .map((c) => ({
      i: c.i ?? c.index,
      cid: c.cid ?? c.combat_card_id ?? null,
      cost: Math.max(0, Number(c.energy_cost ?? 0)),
      dmg: getCardDynamicDamage(c),
    }))
    .filter((c) => c.dmg > 0);

  let maxPlayableAttackDmg = 0;
  if (playableAttacks.length > 0 && energy >= 0) {
    const cap = Math.min(energy, 20);
    const dp = new Array(cap + 1).fill(0);
    for (const atk of playableAttacks) {
      if (atk.cost > cap) continue;
      for (let e = cap; e >= atk.cost; e -= 1) {
        dp[e] = Math.max(dp[e], dp[e - atk.cost] + atk.dmg);
      }
    }
    maxPlayableAttackDmg = Math.max(...dp);
  }

  // Fallback max block if mod didn't compute threat.max_block
  let maxBlock = threat?.max_block?.block ?? null;
  if (maxBlock === null) {
    const blockCards = hand
      .filter((c) => c.playable && !c.costs_x)
      .map((c) => ({ cost: Math.max(0, Number(c.energy_cost ?? 0)), blk: getCardDynamicBlock(c) }))
      .filter((c) => c.blk > 0);
    const cap = Math.min(Math.max(0, energy), 20);
    const dp = new Array(cap + 1).fill(0);
    for (const bc of blockCards) {
      if (bc.cost > cap) continue;
      for (let e = cap; e >= bc.cost; e -= 1) {
        dp[e] = Math.max(dp[e], dp[e - bc.cost] + bc.blk);
      }
    }
    maxBlock = Math.max(...dp);
  }

  const killOptions = Array.isArray(threat?.kill_options)
    ? threat.kill_options.filter((k) => k.killable)
    : [];

  return {
    incoming: finalIncoming,
    hasUnknownEnemyAttack,
    selfDamage,
    block,
    blockNeeded,
    unblocked,
    hpAfter,
    lethal,
    maxBlock,
    maxPlayableAttackDmg,
    killOptions,
    lethalRisks: Array.isArray(combat.lethal_risks) ? combat.lethal_risks : [],
  };
}

function formatPowerCompact(rawLine, seenCache, runId, full) {
  if (typeof rawLine === 'object' && rawLine !== null) {
    const id = rawLine.power_id || rawLine.name || 'POWER';
    const amt = rawLine.amount !== null && rawLine.amount !== undefined ? ` ${rawLine.amount}` : '';
    const debuff = rawLine.is_debuff ? '[debuff]' : '';
    const desc = rawLine.description ? `: ${rawLine.description}` : '';
    const base = `${id}${amt}${debuff}`;
    if (!desc) return base;
    if (!full && seenCache.hasPower(runId, id)) return base;
    seenCache.markPower(runId, id);
    return `${base}${desc}`;
  }

  const str = String(rawLine || '');
  const colonIdx = str.indexOf(': ');
  if (colonIdx < 0) return str;
  const head = str.slice(0, colonIdx).trim();
  const id = head.split(/\s+/)[0];
  if (!full && seenCache.hasPower(runId, id)) {
    return head;
  }
  seenCache.markPower(runId, id);
  return str;
}

function formatStackList(items) {
  if (!Array.isArray(items) || items.length === 0) return '空';
  return items
    .map((item) => {
      if (typeof item === 'string') return item;
      const line = String(item.line || item.name || '');
      // Keep only "Name*N [Cost]" without long rules text for piles!
      const colonIdx = line.indexOf('：');
      return colonIdx >= 0 ? line.slice(0, colonIdx).trim() : line;
    })
    .join(', ');
}

function formatPotions(potions) {
  if (!Array.isArray(potions) || potions.length === 0) return '';
  const occupied = potions.filter((p) => (p.potion_id ?? null) !== null || p.occupied);
  if (occupied.length === 0) return '药水: 无';
  return `药水: ${occupied.map((p) => {
    const idx = p.i ?? p.index;
    const usable = (p.usable ?? p.can_use) ? '可用' : '不可用';
    const target = Array.isArray(p.targets) && p.targets.length > 0 ? ` 目标:${p.targets.join(',')}` : '';
    const rawName = String(p.line || p.name || p.potion_id).replace(/^\d+:\s*/, '');
    return `[${idx}] ${rawName}(${usable}${target})`;
  }).join(' | ')}`;
}

function formatRelicsCompact(run, seenCache, runId, full) {
  const relics = Array.isArray(run?.relics) ? run.relics : [];
  if (relics.length === 0) return '';

  const ids = Array.isArray(run.relic_ids) ? run.relic_ids : [];
  const stacks = Array.isArray(run.relic_stacks) ? run.relic_stacks : [];
  const descs = Array.isArray(run.relic_descriptions) ? run.relic_descriptions : [];

  const parts = [];
  for (let i = 0; i < relics.length; i += 1) {
    const r = relics[i];
    const name = typeof r === 'string' ? r : (r.name || r.relic_id);
    const id = ids[i] || (typeof r === 'object' ? r.relic_id : null) || name;
    const stack = stacks[i] ?? (typeof r === 'object' ? r.stack : null);
    const desc = descs[i] ?? (typeof r === 'object' ? r.description : null);

    const stackTag = stack !== null && stack !== undefined ? `(${stack})` : '';
    const seen = seenCache.hasRelic(runId, id);
    if (full || !seen) {
      if (desc) seenCache.markRelic(runId, id);
      else seenCache.markRelic(runId, id);
      parts.push(desc ? `${name}${stackTag}[${desc}]` : `${name}${stackTag}`);
    } else if (stackTag) {
      parts.push(`${name}${stackTag}`);
    } else {
      parts.push(name);
    }
  }
  return `遗物(${relics.length}): ${parts.join(', ')}`;
}

/**
 * Checks whether the current screen requires human confirmation in `assist` mode.
 */
export function needsAssistConfirmation(state) {
  const screen = state?.screen || 'UNKNOWN';
  if (screen === 'MAP') return true;
  if (screen === 'REWARD') return true;
  if (screen === 'SHOP' || screen === 'FAKE_MERCHANT') return true;
  if (screen === 'REST') return true;
  if (screen === 'CHEST') return true;
  if (screen === 'CARD_SELECTION') return true;
  if (screen === 'BUNDLE_SELECTION') return true;
  if (screen === 'EVENT') {
    const opts = state?.event?.options || [];
    const hasBranch = opts.length > 1 || (opts.length === 1 && !opts[0].proceed && !opts[0].is_proceed);
    return !state?.event?.finished && hasBranch;
  }
  return false;
}

/**
 * Compresses any game snapshot into high-density Markdown (~150-300 tokens).
 */
export function compressState(state, {
  availableActions = null,
  mode = 'auto',
  full = false,
  seenCache = new SeenCache(),
  extraBanner = null,
} = {}) {
  if (!state || typeof state !== 'object') {
    return '[状态不可用] 未获取到有效游戏状态。';
  }

  const runId = state.run_id || 'run_unknown';
  const ctx = detectSessionContext(state);
  const run = state.run || null;
  const screen = state.screen || 'UNKNOWN';
  const lines = [];

  // 1. Header
  const headerParts = [`界面:${screen}`];
  headerParts.push(`模式:${ctx.isMultiplayer ? `联机(${ctx.playerCount}P)` : '单人'}`);
  if (state.turn !== null && state.turn !== undefined) headerParts.push(`T${state.turn}`);
  if (run?.floor !== null && run?.floor !== undefined) headerParts.push(`层:${run.floor}`);
  if (run?.act_id) headerParts.push(run.act_id);
  if (run?.boss_id) headerParts.push(`Boss:${run.boss_id}`);
  if (run?.character) headerParts.push(run.character);
  else if (run?.character_name) headerParts.push(run.character_name);
  headerParts.push(`控制:${mode}`);
  lines.push(`[${headerParts.join(' | ')}]`);

  if (extraBanner) {
    lines.push(extraBanner);
  }
  if (ctx.waitingForOthers && ctx.waitingReason) {
    lines.push(`[等待队友] ${ctx.waitingReason}`);
  }
  if (mode === 'assist' && needsAssistConfirmation(state)) {
    lines.push('[需要玩家确认] 当前为决策节点，请向玩家汇报建议并等待指令。');
  }

  // 2. Run summary outside/inside combat
  if (run) {
    const runHp = parseHpPair(run.hp, run.current_hp, run.max_hp);
    const baseParts = [`HP ${runHp.current}/${runHp.max}`, `金币 ${run.gold ?? 0}`];
    if (run.game_mode && run.game_mode !== 'standard') baseParts.push(`规则:${run.game_mode}`);
    if (screen !== 'COMBAT') {
      lines.push(`状态: ${baseParts.join(' | ')}`);
      const relicLine = formatRelicsCompact(run, seenCache, runId, full);
      if (relicLine) lines.push(relicLine);
      const potLine = formatPotions(run.potions);
      if (potLine) lines.push(potLine);
      if (run.deck_stats) {
        const ds = run.deck_stats;
        lines.push(`牌组统计: 共${ds.count}张 (攻${ds.attacks}/技${ds.skills}/能${ds.powers}/诅${ds.curses}/升${ds.upgraded} | 均费${ds.avg_cost} | 初始打击${ds.starter_strikes}/防御${ds.starter_defends})`);
      }
    }
  }

  // 3. Screen-specific body
  if (screen === 'COMBAT' && state.combat) {
    const combat = state.combat;
    const p = combat.player || {};
    const hp = parseHpPair(p.hp, p.current_hp, p.max_hp);
    const playerParts = [`HP ${hp.current}/${hp.max}`, `护甲 ${p.block ?? 0}`, `能量 ${p.energy ?? 0}`];
    if (p.stars > 0) playerParts.push(`星 ${p.stars}`);
    if (p.focus !== 0 && p.focus !== undefined) playerParts.push(`集中 ${p.focus}`);
    if (Array.isArray(p.orbs) && p.orbs.length > 0) {
      playerParts.push(`球(${p.orbs.length}/${p.orb_capacity ?? p.orbs.length}): ${p.orbs.map((o) => typeof o === 'string' ? o : `${o.name}(${o.passive_value}/${o.evoke_value})`).join(',')}`);
    }
    if (Array.isArray(p.arrows) && p.arrows.length > 0) {
      playerParts.push(`箭矢(${p.available_arrows ?? 0}/${p.arrows.length}): ${p.arrows.join(',')}`);
    }
    if (p.melody && (p.melody.melodies_this_turn > 0 || p.melody.melody_cards_this_turn > 0)) {
      const m = p.melody;
      const tags = [m.wah && 'Wah', m.cho && 'Cho', m.ki && 'Ki'].filter(Boolean).join('+');
      playerParts.push(`旋律:${tags || '无'}(${m.melodies_this_turn})`);
    }
    if (Array.isArray(p.pets) && p.pets.length > 0) {
      playerParts.push(`宠物: ${p.pets.map((pet) => typeof pet === 'string' ? pet : `${pet.name} ${pet.current_hp}/${pet.max_hp}`).join(',')}`);
    } else if (p.pet_missing) {
      playerParts.push('宠物:阵亡/未召唤');
    }
    if (Array.isArray(p.powers) && p.powers.length > 0) {
      playerParts.push(`Buff: ${p.powers.map((pw) => formatPowerCompact(pw, seenCache, runId, full)).join('; ')}`);
    }
    lines.push(`我方: ${playerParts.join(' | ')}`);

    // Co-op teammates in combat
    if (ctx.isMultiplayer && Array.isArray(combat.players) && combat.players.length > 1) {
      const teammates = combat.players
        .filter((other) => !other.is_local)
        .map((other) => `[槽${other.slot_index}] ${other.character_name || other.character_id} HP ${other.current_hp}/${other.max_hp} 甲${other.block} 能${other.energy}${other.is_alive ? '' : '(倒地)'}`);
      if (teammates.length > 0) {
        lines.push(`队友: ${teammates.join(' | ')}`);
      }
    }

    // Combat math summary
    const math = computeCombatSummary(state);
    if (math) {
      const mathParts = [
        `来袭总伤:${math.incoming}${math.hasUnknownEnemyAttack ? '+' : ''}`,
        `护甲缺口:${math.blockNeeded}`,
        `最大可叠甲:${math.maxBlock}`,
        `手牌直伤上限:${math.maxPlayableAttackDmg}`,
      ];
      if (math.selfDamage > 0) mathParts.push(`回合结算自伤:${math.selfDamage}`);
      if (math.killOptions.length > 0) {
        const kStr = math.killOptions
          .map((k) => `[${k.enemy}]可斩(${k.energy}费:cids=${(k.cids || []).join(',')})`)
          .join(' ');
        mathParts.push(`斩杀:${kStr}`);
      }
      if (math.lethal) mathParts.push('⚠️结束回合将致死');
      lines.push(`[战局算术] ${mathParts.join(' | ')}`);
    }

    if (combat.action_readiness && combat.action_readiness.can_use_combat_actions === false) {
      lines.push(`动作门禁: 暂不可操作 (${combat.action_readiness.reason})`);
    }

    // Enemies
    const enemies = Array.isArray(combat.enemies) ? combat.enemies : [];
    const enemyLines = enemies
      .filter((e) => (e.alive ?? e.is_alive ?? true))
      .map((e) => {
        const idx = e.i ?? e.index;
        const eHp = parseHpPair(e.hp, e.current_hp, e.max_hp);
        const intentText = Array.isArray(e.intents) && e.intents.length > 0
          ? e.intents.map((it) => `${it.intent_type}${it.label ? ` ${it.label}` : ''}`).join('+')
          : (e.intent || e.move_id || '未知');
        const pwText = Array.isArray(e.powers) && e.powers.length > 0
          ? ` | Buff:${e.powers.map((pw) => formatPowerCompact(pw, seenCache, runId, full)).join(', ')}`
          : '';
        const blkText = e.block > 0 ? ` 甲${e.block}` : '';
        const hittableTag = (e.hittable ?? e.is_hittable ?? true) ? '' : ' [不可选中]';
        return `[${idx}] ${e.name}${hittableTag} HP ${eHp.current}/${eHp.max}${blkText} | 意图:${intentText}${pwText}`;
      });
    if (enemyLines.length > 0) {
      lines.push(`敌人:\n${enemyLines.map((l) => `- ${l}`).join('\n')}`);
    }

    // Hand
    const hand = Array.isArray(combat.hand) ? combat.hand : [];
    if (hand.length === 0) {
      lines.push('手牌: 无');
    } else {
      const handLines = hand.map((card) => {
        const idx = card.i ?? card.index;
        const cid = card.cid ?? card.combat_card_id;
        const idTag = cid !== null && cid !== undefined ? `${idx} cid:${cid}` : `${idx}`;
        const { head, desc } = splitCardLine(card);
        const playableTag = card.playable ? '' : ` [不可打:${card.why || card.unplayable_reason || 'locked'}]`;
        const targets = Array.isArray(card.targets) ? card.targets : (Array.isArray(card.valid_target_indices) ? card.valid_target_indices : []);
        const targetTag = targets.length > 0 ? ` (目标:${targets.join(',')})` : '';

        let vsTag = '';
        if (Array.isArray(card.vs) && card.vs.length > 0) {
          vsTag = ` -> ${card.vs.map((v) => `[${v.enemy}]:${v.damage ?? `${v.per_hit}x?`}伤${v.kills ? '(斩!)' : ''}`).join(' ')}`;
        }

        const key = getCardRuleKey(card);
        const alreadySeen = seenCache.hasCard(runId, key);
        if (desc) seenCache.markCard(runId, key);
        const descTag = (!full && alreadySeen) || !desc ? '' : ` | ${desc}`;
        return `- [${idTag}] ${head}${targetTag}${playableTag}${vsTag}${descTag}`;
      });
      lines.push(`手牌:\n${handLines.join('\n')}`);
    }

    // Piles & Potions & Relics
    const drawList = combat.draw || run?.piles?.draw || [];
    const discardList = combat.discard || run?.piles?.discard || [];
    const exhaustList = combat.exhaust || run?.piles?.exhaust || [];
    const pileParts = [`抽:${formatStackList(drawList)}`];
    if (discardList.length > 0) pileParts.push(`弃:${formatStackList(discardList)}`);
    if (exhaustList.length > 0) pileParts.push(`耗:${formatStackList(exhaustList)}`);
    lines.push(`牌堆: ${pileParts.join(' | ')}`);

    if (run) {
      const potLine = formatPotions(run.potions);
      if (potLine && potLine !== '药水: 无') lines.push(potLine);
      // Show relics with stack counters or newly seen relics during combat
      const relicCount = Array.isArray(run.relics) ? run.relics.length : 0;
      if (relicCount > 0) {
        const stacks = Array.isArray(run.relic_stacks) ? run.relic_stacks : [];
        const activeOrNew = [];
        for (let i = 0; i < relicCount; i += 1) {
          const r = run.relics[i];
          const name = typeof r === 'string' ? r : (r.name || r.relic_id);
          const id = run.relic_ids?.[i] || (typeof r === 'object' ? r.relic_id : null) || name;
          const st = stacks[i] ?? (typeof r === 'object' ? r.stack : null);
          const desc = run.relic_descriptions?.[i] ?? (typeof r === 'object' ? r.description : null);
          if (full || !seenCache.hasRelic(runId, id)) {
            seenCache.markRelic(runId, id);
            activeOrNew.push(desc ? `${name}${st != null ? `(${st})` : ''}[${desc}]` : `${name}${st != null ? `(${st})` : ''}`);
          } else if (st !== null && st !== undefined) {
            activeOrNew.push(`${name}(${st})`);
          }
        }
        if (activeOrNew.length > 0) {
          lines.push(`关键遗物: ${activeOrNew.join(', ')}`);
        }
      }
    }
  } else if (screen === 'MAP' && state.map) {
    const m = state.map;
    lines.push(`当前坐标: ${m.current || (m.current_node ? `${m.current_node.row},${m.current_node.col}` : '起点')} | 地图打开:${m.open ?? m.is_travel_enabled ?? true}`);
    const opts = m.options || m.available_nodes || [];
    if (opts.length > 0) {
      lines.push(`可选路线:\n${opts.map((o) => `- [${o.i ?? o.index}] ${o.line || `${o.node_type} (${o.row},${o.col})`}`).join('\n')}`);
    }
    if (m.route_advice?.options?.length > 0) {
      const adv = m.route_advice.options
        .map((a) => `[${a.i}]分:${a.score}(${a.why})`)
        .join(' | ');
      lines.push(`路线预估(推荐${m.route_advice.recommended_i ?? '无'}): ${adv}`);
    }
    if (Array.isArray(m.votes) && m.votes.length > 0) {
      lines.push(`联机投票: ${m.votes.map((v) => `${v.local ? '我方' : v.player_id}->${v.coord}`).join(', ')}`);
    }
  } else if (screen === 'REWARD' && state.reward) {
    const rw = state.reward;
    if (rw.pending_card_choice) {
      const cards = rw.cards || rw.card_options || [];
      lines.push(`选牌奖励 (${cards.length}张可选):`);
      for (const c of cards) {
        const idx = c.i ?? c.index;
        const { head, desc } = splitCardLine(c);
        const meta = [c.type, c.rarity].filter(Boolean).join('/');
        lines.push(`- [${idx}] ${head}${meta ? ` (${meta})` : ''}${desc ? ` | ${desc}` : ''}`);
      }
      const alts = rw.alternatives || [];
      if (alts.length > 0) {
        lines.push(`其他: ${alts.map((a) => `${a.line || a.label} (skip_card)`).join(', ')}`);
      }
    } else {
      const items = rw.rewards || [];
      lines.push(`战利品 (可继续:${rw.can_proceed}):`);
      for (const r of items) {
        const idx = r.i ?? r.index;
        const ok = r.claimable ? '' : ' [不可领取/药水满]';
        lines.push(`- [${idx}] ${r.line || `${r.reward_type}: ${r.description}`}${ok}`);
      }
    }
  } else if ((screen === 'SHOP' || screen === 'FAKE_MERCHANT') && state.shop) {
    const s = state.shop;
    lines.push(`商店状态: 库存已打开=${s.open ?? s.is_open}${s.blitz ? ` | Blitz模式剩余选择:${s.choices_remaining}` : ''}`);
    if (s.blitz && Array.isArray(s.blitz_entries)) {
      lines.push(`Blitz选项:\n${s.blitz_entries.map((e) => `- [${e.i ?? e.index}] ${e.line || e.name} (${e.status})`).join('\n')}`);
    } else if (s.open ?? s.is_open) {
      for (const c of s.cards || []) {
        const idx = c.i ?? c.index;
        const { head, desc } = splitCardLine(c);
        const aff = (c.affordable ?? c.enough_gold) ? '' : '[买不起]';
        const sale = c.on_sale ? '[打折]' : '';
        lines.push(`- 卡[${idx}] ${head} | ${c.price}g ${sale}${aff}${desc ? ` | ${desc}` : ''}`);
      }
      for (const r of s.relics || []) {
        const idx = r.i ?? r.index;
        if (r.stocked === false || r.is_stocked === false) continue;
        lines.push(`- 遗物[${idx}] ${r.line || `${r.name} ${r.price}g`}${(r.affordable ?? r.enough_gold) ? '' : '[买不起]'}`);
      }
      for (const pot of s.potions || []) {
        const idx = pot.i ?? pot.index;
        if (pot.stocked === false || pot.is_stocked === false) continue;
        lines.push(`- 药水[${idx}] ${pot.line || `${pot.name} ${pot.price}g`}${(pot.affordable ?? pot.enough_gold) ? '' : '[买不起]'}`);
      }
      const rem = s.remove || s.card_removal;
      if (rem) {
        lines.push(`- 删牌服务: ${rem.price}g | 可用=${rem.available} 买得起=${rem.affordable ?? rem.enough_gold} 已用=${rem.used}`);
      }
    }
  } else if (screen === 'REST' && state.rest) {
    lines.push('篝火休息点:');
    for (const o of state.rest.options || []) {
      const idx = o.i ?? o.index;
      const en = (o.enabled ?? o.is_enabled) ? '' : ' [不可用]';
      lines.push(`- [${idx}] (${o.option_id}) ${o.line || o.title}${en}`);
    }
  } else if (screen === 'EVENT' && state.event) {
    const ev = state.event;
    lines.push(`事件: ${ev.title || ev.id || ev.event_id} (结束=${ev.finished ?? ev.is_finished})`);
    for (const o of ev.options || []) {
      const idx = o.i ?? o.index;
      const tags = [
        (o.locked ?? o.is_locked) && 'LOCKED',
        (o.kill ?? o.will_kill_player) && 'LETHAL',
        (o.proceed ?? o.is_proceed) && 'PROCEED',
      ].filter(Boolean).join(',');
      lines.push(`- [${idx}] ${o.line || `${o.title} ${o.description || ''}`.trim()}${tags ? ` [${tags}]` : ''}`);
    }
  } else if (screen === 'CHEST' && state.chest) {
    const ch = state.chest;
    lines.push(`宝箱房: 已打开=${ch.opened ?? ch.is_opened} 已领取=${ch.claimed ?? ch.has_relic_been_claimed}`);
    for (const r of ch.relics || ch.relic_options || []) {
      lines.push(`- [${r.i ?? r.index}] ${r.line || `${r.name} [${r.rarity}]`}`);
    }
  } else if (screen === 'CARD_SELECTION' && state.selection) {
    const sel = state.selection;
    lines.push(`选牌(${sel.kind}): ${sel.prompt} | 已选 ${sel.selected ?? sel.selected_count ?? 0}/${sel.max ?? sel.max_select ?? 1} (最少${sel.min ?? sel.min_select ?? 1}, 可确认=${sel.confirm ?? sel.can_confirm})`);
    for (const c of sel.cards || []) {
      const idx = c.i ?? c.index;
      const { head, desc } = splitCardLine(c);
      const selTag = c.selected ? '[已选]' : '';
      const upg = c.upgrade?.status === 'available' ? ` -> 升级后:${c.upgrade.cost}费 ${c.upgrade.description}` : '';
      lines.push(`- [${idx}] ${selTag}${head}${desc ? ` | ${desc}` : ''}${upg}`);
    }
  } else if (screen === 'BUNDLE_SELECTION' && Array.isArray(state.bundles)) {
    lines.push('开局卡包选择:');
    for (const b of state.bundles) {
      const cardNames = (b.cards || []).map((c) => splitCardLine(c).head).join(' + ');
      lines.push(`- 卡包[${b.i ?? b.index}]: ${cardNames}`);
    }
  } else if (screen === 'CRYSTAL_SPHERE' && state.crystal_sphere) {
    const cs = state.crystal_sphere;
    lines.push(`水晶球占卜: 剩余次数=${cs.divinations_left} 工具=${cs.tool} 棋盘=${cs.grid_width}x${cs.grid_height} 未翻格=${(cs.hidden_cells || []).length}`);
    for (const item of cs.items || []) {
      lines.push(`- 物品(${item.x},${item.y} ${item.width}x${item.height}): ${item.revealed ? `${item.kind}(好=${item.is_good})` : '未完全揭示'}`);
    }
  } else if (screen === 'CHARACTER_SELECT' && state.character_select) {
    const cs = state.character_select;
    lines.push(`选角(${cs.mode || 'standard'} | 进阶${cs.ascension ?? 0} | 可出发=${cs.embark ?? cs.can_embark}):`);
    for (const c of cs.characters || []) {
      lines.push(`- [${c.i ?? c.index}] ${c.line || c.name}${c.selected || c.is_selected ? ' [已选]' : ''}${c.locked || c.is_locked ? ' [未解锁]' : ''}`);
    }
    if (Array.isArray(cs.players) && cs.players.length > 1) {
      lines.push(`联机玩家: ${cs.players.map((p) => `${p.is_local ? '我' : p.player_id}:${p.character_name || '未选'}(${p.is_ready ? '就绪' : '未就绪'})`).join(' | ')}`);
    }
  } else if (screen === 'MULTIPLAYER_LOBBY' && state.multiplayer_lobby) {
    const ml = state.multiplayer_lobby;
    lines.push(`联机大厅: 房主=${ml.is_host} 人数=${ml.player_count}/${ml.max_players} 本地就绪=${ml.local_ready}`);
    for (const p of ml.players || []) {
      lines.push(`- 玩家[${p.i ?? p.slot_index}] ${p.is_local ? '(我)' : ''} ${p.character || p.character_name || '未选'} ${p.ready || p.is_ready ? '[就绪]' : '[未就绪]'}`);
    }
  } else if (screen === 'MODAL' && state.modal) {
    const md = state.modal;
    lines.push(`弹窗(${md.type || md.type_name}): 底层=${md.underlying_screen} | confirm=${md.confirm ?? md.can_confirm}(${md.confirm_label || '确认'}) dismiss=${md.dismiss ?? md.can_dismiss}`);
  } else if (screen === 'UNLOCK' && state.unlock) {
    lines.push(`解锁展示(${state.unlock.unlock_type}): ${(state.unlock.items || []).join(', ')} | 可确认=${state.unlock.can_confirm}`);
  } else if (screen === 'TIMELINE' && state.timeline) {
    const actionable = (state.timeline.slots || []).filter((s) => s.actionable ?? s.is_actionable);
    lines.push(`时间线: 可确认=${state.timeline.confirm ?? state.timeline.can_confirm_overlay} | 可选纪元: ${actionable.map((s) => `[${s.i ?? s.index}]${s.line || s.title}`).join(', ')}`);
  } else if (screen === 'GAME_OVER' && state.game_over) {
    const go = state.game_over;
    lines.push(`对局结束: ${go.victory ?? go.is_victory ? '胜利!' : '阵亡'} | 层数=${go.floor} | 阶段=${go.phase} | 存档=${go.save_status}`);
  }

  // 4. Glossary (only unseen terms)
  if (state.glossary && typeof state.glossary === 'object') {
    const newTerms = [];
    for (const [term, def] of Object.entries(state.glossary)) {
      if (full || !seenCache.hasGlossary(runId, term)) {
        seenCache.markGlossary(runId, term);
        newTerms.push(`${term}:${def}`);
      }
    }
    if (newTerms.length > 0) {
      lines.push(`新词条: ${newTerms.join(' | ')}`);
    }
  }

  // 5. Available actions footer
  const actionNames = Array.isArray(state.available_actions)
    ? state.available_actions
    : (Array.isArray(availableActions) ? availableActions.map((a) => a.name || a) : []);
  if (actionNames.length > 0) {
    lines.push(`可用动作: ${actionNames.join(', ')}`);
  }

  seenCache.save();
  return lines.join('\n');
}
