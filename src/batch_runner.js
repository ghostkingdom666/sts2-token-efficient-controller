import { detectSessionContext, isTransientReadinessBlock, Sts2ApiError } from './api_client.js';
import { compressState, needsAssistConfirmation, parseHpPair, SeenCache } from './compressor.js';

const TRANSIENT_POST_CODES = new Set([
  'action_in_flight',
  'invalid_action',
  'combat_actions_not_ready',
  'snapshot_stabilizing',
  'state_unavailable',
]);

const RETARGET_THORNS_REGEX = /THORNS|SHARP_HIDE|FLAME_BARRIER|SPIK|COUNTER|RETALIAT|BARB|荆棘|尖刺|反伤|反击|火焰屏障|被攻击.*伤害|受到攻击.*造成/i;
const RETARGET_SPECIAL_REGEX = /ANGER|ENRAGE|MALLEABLE|CURL_UP|MODE_SHIFT|SPLIT|SPORE_CLOUD|EXPLOSIVE|REACTIVE|SLEEP|ASLEEP|DORMANT|UNAWAKENED|INTANGIBLE|INVINCIBLE|HARDENED_SHELL|SLIPPERY|SHIFTING|BEAT_OF_DEATH|TIME_WARP|CURIOSITY|激怒|暴怒|韧性|柔韧|蜷缩|分裂|孢子|爆炸|模式切换|反应性|沉睡|休眠|唤醒|无实体|无敌|坚硬外壳|死亡时.*造成|死亡时.*易伤|受击.*力量|受击.*格挡|受到攻击.*格挡|受到攻击.*力量/i;
const SLEEP_INTENT_REGEX = /SLEEP|DORMANT|ASLEEP/i;

function parseIntegerToken(token, label) {
  const num = Number.parseInt(String(token), 10);
  if (!Number.isFinite(num)) {
    throw new Error(`无效的整数参数 (${label}): "${token}"`);
  }
  return num;
}

/**
 * Parses a compact action sequence string (or array of action objects) into normalized steps.
 * Examples:
 *   "play 0 0; play 2; end"
 *   "p cid:14 0; potion 0 0; end"
 *   "map 1"
 *   "pick_card 0; collect"
 */
