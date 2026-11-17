import { detectSessionContext, Sts2ApiError } from './api_client.js';
import { compressState, needsAssistConfirmation, parseHpPair, SeenCache } from './compressor.js';

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
    list.push({
      idx,
      enemy_id: e.enemy_id || e.name || '',
      hittable: e.hittable ?? e.is_hittable ?? true,
      intent: e.intent || '',
      move_id: e.move_id || '',
      intents,
    });
  }
  return list;
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
 * Detects whether combat state diverged in a way that invalidates the rest of the queued turn plan.
 * Returns null if safe to continue, or { reason, detail } if the queue should interrupt immediately.
 */
export function detectCombatDivergence(planState, preStepState, currentState, nextStep = null, stepIndex = 0, lastAction = null) {
  if (!planState || !currentState) {
    return { reason: 'state_unavailable', detail: '无法读取最新战斗状态' };
  }

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

  // Enemy spawn or intent escalation check
  const planEnemies = getAliveEnemySnapshot(planState);
  const curEnemies = getAliveEnemySnapshot(currentState);
  const planAliveMap = new Map(planEnemies.map((e) => [`${e.idx}:${e.enemy_id}`, e]));
  for (const ce of curEnemies) {
    const key = `${ce.idx}:${ce.enemy_id}`;
    const pe = planAliveMap.get(key);
    if (!pe) {
      return { reason: 'enemies_changed', detail: `场上出现新敌人或位置变化: [${ce.idx}] ${ce.enemy_id}` };
    }
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

    if (nextStep.action === 'play_card') {
      const hand = getHandList(currentState);
      const card = nextStep.card_cid !== undefined && nextStep.card_cid !== null
        ? hand.find((c) => (c.cid ?? c.combat_card_id) === nextStep.card_cid)
        : hand.find((c) => (c.i ?? c.index) === nextStep.card_index);

      if (!card) {
        return { reason: 'card_gone', detail: `后续出牌目标已不在手牌中` };
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
      if (validTargets.length > 0 && nextStep.target_index !== undefined && nextStep.target_index !== null) {
        const enemyStanding = curEnemies.some((e) => e.idx === nextStep.target_index && e.hittable);
        if (!validTargets.includes(nextStep.target_index) || !enemyStanding) {
          return { reason: 'target_gone', detail: `目标敌人 [${nextStep.target_index}] 已死亡或不可选中` };
        }
      }
    }
  }

  return null;
}

/**
 * Resolves a single step into exact POST /action payload fields using fresh state.
 */
function resolveActionBody(step, currentState, reasonText) {
  const body = { ...step };
  if (reasonText) {
    body.client_context = { decision_reason: reasonText };
  }

  if (body.action === 'play_card' && body.card_cid !== undefined && body.card_cid !== null) {
    const hand = getHandList(currentState);
    const matched = hand.find((c) => (c.cid ?? c.combat_card_id) === body.card_cid);
    if (!matched) {
      throw new Sts2ApiError(`卡牌 cid:${body.card_cid} 已不在手牌中`, { code: 'card_gone' });
    }
    body.card_index = matched.i ?? matched.index;
  }

  // Strip helper-only nullish fields
  for (const key of Object.keys(body)) {
    if (body[key] === undefined) delete body[key];
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
 * Executes a queued sequence of actions with combat divergence guards and optional auto-advance.
 * Returns { executed, stopReason, stopDetail, autoAdvanced, stateText, finalState }.
 */
export async function executeBatch(client, sequenceInput, {
  mode = 'auto',
  reason = null,
  full = false,
  seenCache = new SeenCache(),
  maxAutoAdvance = 8,
  settleTimeoutMs = 5000,
} = {}) {
  const rawSteps = parseActionSequence(sequenceInput);
  const initialSnap = await client.getSnapshot();
  let currentSnap = initialSnap;

  const isCombatQueue = currentSnap.state?.screen === 'COMBAT';
  const boundSteps = isCombatQueue ? bindHandCardCids(rawSteps, currentSnap.state) : rawSteps;
  const planState = currentSnap.state;

  const executed = [];
  let stopReason = 'completed';
  let stopDetail = null;
  let lastPreStepState = null;
  let lastExecutedAction = null;

  for (let idx = 0; idx < boundSteps.length; idx += 1) {
    const step = boundSteps[idx];

    // For steps after the first inside combat, verify state settled and didn't diverge.
    if (idx > 0 && isCombatQueue) {
      const waitRes = await client.waitUntilActionable({ timeoutMs: settleTimeoutMs, pollIntervalMs: 120 });
      currentSnap = waitRes.snapshot;
      if (waitRes.waitingForOthers) {
        stopReason = 'waiting_for_others';
        stopDetail = '等待联机队友行动';
        break;
      }

      const div = detectCombatDivergence(planState, lastPreStepState, currentSnap.state, step, idx, lastExecutedAction);
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
      actionBody = resolveActionBody(step, currentSnap.state, reason);
    } catch (err) {
      stopReason = err instanceof Sts2ApiError ? err.code : 'invalid_step';
      stopDetail = err.message;
      break;
    }

    let actionResult;
    try {
      actionResult = await client.postAction(actionBody);
    } catch (err) {
      stopReason = err instanceof Sts2ApiError ? err.code : 'action_error';
      stopDetail = err.message;
      // Re-sync latest state after rejection so caller sees exact live screen
      try {
        currentSnap = await client.getSnapshot();
      } catch {
        // Keep last known snapshot
      }
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
      // Wait for next step inside loop
      currentSnap = {
        state: actionResult?.state || (await client.getSnapshot()).state,
        available_actions: actionResult?.state?.available_actions || [],
      };
    } else {
      // Last step in queue: wait briefly for game animations/turn transition to settle before reporting!
      const waitEnd = await client.waitUntilActionable({ timeoutMs: settleTimeoutMs, pollIntervalMs: 140 });
      currentSnap = waitEnd.snapshot;
    }
  }

  // Optional auto-advance over zero-branch screens in `auto` mode
  const autoAdvanced = [];
  if (mode === 'auto' && (stopReason === 'completed' || stopReason === 'screen_changed')) {
    const rewardHistory = new Set();
    for (let k = 0; k < maxAutoAdvance; k += 1) {
      const waitRes = await client.waitUntilActionable({ timeoutMs: settleTimeoutMs, pollIntervalMs: 140 });
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
    const finalWait = await client.waitUntilActionable({ timeoutMs: 2500, pollIntervalMs: 140 });
    currentSnap = finalWait.snapshot;
  }

  const bannerParts = [`[执行结果] 已执行 ${executed.length}/${boundSteps.length} 步 | 停止原因:${stopReason}`];
  if (stopDetail) bannerParts.push(stopDetail);
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
    stateText,
    finalState: currentSnap.state,
  };
}