export function parseActionSequence(input) {
  if (Array.isArray(input)) {
    return input.map((step) => ({ ...step }));
  }
  if (typeof input !== 'string') {
    throw new Error('动作序列必须是字符串或动作数组');
  }

  const chunks = input
    .split(/[;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (chunks.length === 0) {
    throw new Error('动作序列不能为空');
  }

  const steps = [];
  for (const chunk of chunks) {
    if (chunk.startsWith('raw ')) {
      const jsonPart = chunk.slice(4).trim();
      const parsed = JSON.parse(jsonPart);
      if (!parsed || typeof parsed !== 'object' || !parsed.action) {
        throw new Error(`raw 指令缺少 action 字段: ${chunk}`);
      }
      steps.push(parsed);
      continue;
    }

    if (chunk.startsWith('{')) {
      const parsed = JSON.parse(chunk);
      if (!parsed || typeof parsed !== 'object' || !parsed.action) {
        throw new Error(`JSON 指令缺少 action 字段: ${chunk}`);
      }
      steps.push(parsed);
      continue;
    }

    const parts = chunk.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case 'p':
      case 'play':
      case 'play_card': {
        if (parts.length < 2) throw new Error(`play 指令缺少卡牌索引: "${chunk}"`);
        const step = { action: 'play_card' };
        const cardTok = parts[1];
        if (cardTok.toLowerCase().startsWith('cid:')) {
          step.card_cid = parseIntegerToken(cardTok.slice(4), 'card_cid');
        } else {
          step.card_index = parseIntegerToken(cardTok, 'card_index');
        }
        if (parts[2] !== undefined) {
          step.target_index = parseIntegerToken(parts[2], 'target_index');
        }
        steps.push(step);
        break;
      }

      case 'end':
      case 'end_turn':
        steps.push({ action: 'end_turn' });
        break;

      case 'pot':
      case 'potion':
      case 'use_potion': {
        if (parts.length < 2) throw new Error(`potion 指令缺少药水槽索引: "${chunk}"`);
        const step = {
          action: 'use_potion',
          option_index: parseIntegerToken(parts[1], 'option_index'),
        };
        if (parts[2] !== undefined) {
          step.target_index = parseIntegerToken(parts[2], 'target_index');
        }
        steps.push(step);
        break;
      }

      case 'discard_potion':
        if (parts.length < 2) throw new Error(`discard_potion 缺少索引: "${chunk}"`);
        steps.push({ action: 'discard_potion', option_index: parseIntegerToken(parts[1], 'option_index') });
        break;

      case 'map':
      case 'choose_map_node':
        if (parts.length < 2) throw new Error(`map 指令缺少节点索引: "${chunk}"`);
        steps.push({ action: 'choose_map_node', option_index: parseIntegerToken(parts[1], 'option_index') });
        break;

      case 'reward':
      case 'claim_reward':
        if (parts.length < 2) throw new Error(`reward 指令缺少索引: "${chunk}"`);
        steps.push({ action: 'claim_reward', option_index: parseIntegerToken(parts[1], 'option_index') });
        break;

      case 'pick_card':
      case 'choose_reward_card':
        if (parts.length < 2) throw new Error(`pick_card 指令缺少卡牌索引: "${chunk}"`);
        steps.push({ action: 'choose_reward_card', option_index: parseIntegerToken(parts[1], 'option_index') });
        break;

      case 'skip_card':
      case 'skip_reward_cards':
        steps.push({ action: 'skip_reward_cards' });
        break;

      case 'collect':
      case 'collect_rewards_and_proceed':
        steps.push({ action: 'collect_rewards_and_proceed' });
        break;

      case 'resolve_rewards': {
        const step = { action: 'resolve_rewards' };
        if (parts[1] !== undefined) step.option_index = parseIntegerToken(parts[1], 'option_index');
        steps.push(step);
        break;
      }

      case 'event':
      case 'choose_event_option':
        if (parts.length < 2) throw new Error(`event 指令缺少选项索引: "${chunk}"`);
        steps.push({ action: 'choose_event_option', option_index: parseIntegerToken(parts[1], 'option_index') });
        break;

      case 'rest':
      case 'choose_rest_option': {
        if (parts.length < 2) throw new Error(`rest 指令缺少选项索引: "${chunk}"`);
        const step = { action: 'choose_rest_option', option_index: parseIntegerToken(parts[1], 'option_index') };
        if (parts[2] !== undefined) step.target_index = parseIntegerToken(parts[2], 'target_index');
        steps.push(step);
        break;
      }

      case 'chest':
      case 'open_chest':
        steps.push({ action: 'open_chest' });
        break;

      case 'treasure':
      case 'choose_treasure_relic':
        steps.push({
          action: 'choose_treasure_relic',
          option_index: parts[1] !== undefined ? parseIntegerToken(parts[1], 'option_index') : 0,
        });
        break;

      case 'shop': {
        const sub = (parts[1] || 'open').toLowerCase();
        if (sub === 'open') steps.push({ action: 'open_shop_inventory' });
        else if (sub === 'close') steps.push({ action: 'close_shop_inventory' });
        else if (sub === 'remove') steps.push({ action: 'remove_card_at_shop' });
        else throw new Error(`未知 shop 子指令: "${chunk}"`);
        break;
      }

      case 'open_shop':
      case 'open_shop_inventory':
        steps.push({ action: 'open_shop_inventory' });
        break;

      case 'close_shop':
      case 'close_shop_inventory':
        steps.push({ action: 'close_shop_inventory' });
        break;

      case 'buy_card':
        steps.push({ action: 'buy_card', option_index: parseIntegerToken(parts[1], 'option_index') });
        break;
      case 'buy_relic':
        steps.push({ action: 'buy_relic', option_index: parseIntegerToken(parts[1], 'option_index') });
        break;
      case 'buy_potion':
        steps.push({ action: 'buy_potion', option_index: parseIntegerToken(parts[1], 'option_index') });
        break;
      case 'buy_blitz':
      case 'buy_blitz_entry':
        steps.push({ action: 'buy_blitz_entry', option_index: parseIntegerToken(parts[1], 'option_index') });
        break;
      case 'remove_card':
      case 'remove_card_at_shop':
        steps.push({ action: 'remove_card_at_shop' });
        break;

      case 'select':
      case 'select_deck_card':
        if (parts.length < 2) throw new Error(`select 指令缺少卡牌索引: "${chunk}"`);
        steps.push({ action: 'select_deck_card', option_index: parseIntegerToken(parts[1], 'option_index') });
        break;

      case 'confirm':
      case 'confirm_selection':
        steps.push({ action: 'confirm_selection' });
        break;

      case 'bundle':
      case 'choose_bundle':
        steps.push({ action: 'choose_bundle', option_index: parseIntegerToken(parts[1], 'option_index') });
        break;
      case 'confirm_bundle':
        steps.push({ action: 'confirm_bundle' });
        break;

      case 'crystal':
      case 'crystal_clear_cell': {
        if (parts.length < 3) throw new Error(`crystal 指令需要 x y: "${chunk}"`);
        const step = {
          action: 'crystal_clear_cell',
          x: parseIntegerToken(parts[1], 'x'),
          y: parseIntegerToken(parts[2], 'y'),
        };
        if (parts[3]) step.tool = parts[3].toLowerCase();
        steps.push(step);
        break;
      }

      case 'crystal_tool':
      case 'crystal_set_tool':
        if (!parts[1]) throw new Error(`crystal_tool 需要 big 或 small: "${chunk}"`);
        steps.push({ action: 'crystal_set_tool', tool: parts[1].toLowerCase() });
        break;

      case 'proceed':
        steps.push({ action: 'proceed' });
        break;

      case 'modal': {
        const sub = (parts[1] || 'confirm').toLowerCase();
        steps.push({ action: sub === 'dismiss' ? 'dismiss_modal' : 'confirm_modal' });
        break;
      }

      case 'confirm_modal':
      case 'dismiss_modal':
      case 'confirm_unlock':
      case 'close_cards_view':
      case 'close_main_menu_submenu':
      case 'open_timeline':
      case 'confirm_timeline_overlay':
      case 'continue_run':
      case 'continue_game_over':
      case 'dismiss_game_over_wait':
      case 'embark':
      case 'unready':
      case 'host_multiplayer_lobby':
      case 'join_multiplayer_lobby':
      case 'ready_multiplayer_lobby':
      case 'disconnect_multiplayer_lobby':
      case 'increase_ascension':
      case 'decrease_ascension':
      case 'return_to_main_menu':
      case 'save_and_quit':
      case 'abandon_run':
      case 'invite_ai_teammate':
      case 'continue_ai_teammate':
        steps.push({ action: cmd });
        break;

      case 'continue':
        steps.push({ action: 'continue_run' });
        break;

      case 'char':
      case 'select_character':
        if (parts.length < 2) throw new Error(`char 指令缺少索引: "${chunk}"`);
        steps.push({ action: 'select_character', option_index: parseIntegerToken(parts[1], 'option_index') });
        break;

      case 'new_run':
      case 'open_character_select': {
        const step = { action: 'open_character_select' };
        if (parts[1]) step.mode = parts[1].toLowerCase();
        steps.push(step);
        break;
      }

      case 'timeline':
      case 'choose_timeline_epoch':
        steps.push({ action: 'choose_timeline_epoch', option_index: parseIntegerToken(parts[1], 'option_index') });
        break;

      default:
        if (parts.length === 1) {
          steps.push({ action: cmd });
        } else if (parts.length === 2 && /^-?\d+$/.test(parts[1])) {
          steps.push({ action: cmd, option_index: Number.parseInt(parts[1], 10) });
        } else {
          throw new Error(`无法识别的动作指令: "${chunk}"`);
        }
    }
  }

  return steps;
}

function getHandList(state) {
  return Array.isArray(state?.combat?.hand) ? state.combat.hand : [];
}

function getHandCids(state) {
  return getHandList(state)
    .map((c) => c.cid ?? c.combat_card_id)
    .filter((v) => v !== null && v !== undefined);
}

function getLocalHp(state) {
  const p = state?.combat?.player;
  if (!p) return null;
  return parseHpPair(p.hp, p.current_hp, p.max_hp).current;
}

function normalizePowerText(pw) {
  if (typeof pw === 'string') return pw;
  if (pw && typeof pw === 'object') {
    return [pw.power_id, pw.id, pw.name, pw.line, pw.description].filter(Boolean).join(' ');
  }
  return '';
}

function getAliveEnemySnapshot(state) {
  const enemies = Array.isArray(state?.combat?.enemies) ? state.combat.enemies : [];
  const list = [];
  for (const e of enemies) {
    if ((e.alive ?? e.is_alive ?? true) === false) continue;
    const idx = e.i ?? e.index;
    const intents = Array.isArray(e.intents)
      ? e.intents.map((it) => ({
          type: it.intent_type || '',
          dmg: it.damage ?? null,
          tot: it.total_damage ?? null,
          hits: it.hits ?? null,
        }))
      : [];
    let totalAttackDamage = 0;
    for (const it of intents) {
      if (it.type === 'Attack') {
        if (typeof it.tot === 'number') totalAttackDamage += it.tot;
        else if (typeof it.dmg === 'number') totalAttackDamage += it.dmg * (typeof it.hits === 'number' ? it.hits : 1);
      }
    }
    list.push({
      idx,
      instance_id: e.instance_id ?? e.id ?? e.uid ?? null,
      enemy_id: e.enemy_id || e.name || '',
      name: e.name || e.enemy_id || '敌人',
      hp: parseHpPair(e.hp, e.current_hp, e.max_hp),
      block: e.block ?? 0,
      powers: Array.isArray(e.powers) ? e.powers : [],
      hittable: e.hittable ?? e.is_hittable ?? true,
      intent: e.intent || '',
      move_id: e.move_id || '',
      intents,
      totalAttackDamage,
    });
  }
  return list;
}

function scoreEnemyPair(pe, ce) {
  if (pe.enemy_id && ce.enemy_id && pe.enemy_id !== ce.enemy_id) {
    return Number.NEGATIVE_INFINITY;
  }
  let score = 10;
  if (pe.hp?.max > 0 && ce.hp?.max > 0) {
    score += pe.hp.max === ce.hp.max ? 15 : -15;
  }
  if (pe.move_id && ce.move_id && pe.move_id === ce.move_id) {
    score += 25;
  } else if (pe.intent && ce.intent && pe.intent === ce.intent) {
    score += 20;
  }
  if (pe.hp?.max > 0 && ce.hp?.max > 0) {
    if (ce.hp.current <= pe.hp.current) {
      const drop = pe.hp.current - ce.hp.current;
      score += Math.max(0, 15 - Math.min(15, drop / 5));
    } else {
      score -= 10;
    }
  }
  if (pe.idx === ce.idx) {
    score += 2;
  }
  return score;
}

/**
 * Matches surviving enemies across states while tolerating teammate kills that shift array indices left.
 */
export function matchEnemiesAcrossStates(planEnemies, curEnemies) {
  const matchedPairs = [];
  const curToPlan = new Map();
  const planIdxToCur = new Map();
  const usedPlanIdx = new Set();
  const usedCurIdx = new Set();

  // Pass 1: exact instance_id matching when exposed by the mod.
  for (const ce of curEnemies) {
    if (ce.instance_id === null || ce.instance_id === undefined) continue;
    const pe = planEnemies.find((p) => !usedPlanIdx.has(p.idx) && p.instance_id === ce.instance_id);
    if (pe) {
      usedPlanIdx.add(pe.idx);
      usedCurIdx.add(ce.idx);
      matchedPairs.push({ plan: pe, cur: ce });
      curToPlan.set(ce.idx, pe);
      planIdxToCur.set(pe.idx, ce);
    }
  }

  // Pass 2: order-preserving sequence alignment on remaining enemies.
  const remPlan = planEnemies.filter((p) => !usedPlanIdx.has(p.idx));
  const remCur = curEnemies.filter((c) => !usedCurIdx.has(c.idx));

  if (remPlan.length > 0 && remCur.length > 0) {
    const memo = new Map();
    const solve = (ci, pi) => {
      if (ci >= remCur.length) return { score: 0, pairs: [] };
      if (pi >= remPlan.length) {
        return { score: -1000 * (remCur.length - ci), pairs: [] };
      }
      const key = `${ci}:${pi}`;
      if (memo.has(key)) return memo.get(key);

      // Option 1: skip plan[pi] (treated as killed)
      let best = solve(ci, pi + 1);

      // Option 2: match cur[ci] <-> plan[pi]
      const pairScore = scoreEnemyPair(remPlan[pi], remCur[ci]);
      if (Number.isFinite(pairScore)) {
        const sub = solve(ci + 1, pi + 1);
        const total = pairScore + sub.score;
        if (total > best.score) {
          best = { score: total, pairs: [{ plan: remPlan[pi], cur: remCur[ci] }, ...sub.pairs] };
        }
      }

      // Option 3: skip cur[ci] (treated as newly spawned)
      const skipCur = solve(ci + 1, pi);
      if (skipCur.score - 1000 > best.score) {
        best = { score: skipCur.score - 1000, pairs: skipCur.pairs };
      }

      memo.set(key, best);
      return best;
    };

    const aligned = solve(0, 0);
    for (const pair of aligned.pairs) {
      usedPlanIdx.add(pair.plan.idx);
      usedCurIdx.add(pair.cur.idx);
      matchedPairs.push(pair);
      curToPlan.set(pair.cur.idx, pair.plan);
      planIdxToCur.set(pair.plan.idx, pair.cur);
    }
  }

  const spawned = curEnemies.filter((c) => !usedCurIdx.has(c.idx));
  return { matchedPairs, curToPlan, planIdxToCur, spawned };
}

/**
 * Optimization 3 safety gate: returns true only when an enemy is hittable and free of
 * thorns/retaliation or special trigger powers (split/enrage/curl-up/sleep/intangible/etc.).
 */
export function isSafeRetargetEnemy(enemy) {
  if (!enemy || enemy.hittable === false) return false;
  if (SLEEP_INTENT_REGEX.test(enemy.intent || '') || SLEEP_INTENT_REGEX.test(enemy.move_id || '')) {
    return false;
  }
  const powers = Array.isArray(enemy.powers) ? enemy.powers : [];
  for (const pw of powers) {
    const text = normalizePowerText(pw);
    if (!text) continue;
    if (RETARGET_THORNS_REGEX.test(text) || RETARGET_SPECIAL_REGEX.test(text)) {
      return false;
    }
  }
  return true;
}

/**
 * Picks a safe replacement target for a single-target card when the original target died (e.g. killed by teammate).
 */
export function pickSafeRetarget(card, curEnemies, { retargetMode = 'safe' } = {}) {
  if (!card || retargetMode === 'off') return null;
  const validTargets = Array.isArray(card.targets)
    ? card.targets
    : (Array.isArray(card.valid_target_indices) ? card.valid_target_indices : []);
  const vsList = Array.isArray(card.vs) ? card.vs : [];

  const candidates = curEnemies.filter((e) => {
    if (e.hittable === false) return false;
    if (validTargets.length > 0 && !validTargets.includes(e.idx)) return false;
    if (retargetMode === 'safe') {
      if (!isSafeRetargetEnemy(e)) return false;
      const vsEntry = vsList.find((v) => v.enemy === e.idx);
      if (vsEntry) {
        const dmg = vsEntry.damage ?? vsEntry.per_hit ?? null;
        if (dmg === 0) return false;
      }
    }
    return true;
  });

  if (candidates.length === 0) return null;

  const ranked = candidates.map((e) => {
    const vsEntry = vsList.find((v) => v.enemy === e.idx);
    const kills = Boolean(
      vsEntry?.kills
      || (vsEntry && typeof vsEntry.damage === 'number' && vsEntry.damage >= (e.hp?.current ?? 0) + (e.block ?? 0)),
    );
    const effectiveHp = (e.hp?.current ?? 0) + (e.block ?? 0);
    return {
      enemy: e,
      kills: kills ? 1 : 0,
      threat: e.totalAttackDamage ?? 0,
      effectiveHp,
    };
  });

  ranked.sort((a, b) => (
    (b.kills - a.kills)
    || (b.threat - a.threat)
    || (a.effectiveHp - b.effectiveHp)
    || (a.enemy.idx - b.enemy.idx)
  ));

  return ranked[0].enemy;
}

/**
 * Binds initial hand indices in queued play_card steps to stable combat card IDs (`cid`)
 * so that earlier card plays shifting hand indices do not misplay later queued cards.
 */
export function bindHandCardCids(steps, initialState) {
  const hand = getHandList(initialState);
  return steps.map((step) => {
    if (step.action !== 'play_card') return { ...step };
    if (step.card_cid !== undefined && step.card_cid !== null) {
      return { ...step };
    }
    if (step.card_index !== undefined && step.card_index !== null) {
      const card = hand.find((c) => (c.i ?? c.index) === step.card_index);
      const cid = card ? (card.cid ?? card.combat_card_id ?? null) : null;
      if (cid !== null && cid !== undefined) {
        return { ...step, card_cid: cid };
      }
    }
    return { ...step };
  });
}

/**
 * Records initial enemy target indices so cross-step enemy deaths shifting indices left
 * can be safely remapped instead of falsely aborting or hitting the wrong slot.
 */
export function bindStepTargets(steps, initialState) {
  const planEnemies = getAliveEnemySnapshot(initialState);
  return steps.map((step) => {
    if (
      (step.action === 'play_card' || step.action === 'use_potion')
      && step.target_index !== undefined
      && step.target_index !== null
    ) {
      return {
        ...step,
        _planTargetIdx: step.target_index,
        _planEnemySnapshotCount: planEnemies.length,
      };
    }
    return { ...step };
  });
}

/**
 * Detects whether combat state diverged in a way that invalidates the rest of the queued turn plan.
 * Returns null if safe to continue, or { reason, detail } if the queue should interrupt immediately.
 */
export function detectCombatDivergence(planState, preStepState, currentState, nextStep = null, stepIndex = 0, lastAction = null, options = {}) {
  if (!planState || !currentState) {
    return { reason: 'state_unavailable', detail: '无法读取最新战斗状态' };
  }

  const retargetMode = options.retargetMode ?? 'safe';
  const curScreen = currentState.screen;
  const readiness = currentState.combat?.action_readiness;
  if (
    currentState.selection
    || currentState.modal
    || readiness?.hand_in_card_selection === true
    || curScreen === 'CARD_SELECTION'
    || curScreen === 'MODAL'
  ) {
    return { reason: 'pending_choice', detail: '触发了选牌或确认弹窗，暂停后续出牌' };
  }

  if (curScreen !== planState.screen) {
    return { reason: 'screen_changed', detail: `界面已从 ${planState.screen} 切换为 ${curScreen}` };
  }

  if (planState.turn !== null && planState.turn !== undefined && currentState.turn !== null && currentState.turn !== undefined) {
    if (planState.turn !== currentState.turn) {
      return { reason: 'turn_changed', detail: `回合数从 T${planState.turn} 变为 T${currentState.turn}` };
    }
  }

  // Check for newly drawn / generated cards using stable cid first, with hand-count fallback for mocks without cid.
  const planCids = getHandCids(planState);
  const curCids = getHandCids(currentState);
  if (planCids.length > 0 && curCids.length > 0) {
    const planSet = new Set(planCids);
    const added = curCids.filter((cid) => !planSet.has(cid));
    if (added.length > 0) {
      return { reason: 'new_cards', detail: `手牌新增 ${added.length} 张牌 (cid:${added.join(',')})，中断队列重新规划` };
    }
  } else if (preStepState) {
    const prevCount = getHandList(preStepState).length;
    const curCount = getHandList(currentState).length;
    const drewOrGenerated = lastAction === 'play_card' ? curCount >= prevCount : curCount > prevCount;
    if (drewOrGenerated) {
      return { reason: 'new_cards', detail: `出牌后手牌增加或触发抽牌 (${prevCount} -> ${curCount})，中断队列重新规划` };
    }
  }

  const hpBefore = getLocalHp(planState);
  const hpAfter = getLocalHp(currentState);
  if (hpBefore !== null && hpAfter !== null && hpAfter < hpBefore) {
    return { reason: 'took_damage', detail: `我方生命减少 (${hpBefore} -> ${hpAfter})，中断队列重新评估` };
  }

  // Order-preserving enemy matching across teammate kills & index shifts
  const planEnemies = getAliveEnemySnapshot(planState);
  const curEnemies = getAliveEnemySnapshot(currentState);
  const { matchedPairs, planIdxToCur, spawned } = matchEnemiesAcrossStates(planEnemies, curEnemies);

  if (spawned.length > 0) {
    const s = spawned[0];
    return { reason: 'enemies_changed', detail: `场上出现新敌人或位置变化: [${s.idx}] ${s.enemy_id}` };
  }

  for (const { plan: pe, cur: ce } of matchedPairs) {
    if (pe.intent !== ce.intent || pe.move_id !== ce.move_id) {
      return { reason: 'intent_changed', detail: `敌人 [${ce.idx}] 意图变化 (${pe.intent} -> ${ce.intent})` };
    }
  }

  // Validate next planned step against fresh state
  if (nextStep) {
    const avail = Array.isArray(currentState.available_actions) ? currentState.available_actions : [];
    if (avail.length > 0 && !avail.includes(nextStep.action)) {
      return { reason: 'illegal_action', detail: `第 ${stepIndex + 1} 步动作 ${nextStep.action} 当前不可用` };
    }

    const origTargetIdx = nextStep._planTargetIdx ?? nextStep.target_index;

    if (nextStep.action === 'play_card') {
      const hand = getHandList(currentState);
      const card = nextStep.card_cid !== undefined && nextStep.card_cid !== null
        ? hand.find((c) => (c.cid ?? c.combat_card_id) === nextStep.card_cid)
        : hand.find((c) => (c.i ?? c.index) === nextStep.card_index);

      if (!card) {
        return { reason: 'card_gone', detail: '后续出牌目标已不在手牌中' };
      }
      if (!card.playable) {
        return {
          reason: 'card_unplayable',
          detail: `后续卡牌 ${card.line || card.name || card.card_id} 当前不可打出 (${card.why || card.unplayable_reason || 'unplayable'})`,
        };
      }

      const validTargets = Array.isArray(card.targets)
        ? card.targets
        : (Array.isArray(card.valid_target_indices) ? card.valid_target_indices : []);
      if (validTargets.length > 0 && origTargetIdx !== undefined && origTargetIdx !== null) {
        const mappedEnemy = planIdxToCur.get(origTargetIdx);
        const mappedAlive = Boolean(mappedEnemy && mappedEnemy.hittable && validTargets.includes(mappedEnemy.idx));
        if (!mappedAlive) {
          if (retargetMode === 'off') {
            return { reason: 'target_gone', detail: `目标敌人 [${origTargetIdx}] 已死亡或不可选中` };
          }
          const safeCandidate = pickSafeRetarget(card, curEnemies, { retargetMode });
          if (!safeCandidate) {
            const anyAliveTarget = curEnemies.some((e) => e.hittable && validTargets.includes(e.idx));
            return {
              reason: 'target_gone',
              detail: anyAliveTarget
                ? `目标敌人 [${origTargetIdx}] 已死亡，剩余敌人存在反伤/特殊机制，已安全中断`
                : `目标敌人 [${origTargetIdx}] 已死亡或不可选中`,
            };
          }
        }
      }
    } else if (nextStep.action === 'use_potion' && origTargetIdx !== undefined && origTargetIdx !== null) {
      const mappedEnemy = planIdxToCur.get(origTargetIdx);
      if (!mappedEnemy || !mappedEnemy.hittable) {
        return { reason: 'target_gone', detail: `目标敌人 [${origTargetIdx}] 已死亡，药水不自动转火` };
      }
    }
  }

  return null;
}

/**
 * Resolves a single step into exact POST /action payload fields using fresh state.
 * Handles hand cid re-resolution, shifted enemy index remapping, and safe retargeting.
 */
function resolveActionBody(step, currentState, reasonText, {
  planEnemies = null,
  retargetMode = 'safe',
  retargetedNotes = null,
} = {}) {
  const body = { ...step };
  if (reasonText) {
    body.client_context = { decision_reason: reasonText };
  }

  let matchedCard = null;
  if (body.action === 'play_card' && body.card_cid !== undefined && body.card_cid !== null) {
    const hand = getHandList(currentState);
    matchedCard = hand.find((c) => (c.cid ?? c.combat_card_id) === body.card_cid);
    if (!matchedCard) {
      throw new Sts2ApiError(`卡牌 cid:${body.card_cid} 已不在手牌中`, { code: 'card_gone' });
    }
    body.card_index = matchedCard.i ?? matchedCard.index;
  } else if (body.action === 'play_card' && body.card_index !== undefined && body.card_index !== null) {
    const hand = getHandList(currentState);
    matchedCard = hand.find((c) => (c.i ?? c.index) === body.card_index) || null;
  }

  const origTargetIdx = step._planTargetIdx ?? step.target_index;
  if (
    currentState?.screen === 'COMBAT'
    && (body.action === 'play_card' || body.action === 'use_potion')
    && origTargetIdx !== undefined
    && origTargetIdx !== null
  ) {
    const curEnemies = getAliveEnemySnapshot(currentState);
    const refPlanEnemies = Array.isArray(planEnemies) ? planEnemies : curEnemies;
    const { planIdxToCur } = matchEnemiesAcrossStates(refPlanEnemies, curEnemies);
    const mapped = planIdxToCur.get(origTargetIdx);

    if (mapped && mapped.hittable) {
      body.target_index = mapped.idx;
    } else if (body.action === 'play_card' && matchedCard && retargetMode !== 'off') {
      const candidate = pickSafeRetarget(matchedCard, curEnemies, { retargetMode });
      if (candidate) {
        body.target_index = candidate.idx;
        if (Array.isArray(retargetedNotes)) {
          retargetedNotes.push(`自动转火:[${origTargetIdx}]->[${candidate.idx}]${candidate.name}`);
        }
      }
    }
  }

  // Strip internal helper-only fields and nullish values
  for (const key of Object.keys(body)) {
    if (key.startsWith('_') || body[key] === undefined) delete body[key];
  }
  return body;
}

/**
 * Determines whether the current screen is a trivial zero-branch step that can be auto-advanced.
 * Only advances in `auto` mode (never skips player choices in `assist` or `coop`).
 */
export function pickTrivialAutoAction(state, mode, history = new Set()) {
  if (mode !== 'auto' || !state || typeof state !== 'object') {
    return null;
  }

  const ctx = detectSessionContext(state);
  if (ctx.waitingForOthers) {
    return null;
  }

  const screen = state.screen;
  const avail = Array.isArray(state.available_actions) ? state.available_actions : [];

  if (screen === 'MODAL' && state.modal) {
    const canConfirm = state.modal.confirm ?? state.modal.can_confirm;
    if (canConfirm && avail.includes('confirm_modal')) {
      return { action: 'confirm_modal', label: '自动确认提示弹窗' };
    }
    return null;
  }

  if (screen === 'UNLOCK' && state.unlock?.can_confirm && avail.includes('confirm_unlock')) {
    return { action: 'confirm_unlock', label: '自动确认解锁界面' };
  }

  if (screen === 'EVENT' && state.event) {
    const opts = state.event.options || [];
    if (state.event.finished || state.event.is_finished) {
      if (opts.length >= 1 && avail.includes('choose_event_option')) {
        return { action: 'choose_event_option', option_index: opts[0].i ?? opts[0].index ?? 0, label: '自动离开已完成事件' };
      }
    } else if (opts.length === 1) {
      const only = opts[0];
      const locked = only.locked ?? only.is_locked;
      const kill = only.kill ?? only.will_kill_player;
      if (!locked && !kill && avail.includes('choose_event_option')) {
        return { action: 'choose_event_option', option_index: only.i ?? only.index ?? 0, label: '自动推进单一事件选项' };
      }
    }
    return null;
  }

  if (screen === 'REWARD' && state.reward) {
    if (state.reward.pending_card_choice) {
      return null; // Card choice always requires AI decision!
    }
    const key = `REWARD:${state.run_id}:${state.run?.floor ?? ''}`;
    if (!history.has(key) && avail.includes('collect_rewards_and_proceed')) {
      history.add(key);
      return { action: 'collect_rewards_and_proceed', label: '自动收取非卡牌战利品' };
    }
    return null;
  }

  if (screen === 'CHEST' && state.chest) {
    const opened = state.chest.opened ?? state.chest.is_opened;
    const claimed = state.chest.claimed ?? state.chest.has_relic_been_claimed;
    const relics = state.chest.relics || state.chest.relic_options || [];
    if (!opened && avail.includes('open_chest')) {
      return { action: 'open_chest', label: '自动打开宝箱' };
    }
    if (opened && !claimed && relics.length === 1 && avail.includes('choose_treasure_relic')) {
      return { action: 'choose_treasure_relic', option_index: relics[0].i ?? relics[0].index ?? 0, label: '自动拾取唯一宝箱遗物' };
    }
    if (opened && claimed && avail.includes('proceed')) {
      return { action: 'proceed', label: '自动离开宝箱房' };
    }
    return null;
  }

  if (screen === 'REST' && state.rest) {
    const opts = state.rest.options || [];
    const anyEnabled = opts.some((o) => (o.enabled ?? o.is_enabled) === true);
    if (!anyEnabled && avail.includes('proceed')) {
      return { action: 'proceed', label: '自动离开已完成休息点' };
    }
    return null;
  }

  if (screen === 'MAP' && state.map && !ctx.isMultiplayer) {
    const opts = state.map.options || state.map.available_nodes || [];
    if (opts.length === 1 && avail.includes('choose_map_node')) {
      return { action: 'choose_map_node', option_index: opts[0].i ?? opts[0].index ?? 0, label: '自动沿唯一道路前进' };
    }
    return null;
  }

  return null;
}

/**
 * Checks whether a freshly fetched snapshot still supports executing `step` right now
 * (meaning the prior POST rejection was a transient gate race rather than an illegal action).
 */
function isStepLegalInSnapshot(step, snapState, { planState, preStepState, stepIndex, lastAction, retargetMode } = {}) {
  if (!snapState) return false;
  if (detectSessionContext(snapState).waitingForOthers) return false;
  if (snapState.screen === 'COMBAT' && planState) {
    const div = detectCombatDivergence(planState, preStepState, snapState, step, stepIndex, lastAction, { retargetMode });
    if (div) return false;
    return true;
  }
  const avail = Array.isArray(snapState.available_actions) ? snapState.available_actions : [];
  return avail.length === 0 || avail.includes(step.action);
}

/**
 * Executes a queued sequence of actions with combat divergence guards, transient readiness retries,
 * multiplayer enemy-shift tolerance, safe retargeting, and optional auto-advance / turn wait.
 * Returns { executed, stopReason, stopDetail, autoAdvanced, retargeted, waitVia, stateText, finalState }.
 */
export async function executeBatch(client, sequenceInput, {
  mode = 'auto',
  reason = null,
  full = false,
  seenCache = new SeenCache(),
  maxAutoAdvance = 8,
  settleTimeoutMs = 5000,
  pollIntervalMs = 60,
  maxTransientRetries = 3,
  retarget = 'safe',
  waitForTurn = false,
  waitTimeoutMs = 120_000,
} = {}) {
  const retargetMode = ['safe', 'off', 'any'].includes(String(retarget).toLowerCase())
    ? String(retarget).toLowerCase()
    : 'safe';
  const rawSteps = parseActionSequence(sequenceInput);
  const initialSnap = await client.getSnapshot();
  let currentSnap = initialSnap;

  // Optimization 1a: if Step 0 hits a transient gate (e.g. Mod 200ms snapshot_stabilizing from teammate card), wait cleanly first!
  if (currentSnap.state?.screen === 'COMBAT' && isTransientReadinessBlock(currentSnap.state)) {
    const waitStart = await client.waitUntilActionable({ timeoutMs: settleTimeoutMs, pollIntervalMs });
    currentSnap = waitStart.snapshot;
  }

  const isCombatQueue = currentSnap.state?.screen === 'COMBAT';
  let boundSteps = isCombatQueue ? bindHandCardCids(rawSteps, currentSnap.state) : rawSteps;
  if (isCombatQueue) boundSteps = bindStepTargets(boundSteps, currentSnap.state);
  const planState = currentSnap.state;
  const planEnemies = isCombatQueue ? getAliveEnemySnapshot(planState) : [];

  const executed = [];
  const retargetedNotes = [];
  let stopReason = 'completed';
  let stopDetail = null;
  let waitVia = null;
  let lastPreStepState = null;
  let lastExecutedAction = null;

  for (let idx = 0; idx < boundSteps.length; idx += 1) {
    const step = boundSteps[idx];

    if (idx === 0 && isCombatQueue && detectSessionContext(currentSnap.state).waitingForOthers) {
      stopReason = 'waiting_for_others';
      stopDetail = '等待联机队友行动';
      break;
    }

    // For steps after the first inside combat, verify state settled and didn't diverge.
    if (idx > 0 && isCombatQueue) {
      const waitRes = await client.waitUntilActionable({ timeoutMs: settleTimeoutMs, pollIntervalMs });
      currentSnap = waitRes.snapshot;
      if (waitRes.waitingForOthers) {
        stopReason = 'waiting_for_others';
        stopDetail = '等待联机队友行动';
        break;
      }

      const div = detectCombatDivergence(planState, lastPreStepState, currentSnap.state, step, idx, lastExecutedAction, { retargetMode });
      if (div) {
        stopReason = div.reason;
        stopDetail = div.detail;
        break;
      }
      if (!waitRes.actionable) {
        stopReason = 'unsettled';
        stopDetail = '动作动画或回合结算尚未完成';
        break;
      }
    }

    lastPreStepState = currentSnap.state;

    let actionBody;
    try {
      actionBody = resolveActionBody(step, currentSnap.state, reason, {
        planEnemies,
        retargetMode,
        retargetedNotes,
      });
    } catch (err) {
      stopReason = err instanceof Sts2ApiError ? err.code : 'invalid_step';
      stopDetail = err.message;
      break;
    }

    let actionResult;
    let stepAbortedByRetryGuard = false;
    let transientAttempt = 0;
    while (true) {
      try {
        actionResult = await client.postAction(actionBody);
        break;
      } catch (err) {
        const isTransientCode = err instanceof Sts2ApiError && TRANSIENT_POST_CODES.has(err.code);
        if (isTransientCode && transientAttempt < maxTransientRetries) {
          let probeSnap = null;
          try {
            probeSnap = await client.getSnapshot();
          } catch {
            probeSnap = null;
          }

          if (probeSnap?.state) {
            currentSnap = probeSnap;
            const probeCtx = detectSessionContext(probeSnap.state);
            if (probeCtx.waitingForOthers) {
              stopReason = 'waiting_for_others';
              stopDetail = '等待联机队友行动';
              stepAbortedByRetryGuard = true;
              break;
            }
          }

          const shouldWaitAndRetry = !probeSnap?.state
            || err.code !== 'invalid_action'
            || isTransientReadinessBlock(probeSnap.state)
            || isStepLegalInSnapshot(step, probeSnap.state, {
              planState,
              preStepState: lastPreStepState,
              stepIndex: idx,
              lastAction: lastExecutedAction,
              retargetMode,
            });

          if (shouldWaitAndRetry) {
            transientAttempt += 1;
            const waitRetry = await client.waitUntilActionable({ timeoutMs: settleTimeoutMs, pollIntervalMs });
            currentSnap = waitRetry.snapshot;
            if (waitRetry.waitingForOthers) {
              stopReason = 'waiting_for_others';
              stopDetail = '等待联机队友行动';
              stepAbortedByRetryGuard = true;
              break;
            }
            if (isCombatQueue) {
              const div = detectCombatDivergence(planState, lastPreStepState, currentSnap.state, step, idx, lastExecutedAction, { retargetMode });
              if (div) {
                stopReason = div.reason;
                stopDetail = div.detail;
                stepAbortedByRetryGuard = true;
                break;
              }
            }
            if (waitRetry.actionable) {
              try {
                actionBody = resolveActionBody(step, currentSnap.state, reason, {
                  planEnemies,
                  retargetMode,
                  retargetedNotes,
                });
                continue;
              } catch (resolveErr) {
                stopReason = resolveErr instanceof Sts2ApiError ? resolveErr.code : 'invalid_step';
                stopDetail = resolveErr.message;
                stepAbortedByRetryGuard = true;
                break;
              }
            }
          }
        }

        stopReason = err instanceof Sts2ApiError ? err.code : 'action_error';
        stopDetail = err.message;
        try {
          currentSnap = await client.getSnapshot();
        } catch {
          // Keep last known snapshot
        }
        stepAbortedByRetryGuard = true;
        break;
      }
    }

    if (stepAbortedByRetryGuard) {
      break;
    }

    lastExecutedAction = actionBody.action;
    executed.push({
      step: idx,
      action: actionBody.action,
      status: actionResult?.status || 'completed',
      message: actionResult?.message || '',
    });

    if (actionResult?.status === 'failed') {
      stopReason = 'action_failed';
      stopDetail = actionResult.message || '动作执行失败';
      currentSnap = await client.getSnapshot();
      break;
    }

    if (actionResult?.status === 'pending' && idx < boundSteps.length - 1) {
      stopReason = 'pending';
      stopDetail = actionResult.message || '动作返回 pending，停止后续队列';
      currentSnap = await client.getSnapshot();
      break;
    }

    // Refresh snapshot after executing step
    if (idx < boundSteps.length - 1) {
      currentSnap = {
        state: actionResult?.state || (await client.getSnapshot()).state,
        available_actions: actionResult?.state?.available_actions || [],
      };
    } else {
      const waitEnd = await client.waitUntilActionable({ timeoutMs: settleTimeoutMs, pollIntervalMs });
      currentSnap = waitEnd.snapshot;
    }
  }

  // Optional auto-advance over zero-branch screens in `auto` mode
  const autoAdvanced = [];
  if (mode === 'auto' && (stopReason === 'completed' || stopReason === 'screen_changed')) {
    const rewardHistory = new Set();
    for (let k = 0; k < maxAutoAdvance; k += 1) {
      const waitRes = await client.waitUntilActionable({ timeoutMs: settleTimeoutMs, pollIntervalMs });
      currentSnap = waitRes.snapshot;
      if (waitRes.waitingForOthers || !waitRes.actionable) break;

      const trivial = pickTrivialAutoAction(currentSnap.state, mode, rewardHistory);
      if (!trivial) break;

      const body = { ...trivial };
      const label = body.label;
      delete body.label;
      if (reason) body.client_context = { decision_reason: label };

      try {
        const res = await client.postAction(body);
        autoAdvanced.push({ action: body.action, label, status: res?.status || 'completed' });
        if (res?.status === 'failed') break;
      } catch {
        break;
      }
    }
    const finalWait = await client.waitUntilActionable({ timeoutMs: 2500, pollIntervalMs });
    currentSnap = finalWait.snapshot;
  }

  // Optimization 4: if --wait is enabled and we ended in multiplayer waiting_for_others, block via SSE until next turn is ready
  if (waitForTurn && detectSessionContext(currentSnap.state).waitingForOthers) {
    const turnWait = await client.waitForTurnReady({ timeoutMs: waitTimeoutMs });
    if (turnWait.snapshot) currentSnap = turnWait.snapshot;
    waitVia = turnWait.via;
    if (turnWait.ready && stopReason === 'waiting_for_others') {
      stopReason = 'completed';
      stopDetail = null;
    }
  }

  const bannerParts = [`[执行结果] 已执行 ${executed.length}/${boundSteps.length} 步 | 停止原因:${stopReason}`];
  if (stopDetail) bannerParts.push(stopDetail);
  if (retargetedNotes.length > 0) bannerParts.push(retargetedNotes.join(', '));
  if (waitVia) bannerParts.push(`等回合:${waitVia}`);
  if (autoAdvanced.length > 0) {
    bannerParts.push(`自动过场:${autoAdvanced.map((a) => a.label).join(' -> ')}`);
  }

  const stateText = compressState(currentSnap.state, {
    availableActions: currentSnap.available_actions,
    mode,
    full,
    seenCache,
    extraBanner: bannerParts.join(' | '),
  });

  return {
    executed,
    stopReason,
    stopDetail,
    autoAdvanced,
    retargeted: retargetedNotes,
    waitVia,
    stateText,
    finalState: currentSnap.state,
  };
}
