import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  discoverInstances,
  detectSessionContext,
  isTransientReadinessBlock,
  Sts2Client,
} from '../src/api_client.js';
import { compressState, computeCombatSummary, SeenCache } from '../src/compressor.js';
import {
  bindHandCardCids,
  bindStepTargets,
  detectCombatDivergence,
  executeBatch,
  isSafeRetargetEnemy,
  matchEnemiesAcrossStates,
  parseActionSequence,
  pickSafeRetarget,
} from '../src/batch_runner.js';
import { lookupKeyword } from '../src/lookup.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sts2-ctrl-test-'));
}

function buildCombatStateFixture({
  turn = 1,
  hp = '68/80',
  block = 0,
  energy = 3,
  hand = null,
  enemies = null,
  withThreat = true,
  multiplayer = false,
} = {}) {
  const defaultHand = hand || [
    {
      i: 0,
      cid: 101,
      type: 'skill',
      card_id: 'SHRUG_IT_OFF',
      line: '耸肩无视 [1费]：获得 8 点 格挡 。抽 1 张牌。',
      upgraded: false,
      energy_cost: 1,
      star_cost: 0,
      values: [{ name: 'Block', base_value: 8, preview: 8 }],
      vs: null,
      playable: true,
      targets: [],
      keywords: ['格挡'],
    },
    {
      i: 1,
      cid: 102,
      type: 'attack',
      card_id: 'BASH',
      line: '痛击 [2费]：造成 8 点伤害。给予 2 层 易伤 。',
      upgraded: false,
      energy_cost: 2,
      star_cost: 0,
      values: [{ name: 'Damage', base_value: 8, preview: 8 }],
      vs: [{ enemy: 0, per_hit: 8, hits: 1, damage: 8, after_block: 8, kills: false }],
      playable: true,
      targets: [0],
      keywords: ['易伤'],
    },
    {
      i: 2,
      cid: 103,
      type: 'attack',
      card_id: 'STRIKE_IRONCLAD',
      line: '打击 [1费]：造成 6 点伤害。',
      upgraded: false,
      energy_cost: 1,
      star_cost: 0,
      values: [{ name: 'Damage', base_value: 6, preview: 6 }],
      vs: [{ enemy: 0, per_hit: 6, hits: 1, damage: 6, after_block: 6, kills: false }],
      playable: true,
      targets: [0],
      keywords: [],
    },
    {
      i: 3,
      cid: 104,
      type: 'skill',
      card_id: 'DEFEND_IRONCLAD',
      line: '防御 [1费]：获得 5 点 格挡 。',
      upgraded: false,
      energy_cost: 1,
      star_cost: 0,
      values: [{ name: 'Block', base_value: 5, preview: 5 }],
      vs: null,
      playable: true,
      targets: [],
      keywords: ['格挡'],
    },
  ];

  const defaultEnemies = enemies || [
    {
      i: 0,
      enemy_id: 'CULTIST',
      name: '邪教徒',
      hp: '48/50',
      block: 0,
      intent: 'PECK_MOVE',
      move_id: 'PECK_MOVE',
      powers: ['RITUAL 3: 每回合开始时获得 3 点力量。'],
      intents: [{ i: 0, intent_type: 'Attack', label: '6x2', damage: 6, hits: 2, total_damage: 12 }],
      alive: true,
      hittable: true,
    },
  ];

  const state = {
    version: 14,
    screen: 'COMBAT',
    in_combat: true,
    run_id: 'TEST_RUN_001',
    turn,
    session: {
      mode: multiplayer ? 'multiplayer' : 'singleplayer',
      phase: 'run',
      control_scope: 'local_player',
    },
    available_actions: ['play_card', 'end_turn'],
    combat: {
      action_readiness: { can_use_combat_actions: true, reason: 'ready' },
      player: {
        hp,
        block,
        energy,
        stars: 0,
        focus: 0,
        orbs: [],
        arrows: [],
        pets: [],
        powers: ['STRENGTH 2: 攻击额外造成 2 点伤害。'],
      },
      players: multiplayer
        ? [
            { player_id: '1', slot_index: 0, is_local: true, character_name: '铁甲战士', current_hp: 68, max_hp: 80, block, energy, is_alive: true },
            { player_id: '2', slot_index: 1, is_local: false, character_name: '静默猎手', current_hp: 55, max_hp: 70, block: 8, energy: 1, is_alive: true },
          ]
        : [
            { player_id: '1', slot_index: 0, is_local: true, character_name: '铁甲战士', current_hp: 68, max_hp: 80, block, energy, is_alive: true },
          ],
      end_turn_will_kill_player: false,
      lethal_risks: [],
      hand: defaultHand,
      draw: [{ line: '打击*3 [1费]：造成 6 点伤害。' }, { line: '防御*3 [1费]：获得 5 点 格挡 。' }],
      discard: [],
      exhaust: [],
      enemies: defaultEnemies,
    },
    run: {
      character: '铁甲战士',
      floor: 3,
      act_id: 'ACT_1',
      boss_id: 'SLIME_BOSS',
      hp,
      gold: 112,
      max_energy: 3,
      relics: ['燃烧之血', '钢笔尖'],
      relic_ids: ['BURNING_BLOOD', 'PEN_NIB'],
      relic_stacks: [null, 9],
      relic_descriptions: ['战斗结束时恢复 6 点生命。', '第 10 张攻击牌造成双倍伤害。'],
      potions: [
        { i: 0, potion_id: 'FIRE_POTION', line: '0: 火焰药水：对一名敌人造成 20 点伤害。', usable: true, targets: [0] },
        { i: 1, potion_id: null, line: '1: 空', usable: false, targets: [] },
      ],
    },
    glossary: {
      格挡: '格挡会优先抵消即将受到的伤害。',
      易伤: '易伤单位会承受更多攻击伤害。',
    },
  };

  if (withThreat) {
    state.combat.threat = {
      incoming: 12,
      block,
      block_needed: Math.max(0, 12 - block),
      unblocked: Math.max(0, 12 - block),
      hp_after: 68 - Math.max(0, 12 - block),
      lethal: false,
      end_of_turn_self_damage: 0,
      max_block: { block: 13, energy: 2, cids: [101, 104], cards: [0, 3] },
      kill_options: [],
    };
  }

  return state;
}

test('compressor achieves huge byte/token reduction and deduplicates seen terms across turns', () => {
  const tmpDir = makeTmpDir();
  const cacheFile = path.join(tmpDir, 'seen_cache.json');
  const seen = new SeenCache(cacheFile);

  const state1 = buildCombatStateFixture({ turn: 1 });
  const rawBytes = Buffer.byteLength(JSON.stringify(state1), 'utf8');
  const t1Text = compressState(state1, { mode: 'auto', seenCache: seen });
  const t1Bytes = Buffer.byteLength(t1Text, 'utf8');

  assert.ok(t1Bytes < rawBytes * 0.4, `Expected T1 compressed output (${t1Bytes}B) to be <40% of raw JSON (${rawBytes}B)`);
  assert.match(t1Text, /\[战局算术\] 来袭总伤:12 \| 护甲缺口:12 \| 最大可叠甲:13 \| 手牌直伤上限:14/);
  assert.match(t1Text, /钢笔尖\(9\)/);
  assert.match(t1Text, /造成 8 点伤害。给予 2 层 易伤/);
  assert.match(t1Text, /\[0\] 火焰药水/);

  // Turn 2 with same run_id & cards: rule descriptions and glossary should be omitted!
  const state2 = buildCombatStateFixture({ turn: 2, block: 5 });
  const seenReloaded = new SeenCache(cacheFile);
  const t2Text = compressState(state2, { mode: 'auto', seenCache: seenReloaded });

  assert.ok(!t2Text.includes('造成 8 点伤害。给予 2 层 易伤'), 'Seen card rules text should be omitted on Turn 2');
  assert.ok(!t2Text.includes('新词条:'), 'Seen glossary terms should be omitted on Turn 2');
  assert.ok(t2Text.includes('痛击 [2费]'), 'Card name and cost must still be present on Turn 2');
  assert.ok(t2Text.includes('-> [0]:8伤'), 'Dynamic target preview damage must still be present on Turn 2');
  assert.ok(t2Text.includes('钢笔尖(9)'), 'Relic stack counter must still be shown on Turn 2');
});

test('computeCombatSummary accurately computes fallback arithmetic when threat is missing', () => {
  const state = buildCombatStateFixture({ withThreat: false, block: 4, energy: 3 });
  const summary = computeCombatSummary(state);

  assert.equal(summary.incoming, 12);
  assert.equal(summary.blockNeeded, 8);
  assert.equal(summary.unblocked, 8);
  assert.equal(summary.hpAfter, 60);
  assert.equal(summary.maxBlock, 13); // 8 (Shrug) + 5 (Defend) for 2 energy
  assert.equal(summary.maxPlayableAttackDmg, 14); // 8 (Bash, 2e) + 6 (Strike, 1e) for 3 energy
});

test('batch_runner resolves hand indices to stable cid and survives hand shift cleanly', async () => {
  const tmpDir = makeTmpDir();
  const seen = new SeenCache(path.join(tmpDir, 'seen.json'));

  // Step 0: play card index 2 (Strike cid:103), Step 1: play card index 3 (Defend cid:104 -> shifts to index 2 after Strike is played!), Step 2: end_turn
  let stepCounter = 0;
  let hand = [
    { i: 0, cid: 101, type: 'skill', card_id: 'SHRUG', line: '耸肩无视 [1费]：获得 8 点 格挡 。', energy_cost: 1, playable: true, targets: [] },
    { i: 1, cid: 102, type: 'attack', card_id: 'BASH', line: '痛击 [2费]：造成 8 伤。', energy_cost: 2, playable: true, targets: [0] },
    { i: 2, cid: 103, type: 'attack', card_id: 'STRIKE', line: '打击 [1费]：造成 6 伤。', energy_cost: 1, playable: true, targets: [0] },
    { i: 3, cid: 104, type: 'skill', card_id: 'DEFEND', line: '防御 [1费]：获得 5 甲。', energy_cost: 1, playable: true, targets: [] },
  ];
  let block = 0;
  let energy = 3;
  const postedActions = [];

  const mockFetch = async (url, init) => {
    const parsedUrl = new URL(url);
    if (parsedUrl.pathname === '/decision-snapshot') {
      const state = buildCombatStateFixture({ turn: stepCounter >= 3 ? 2 : 1, block, energy, hand });
      return new Response(JSON.stringify({ ok: true, data: { state, available_actions: [] } }), { status: 200 });
    }
    if (parsedUrl.pathname === '/action') {
      const body = JSON.parse(init.body);
      postedActions.push(body);
      stepCounter += 1;
      if (body.action === 'play_card') {
        assert.equal(hand[body.card_index].cid, body.card_cid, 'card_index must match bound card_cid after shift');
        const played = hand.splice(body.card_index, 1)[0];
        hand = hand.map((c, idx) => ({ ...c, i: idx }));
        energy -= played.energy_cost;
        if (played.cid === 104) block += 5;
      }
      const nextState = buildCombatStateFixture({ turn: body.action === 'end_turn' ? 2 : 1, block, energy, hand });
      return new Response(JSON.stringify({ ok: true, data: { action: body.action, status: 'completed', stable: true, state: nextState } }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };

  const client = new Sts2Client({ baseUrl: 'http://127.0.0.1:8080', fetchFn: mockFetch });
  const res = await executeBatch(client, 'play 2 0; play 3; end', { mode: 'auto', seenCache: seen });

  assert.equal(res.stopReason, 'completed');
  assert.equal(res.executed.length, 3);
  assert.equal(postedActions[0].card_cid, 103);
  assert.equal(postedActions[0].card_index, 2);
  assert.equal(postedActions[1].card_cid, 104);
  assert.equal(postedActions[1].card_index, 2, 'Defend shifted from index 3 to index 2 and was resolved via cid!');
  assert.equal(postedActions[2].action, 'end_turn');
});

test('batch_runner interrupts immediately when playing a card draws a new card (new_cards)', async () => {
  const tmpDir = makeTmpDir();
  const seen = new SeenCache(path.join(tmpDir, 'seen.json'));

  let hand = buildCombatStateFixture().combat.hand;
  let energy = 3;
  const postedActions = [];

  const mockFetch = async (url, init) => {
    const parsedUrl = new URL(url);
    if (parsedUrl.pathname === '/decision-snapshot') {
      const state = buildCombatStateFixture({ energy, block: energy < 3 ? 8 : 0, hand });
      return new Response(JSON.stringify({ ok: true, data: { state, available_actions: [] } }), { status: 200 });
    }
    if (parsedUrl.pathname === '/action') {
      const body = JSON.parse(init.body);
      postedActions.push(body);
      // Playing Shrug It Off (cid:101) removes it and draws a brand new card (cid:199)!
      hand = hand.slice(1).map((c, idx) => ({ ...c, i: idx }));
      hand.push({
        i: hand.length,
        cid: 199,
        type: 'attack',
        card_id: 'WHIRLWIND',
        line: '旋风斩 [X费]：对所有敌人造成 5X 伤害。',
        costs_x: true,
        energy_cost: 0,
        playable: true,
        targets: [],
      });
      energy = 2;
      const nextState = buildCombatStateFixture({ energy, block: 8, hand });
      return new Response(JSON.stringify({ ok: true, data: { action: body.action, status: 'completed', stable: true, state: nextState } }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };

  const client = new Sts2Client({ baseUrl: 'http://127.0.0.1:8080', fetchFn: mockFetch });
  const res = await executeBatch(client, 'play 0; play 1 0; end', { mode: 'auto', seenCache: seen });

  assert.equal(res.stopReason, 'new_cards');
  assert.equal(res.executed.length, 1, 'Queue MUST halt after drawing a new card');
  assert.equal(postedActions.length, 1);
  assert.match(res.stateText, /旋风斩/);
  assert.match(res.stateText, /停止原因:new_cards/);
});

test('batch_runner auto-advances trivial rewards in auto mode but stops for player in assist mode', async () => {
  const tmpDir = makeTmpDir();
  const seen = new SeenCache(path.join(tmpDir, 'seen.json'));

  let screen = 'REWARD';
  let pendingCard = false;

  const buildRewardState = () => ({
    version: 14,
    screen,
    in_combat: false,
    run_id: 'RUN_REWARD',
    session: { mode: 'singleplayer', phase: 'run', control_scope: 'local_player' },
    available_actions: pendingCard ? ['choose_reward_card', 'skip_reward_cards'] : ['claim_reward', 'collect_rewards_and_proceed'],
    reward: {
      pending_card_choice: pendingCard,
      can_proceed: !pendingCard,
      rewards: pendingCard ? [] : [{ i: 0, line: 'Gold: 获得 20 金币', claimable: true }, { i: 1, line: 'Card: 选牌', claimable: true }],
      cards: pendingCard
        ? [
            { i: 0, card_id: 'POMMEL_STRIKE', line: '剑柄打击 [1费]：造成 9 点伤害。抽 1 张牌。', type: 'attack', rarity: 'Common' },
            { i: 1, card_id: 'BATTLE_TRANCE', line: '战斗专注 [0费]：抽 3 张牌。', type: 'skill', rarity: 'Uncommon' },
          ]
        : [],
      alternatives: pendingCard ? [{ i: 0, line: '跳过' }] : [],
    },
  });

  // Mock starting in combat ending turn -> enemy dies -> REWARD (gold+card) -> auto collects gold and stops at pending_card_choice!
  let phase = 'COMBAT';
  const mockFetch = async (url, init) => {
    const parsedUrl = new URL(url);
    if (parsedUrl.pathname === '/decision-snapshot') {
      const state = phase === 'COMBAT' ? buildCombatStateFixture() : buildRewardState();
      return new Response(JSON.stringify({ ok: true, data: { state, available_actions: [] } }), { status: 200 });
    }
    if (parsedUrl.pathname === '/action') {
      const body = JSON.parse(init.body);
      if (body.action === 'end_turn') {
        phase = 'REWARD';
        pendingCard = false;
      } else if (body.action === 'collect_rewards_and_proceed') {
        pendingCard = true;
      }
      return new Response(JSON.stringify({ ok: true, data: { action: body.action, status: 'completed', stable: true, state: buildRewardState() } }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };

  // Test auto mode: collects gold and stops on card choice
  const clientAuto = new Sts2Client({ baseUrl: 'http://127.0.0.1:8080', fetchFn: mockFetch });
  const autoRes = await executeBatch(clientAuto, 'end', { mode: 'auto', seenCache: seen });
  assert.equal(autoRes.autoAdvanced.length, 1);
  assert.equal(autoRes.autoAdvanced[0].action, 'collect_rewards_and_proceed');
  assert.equal(autoRes.finalState.reward.pending_card_choice, true);
  assert.match(autoRes.stateText, /剑柄打击/);

  // Test assist mode on same reward screen: does NOT auto-collect, emits [需要玩家确认]
  phase = 'REWARD';
  pendingCard = false;
  const assistText = compressState(buildRewardState(), { mode: 'assist', seenCache: seen });
  assert.match(assistText, /\[需要玩家确认\]/);
});

test('coop mode detects multiplayer session, teammate HP, and waiting-for-others state', () => {
  const tmpDir = makeTmpDir();
  const seen = new SeenCache(path.join(tmpDir, 'seen.json'));
  const state = buildCombatStateFixture({ multiplayer: true });
  state.combat.action_readiness.local_ready_to_end_turn = true;
  state.combat.action_readiness.all_players_ready_to_end_turn = false;

  const ctx = detectSessionContext(state);
  assert.equal(ctx.isMultiplayer, true);
  assert.equal(ctx.waitingForOthers, true);

  const text = compressState(state, { mode: 'coop', seenCache: seen });
  assert.match(text, /模式:联机\(2P\)/);
  assert.match(text, /\[等待队友\] 已结束回合，等待队友行动/);
  assert.match(text, /队友: \[槽1\] 静默猎手 HP 55\/70 甲8 能1/);
});

test('discoverInstances reads hint file and verifies against /health, and postAction retries 409 action_in_flight', async () => {
  const tmpDir = makeTmpDir();
  const hintPath = path.join(tmpDir, 'sts2-ai-agent-instance-4242.json');
  fs.writeFileSync(hintPath, JSON.stringify({ process_id: 4242, instance_role: 'human', api_port: 18080 }));

  let postAttempts = 0;
  const mockFetch = async (url, init) => {
    const parsedUrl = new URL(url);
    if (parsedUrl.pathname === '/health') {
      return new Response(JSON.stringify({
        ok: true,
        data: { service: 'sts2-ai-agent', process_id: 4242, api_port: 18080, instance_role: 'human', status: 'ready' },
      }), { status: 200 });
    }
    if (parsedUrl.pathname === '/action' && init.method === 'POST') {
      postAttempts += 1;
      if (postAttempts === 1) {
        return new Response(JSON.stringify({
          ok: false,
          error: { code: 'action_in_flight', message: 'busy', retryable: true },
        }), { status: 409 });
      }
      return new Response(JSON.stringify({ ok: true, data: { action: 'end_turn', status: 'completed', stable: true } }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };

  const instances = await discoverInstances({ tempDir: tmpDir, fetchFn: mockFetch });
  assert.equal(instances.length, 1);
  assert.equal(instances[0].url, 'http://127.0.0.1:18080');

  const client = new Sts2Client({ tempDir: tmpDir, fetchFn: mockFetch });
  const res = await client.postAction({ action: 'end_turn' });
  assert.equal(postAttempts, 2);
  assert.equal(res.status, 'completed');
});

test('lookupKeyword returns base and upgraded card descriptions from /data/cards cache', async () => {
  const tmpDir = makeTmpDir();
  const mockFetch = async (url) => {
    const parsedUrl = new URL(url);
    if (parsedUrl.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, data: { service: 'sts2-ai-agent', game_version: 'v0.113.1' } }), { status: 200 });
    }
    if (parsedUrl.pathname === '/data/cards') {
      return new Response(JSON.stringify({
        ok: true,
        data: [
          {
            id: 'BASH',
            name: '痛击',
            type: 'Attack',
            rarity: 'Starter',
            cost: 2,
            description: '造成 8 点伤害。给予 2 层易伤。',
            upgrade: { status: 'available', cost: 2, description: '造成 10 点伤害。给予 3 层易伤。' },
          },
        ],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, data: [] }), { status: 200 });
  };

  const client = new Sts2Client({ baseUrl: 'http://127.0.0.1:8080', fetchFn: mockFetch });
  const text = await lookupKeyword(client, '痛击', { type: 'cards', cacheDir: tmpDir });
  assert.match(text, /\[卡:BASH\] 痛击/);
  assert.match(text, /升级后\(2费\): 造成 10 点伤害。给予 3 层易伤/);
});

test('Opt 1a: executeBatch waits on step 0 transient snapshot_stabilizing before executing queue', async () => {
  const tmpDir = makeTmpDir();
  const seen = new SeenCache(path.join(tmpDir, 'seen.json'));

  let snapCount = 0;
  let hand = [
    {
      i: 0,
      cid: 103,
      type: 'attack',
      card_id: 'STRIKE_IRONCLAD',
      line: '打击 [1费]：造成 6 点伤害。',
      energy_cost: 1,
      playable: true,
      targets: [0],
      vs: [{ enemy: 0, damage: 6, kills: false }],
    },
  ];
  let endTurnDone = false;
  const postLog = [];

  const mockFetch = async (url, init) => {
    const parsedUrl = new URL(url);
    if (parsedUrl.pathname === '/decision-snapshot') {
      snapCount += 1;
      const state = buildCombatStateFixture({ multiplayer: true, hand });
      if (snapCount === 1) {
        state.combat.action_readiness = {
          can_use_combat_actions: false,
          actions_settled: false,
          reason: 'snapshot_stabilizing',
        };
      } else if (endTurnDone) {
        state.combat.action_readiness = {
          can_use_combat_actions: false,
          local_ready_to_end_turn: true,
          all_players_ready_to_end_turn: false,
        };
      }
      return new Response(JSON.stringify({ ok: true, data: { state, available_actions: state.available_actions } }), { status: 200 });
    }
    if (parsedUrl.pathname === '/action' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      postLog.push(body);
      if (body.action === 'play_card') hand = [];
      if (body.action === 'end_turn') endTurnDone = true;
      const nextState = buildCombatStateFixture({ multiplayer: true, hand });
      if (endTurnDone) {
        nextState.combat.action_readiness = {
          can_use_combat_actions: false,
          local_ready_to_end_turn: true,
          all_players_ready_to_end_turn: false,
        };
      }
      return new Response(JSON.stringify({ ok: true, data: { action: body.action, status: 'completed', state: nextState } }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };

  assert.equal(isTransientReadinessBlock({
    screen: 'COMBAT',
    combat: { action_readiness: { can_use_combat_actions: false, reason: 'snapshot_stabilizing' } },
  }), true);
  assert.equal(isTransientReadinessBlock({
    screen: 'COMBAT',
    combat: { action_readiness: { can_use_combat_actions: false, modal_open: true, reason: 'snapshot_stabilizing' } },
  }), false);

  const client = new Sts2Client({ baseUrl: 'http://127.0.0.1:8080', fetchFn: mockFetch });
  const res = await executeBatch(client, 'play 0 0; end', { mode: 'coop', seenCache: seen, pollIntervalMs: 10 });
  assert.equal(res.executed.length, 2);
  assert.equal(res.stopReason, 'completed');
  assert.equal(postLog.length, 2);
  assert.equal(postLog[0].card_cid, 103);
  assert.equal(snapCount >= 2, true);
});

test('Opt 1b: executeBatch retries transient POST invalid_action while settling, and never replays already-consumed cards', async () => {
  const tmpDir = makeTmpDir();
  const seen = new SeenCache(path.join(tmpDir, 'seen.json'));

  // Part A: POST fails with invalid_action because teammate animation started stabilizing window; retries and succeeds
  let handA = [
    {
      i: 0,
      cid: 301,
      type: 'attack',
      card_id: 'STRIKE_IRONCLAD',
      line: '打击 [1费]：造成 6 点伤害。',
      energy_cost: 1,
      playable: true,
      targets: [0],
      vs: [{ enemy: 0, damage: 6, kills: false }],
    },
    {
      i: 1,
      cid: 302,
      type: 'skill',
      card_id: 'DEFEND_IRONCLAD',
      line: '防御 [1费]：获得 5 点 格挡 。',
      energy_cost: 1,
      playable: true,
      targets: [],
    },
  ];
  let postCountA = 0;
  let probeAfterReject = false;

  const mockFetchA = async (url, init) => {
    const parsedUrl = new URL(url);
    if (parsedUrl.pathname === '/decision-snapshot') {
      const state = buildCombatStateFixture({ multiplayer: true, hand: handA });
      if (probeAfterReject) {
        probeAfterReject = false;
        state.combat.action_readiness = {
          can_use_combat_actions: false,
          actions_settled: false,
          reason: 'snapshot_stabilizing',
        };
      }
      return new Response(JSON.stringify({ ok: true, data: { state, available_actions: state.available_actions } }), { status: 200 });
    }
    if (parsedUrl.pathname === '/action' && init.method === 'POST') {
      postCountA += 1;
      const body = JSON.parse(init.body);
      if (postCountA === 1) {
        probeAfterReject = true;
        return new Response(JSON.stringify({
          ok: false,
          error: { code: 'invalid_action', message: 'combat actions temporarily stabilizing' },
        }), { status: 400 });
      }
      if (body.card_cid === 301) handA = handA.filter((c) => c.cid !== 301);
      if (body.card_cid === 302) handA = handA.filter((c) => c.cid !== 302);
      const nextState = buildCombatStateFixture({ multiplayer: true, hand: handA });
      return new Response(JSON.stringify({ ok: true, data: { action: body.action, status: 'completed', state: nextState } }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };

  const clientA = new Sts2Client({ baseUrl: 'http://127.0.0.1:8080', fetchFn: mockFetchA });
  const resA = await executeBatch(clientA, 'play 0 0; play 1', { mode: 'coop', seenCache: seen, pollIntervalMs: 10 });
  assert.equal(resA.executed.length, 2);
  assert.equal(resA.stopReason, 'completed');
  assert.equal(postCountA, 3);

  // Part B: If card cid is already consumed from hand when invalid_action returns, NEVER retry / double-play
  let handB = [
    {
      i: 0,
      cid: 401,
      type: 'attack',
      card_id: 'STRIKE_IRONCLAD',
      line: '打击 [1费]：造成 6 点伤害。',
      energy_cost: 1,
      playable: true,
      targets: [0],
      vs: [{ enemy: 0, damage: 6, kills: false }],
    },
  ];
  let postCountB = 0;

  const mockFetchB = async (url, init) => {
    const parsedUrl = new URL(url);
    if (parsedUrl.pathname === '/decision-snapshot') {
      const state = buildCombatStateFixture({ multiplayer: true, hand: handB });
      return new Response(JSON.stringify({ ok: true, data: { state, available_actions: state.available_actions } }), { status: 200 });
    }
    if (parsedUrl.pathname === '/action' && init.method === 'POST') {
      postCountB += 1;
      handB = []; // Card was already played on server before invalid_action reported
      return new Response(JSON.stringify({
        ok: false,
        error: { code: 'invalid_action', message: 'card_cid 401 not found in hand' },
      }), { status: 400 });
    }
    return new Response('{}', { status: 404 });
  };

  const clientB = new Sts2Client({ baseUrl: 'http://127.0.0.1:8080', fetchFn: mockFetchB });
  const resB = await executeBatch(clientB, 'play 0 0', { mode: 'coop', seenCache: seen, pollIntervalMs: 10 });
  assert.equal(postCountB, 1);
  assert.equal(resB.executed.length, 0);
  assert.equal(resB.stopReason, 'invalid_action');
});

test('Opt 2: order-preserving enemy matching remaps shifted indices after teammate kill instead of aborting', async () => {
  const tmpDir = makeTmpDir();
  const seen = new SeenCache(path.join(tmpDir, 'seen.json'));

  const makeEnemies = (teammateKilledFirst) => (
    teammateKilledFirst
      ? [
          {
            i: 0,
            enemy_id: 'CULTIST',
            name: '邪教徒',
            hp: '48/50',
            block: 0,
            intent: 'PECK_MOVE',
            move_id: 'PECK_MOVE',
            powers: [],
            intents: [{ i: 0, intent_type: 'Attack', damage: 6, hits: 1, total_damage: 6 }],
            alive: true,
            hittable: true,
          },
          {
            i: 1,
            enemy_id: 'JAW_WORM',
            name: '颚虫',
            hp: '40/44',
            block: 0,
            intent: 'CHOMP',
            move_id: 'CHOMP',
            powers: [],
            intents: [{ i: 0, intent_type: 'Attack', damage: 11, hits: 1, total_damage: 11 }],
            alive: true,
            hittable: true,
          },
        ]
      : [
          {
            i: 0,
            enemy_id: 'SLIME_S',
            name: '酸液史莱姆(小)',
            hp: '8/12',
            block: 0,
            intent: 'TACKLE',
            move_id: 'TACKLE',
            powers: [],
            intents: [{ i: 0, intent_type: 'Attack', damage: 3, hits: 1, total_damage: 3 }],
            alive: true,
            hittable: true,
          },
          {
            i: 1,
            enemy_id: 'CULTIST',
            name: '邪教徒',
            hp: '48/50',
            block: 0,
            intent: 'PECK_MOVE',
            move_id: 'PECK_MOVE',
            powers: [],
            intents: [{ i: 0, intent_type: 'Attack', damage: 6, hits: 1, total_damage: 6 }],
            alive: true,
            hittable: true,
          },
          {
            i: 2,
            enemy_id: 'JAW_WORM',
            name: '颚虫',
            hp: '40/44',
            block: 0,
            intent: 'CHOMP',
            move_id: 'CHOMP',
            powers: [],
            intents: [{ i: 0, intent_type: 'Attack', damage: 11, hits: 1, total_damage: 11 }],
            alive: true,
            hittable: true,
          },
        ]
  );

  // Verify direct matcher mapping first
  const matchRes = matchEnemiesAcrossStates(
    makeEnemies(false).map((e) => ({ idx: e.i, enemy_id: e.enemy_id })),
    makeEnemies(true).map((e) => ({ idx: e.i, enemy_id: e.enemy_id })),
  );
  assert.equal(matchRes.spawned.length, 0);
  assert.equal(matchRes.planIdxToCur.get(1)?.idx, 0);
  assert.equal(matchRes.planIdxToCur.get(2)?.idx, 1);

  let teammateKilledFirst = false;
  let hand = [
    {
      i: 0,
      cid: 501,
      type: 'skill',
      card_id: 'DEFEND_IRONCLAD',
      line: '防御 [1费]：获得 5 点 格挡 。',
      energy_cost: 1,
      playable: true,
      targets: [],
    },
    {
      i: 1,
      cid: 502,
      type: 'attack',
      card_id: 'STRIKE_IRONCLAD',
      line: '打击 [1费]：造成 6 点伤害。',
      energy_cost: 1,
      playable: true,
      targets: [0, 1, 2],
      vs: [
        { enemy: 0, damage: 6, kills: false },
        { enemy: 1, damage: 6, kills: false },
        { enemy: 2, damage: 6, kills: false },
      ],
    },
  ];
  const postLog = [];

  const mockFetch = async (url, init) => {
    const parsedUrl = new URL(url);
    if (parsedUrl.pathname === '/decision-snapshot') {
      const state = buildCombatStateFixture({
        multiplayer: true,
        hand: hand.map((c) => (c.targets.length > 0 ? { ...c, targets: teammateKilledFirst ? [0, 1] : [0, 1, 2] } : c)),
        enemies: makeEnemies(teammateKilledFirst),
      });
      return new Response(JSON.stringify({ ok: true, data: { state, available_actions: state.available_actions } }), { status: 200 });
    }
    if (parsedUrl.pathname === '/action' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      postLog.push(body);
      if (body.card_cid === 501) {
        hand = hand.filter((c) => c.cid !== 501).map((c, idx) => ({ ...c, i: idx }));
        // Teammate kills [0] SLIME_S immediately while we played Defend -> CULTIST shifts [1] -> [0]!
        teammateKilledFirst = true;
      } else if (body.card_cid === 502) {
        hand = [];
      }
      const nextState = buildCombatStateFixture({
        multiplayer: true,
        hand: hand.map((c) => (c.targets.length > 0 ? { ...c, targets: teammateKilledFirst ? [0, 1] : [0, 1, 2] } : c)),
        enemies: makeEnemies(teammateKilledFirst),
      });
      return new Response(JSON.stringify({ ok: true, data: { action: body.action, status: 'completed', state: nextState } }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };

  const client = new Sts2Client({ baseUrl: 'http://127.0.0.1:8080', fetchFn: mockFetch });
  // Queue: Defend, Strike original target [1] CULTIST, end turn
  const res = await executeBatch(client, 'play 0; play 1 1; end', { mode: 'coop', seenCache: seen, pollIntervalMs: 10 });
  assert.equal(res.stopReason, 'completed');
  assert.equal(res.executed.length, 3);
  assert.equal(postLog[1].action, 'play_card');
  assert.equal(postLog[1].card_cid, 502);
  assert.equal(postLog[1].target_index, 0); // Remapped [1] -> [0]!
  assert.equal(postLog[2].action, 'end_turn');
});

test('Opt 3a: default retarget="safe" auto-retargets onto safe normal enemy when target dies to teammate', async () => {
  const tmpDir = makeTmpDir();
  const seen = new SeenCache(path.join(tmpDir, 'seen.json'));

  const enemiesStart = [
    {
      i: 0,
      enemy_id: 'SLIME_S',
      name: '酸液史莱姆(小)',
      hp: '8/12',
      block: 0,
      intent: 'TACKLE',
      move_id: 'TACKLE',
      powers: [],
      intents: [{ i: 0, intent_type: 'Attack', damage: 3, hits: 1, total_damage: 3 }],
      alive: true,
      hittable: true,
    },
    {
      i: 1,
      enemy_id: 'CULTIST',
      name: '邪教徒',
      hp: '35/50',
      block: 0,
      intent: 'PECK_MOVE',
      move_id: 'PECK_MOVE',
      powers: ['STRENGTH 1: 攻击增加 1。'],
      intents: [{ i: 0, intent_type: 'Attack', damage: 7, hits: 1, total_damage: 7 }],
      alive: true,
      hittable: true,
    },
  ];
  const enemiesAfterKill = [
    {
      ...enemiesStart[1],
      i: 0,
    },
  ];

  let targetKilled = false;
  let hand = [
    {
      i: 0,
      cid: 601,
      type: 'skill',
      card_id: 'DEFEND_IRONCLAD',
      line: '防御 [1费]：获得 5 点 格挡 。',
      energy_cost: 1,
      playable: true,
      targets: [],
    },
    {
      i: 1,
      cid: 602,
      type: 'attack',
      card_id: 'STRIKE_IRONCLAD',
      line: '打击 [1费]：造成 6 点伤害。',
      energy_cost: 1,
      playable: true,
      targets: [0, 1],
      vs: [
        { enemy: 0, damage: 6, kills: false },
        { enemy: 1, damage: 6, kills: false },
      ],
    },
  ];
  const postLog = [];

  const mockFetch = async (url, init) => {
    const parsedUrl = new URL(url);
    if (parsedUrl.pathname === '/decision-snapshot') {
      const state = buildCombatStateFixture({
        multiplayer: true,
        hand: hand.map((c) => (c.targets.length > 0 ? {
          ...c,
          targets: targetKilled ? [0] : [0, 1],
          vs: targetKilled ? [{ enemy: 0, damage: 6, kills: false }] : c.vs,
        } : c)),
        enemies: targetKilled ? enemiesAfterKill : enemiesStart,
      });
      return new Response(JSON.stringify({ ok: true, data: { state, available_actions: state.available_actions } }), { status: 200 });
    }
    if (parsedUrl.pathname === '/action' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      postLog.push(body);
      if (body.card_cid === 601) {
        hand = hand.filter((c) => c.cid !== 601).map((c, idx) => ({ ...c, i: idx }));
        targetKilled = true; // Teammate kills planned target [0] SLIME_S
      } else if (body.card_cid === 602) {
        hand = [];
      }
      const nextState = buildCombatStateFixture({
        multiplayer: true,
        hand: hand.map((c) => (c.targets.length > 0 ? {
          ...c,
          targets: targetKilled ? [0] : [0, 1],
          vs: targetKilled ? [{ enemy: 0, damage: 6, kills: false }] : c.vs,
        } : c)),
        enemies: targetKilled ? enemiesAfterKill : enemiesStart,
      });
      return new Response(JSON.stringify({ ok: true, data: { action: body.action, status: 'completed', state: nextState } }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };

  const client = new Sts2Client({ baseUrl: 'http://127.0.0.1:8080', fetchFn: mockFetch });
  // Default retarget='safe': [0] SLIME_S died -> automatically retargets Strike onto safe [0] 邪教徒!
  const res = await executeBatch(client, 'play 0; play 1 0; end', { mode: 'coop', seenCache: seen, pollIntervalMs: 10 });
  assert.equal(res.stopReason, 'completed');
  assert.equal(res.executed.length, 3);
  assert.equal(res.retargeted.length, 1);
  assert.equal(postLog[1].target_index, 0);
  assert.match(res.stateText, /自动转火:\[0\]->\[0\]邪教徒/);
});

test('Opt 3b: default retarget="safe" blocks thorns/special-mechanic monsters, retarget="off" blocks all, and potions never retarget', async () => {
  const tmpDir = makeTmpDir();
  const seen = new SeenCache(path.join(tmpDir, 'seen.json'));

  // Direct unit checks on isSafeRetargetEnemy
  assert.equal(isSafeRetargetEnemy({ enemy_id: 'CULTIST', name: '邪教徒', powers: [], intent: 'PECK', move_id: 'PECK' }), true);
  assert.equal(isSafeRetargetEnemy({ enemy_id: 'SPINY', name: '尖刺怪', powers: ['THORNS_POWER 3: 反射3点伤害'], intent: 'BUFF' }), false);
  assert.equal(isSafeRetargetEnemy({ enemy_id: 'SLIME_L', name: '大史莱姆', powers: ['SPLIT: HP<=50%时分裂'], intent: 'ATTACK' }), false);
  assert.equal(isSafeRetargetEnemy({ enemy_id: 'LAGAVULIN', name: '乐加维林', powers: [], intent: 'SLEEP', move_id: 'SLEEP' }), false);
  assert.equal(isSafeRetargetEnemy({ enemy_id: 'NEMESIS', name: '天谴', powers: ['INTANGIBLE 1: 无实体'], intent: 'ATTACK' }), false);

  const makeScenario = (remainingEnemy, seq, retargetOpt) => {
    let killed = false;
    let hand = [
      {
        i: 0,
        cid: 701,
        type: 'skill',
        card_id: 'DEFEND_IRONCLAD',
        line: '防御 [1费]：获得 5 点 格挡 。',
        energy_cost: 1,
        playable: true,
        targets: [],
      },
      {
        i: 1,
        cid: 702,
        type: 'attack',
        card_id: 'STRIKE_IRONCLAD',
        line: '打击 [1费]：造成 6 点伤害。',
        energy_cost: 1,
        playable: true,
        targets: [0, 1],
        vs: [
          { enemy: 0, damage: 6, kills: false },
          { enemy: 1, damage: 6, kills: false },
        ],
      },
    ];
    const startEnemies = [
      {
        i: 0,
        enemy_id: 'SLIME_S',
        name: '酸液史莱姆(小)',
        hp: '6/12',
        block: 0,
        intent: 'TACKLE',
        move_id: 'TACKLE',
        powers: [],
        intents: [{ i: 0, intent_type: 'Attack', damage: 3, hits: 1, total_damage: 3 }],
        alive: true,
        hittable: true,
      },
      { ...remainingEnemy, i: 1, alive: true, hittable: true },
    ];
    const afterEnemies = [{ ...remainingEnemy, i: 0, alive: true, hittable: true }];

    const mockFetch = async (url, init) => {
      const parsedUrl = new URL(url);
      const curEnemies = killed ? afterEnemies : startEnemies;
      const curHand = hand.map((c) => (c.targets.length > 0 ? {
        ...c,
        targets: killed ? [0] : [0, 1],
        vs: killed ? [{ enemy: 0, damage: 6, kills: false }] : c.vs,
      } : c));
      if (parsedUrl.pathname === '/decision-snapshot') {
        const state = buildCombatStateFixture({ multiplayer: true, hand: curHand, enemies: curEnemies });
        state.available_actions = ['play_card', 'use_potion', 'end_turn'];
        return new Response(JSON.stringify({ ok: true, data: { state, available_actions: state.available_actions } }), { status: 200 });
      }
      if (parsedUrl.pathname === '/action' && init.method === 'POST') {
        const body = JSON.parse(init.body);
        if (body.card_cid === 701) {
          hand = hand.filter((c) => c.cid !== 701).map((c, idx) => ({ ...c, i: idx }));
          killed = true;
        }
        const nextState = buildCombatStateFixture({
          multiplayer: true,
          hand: hand.map((c) => (c.targets.length > 0 ? {
            ...c,
            targets: killed ? [0] : [0, 1],
            vs: killed ? [{ enemy: 0, damage: 6, kills: false }] : c.vs,
          } : c)),
          enemies: killed ? afterEnemies : startEnemies,
        });
        nextState.available_actions = ['play_card', 'use_potion', 'end_turn'];
        return new Response(JSON.stringify({ ok: true, data: { action: body.action, status: 'completed', state: nextState } }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };

    const client = new Sts2Client({ baseUrl: 'http://127.0.0.1:8080', fetchFn: mockFetch });
    return executeBatch(client, seq, { mode: 'coop', seenCache: seen, pollIntervalMs: 10, retarget: retargetOpt });
  };

  // 1) Thorns monster refuses auto-retarget under default 'safe'
  const thornsEnemy = {
    enemy_id: 'GUARDIAN',
    name: '守护者',
    hp: '80/80',
    block: 0,
    intent: 'DEFENSIVE_MODE',
    move_id: 'DEFENSIVE_MODE',
    powers: ['THORNS_POWER 3: 每次受击反射 3 点伤害。'],
    intents: [{ i: 0, intent_type: 'Buff', damage: 0, hits: 0, total_damage: 0 }],
  };
  const thornsRes = await makeScenario(thornsEnemy, 'play 0; play 1 0; end', undefined);
  assert.equal(thornsRes.stopReason, 'target_gone');
  assert.match(thornsRes.stopDetail, /反伤\/特殊机制/);
  assert.equal(thornsRes.executed.length, 1);

  // 2) retarget='any' overrides safety guard on thorns monster
  const anyRes = await makeScenario(thornsEnemy, 'play 0; play 1 0; end', 'any');
  assert.equal(anyRes.stopReason, 'completed');
  assert.equal(anyRes.executed.length, 3);
  assert.equal(anyRes.retargeted.length, 1);

  // 3) retarget='off' stops even on safe normal enemy
  const safeEnemy = {
    enemy_id: 'CULTIST',
    name: '邪教徒',
    hp: '35/50',
    block: 0,
    intent: 'PECK_MOVE',
    move_id: 'PECK_MOVE',
    powers: [],
    intents: [{ i: 0, intent_type: 'Attack', damage: 6, hits: 1, total_damage: 6 }],
  };
  const offRes = await makeScenario(safeEnemy, 'play 0; play 1 0', 'off');
  assert.equal(offRes.stopReason, 'target_gone');
  assert.equal(offRes.executed.length, 1);

  // 4) Potions never auto-retarget even when remaining enemy is safe
  const potionRes = await makeScenario(safeEnemy, 'play 0; potion 0 0', 'safe');
  assert.equal(potionRes.stopReason, 'target_gone');
  assert.match(potionRes.stopDetail, /药水不自动转火/);
  assert.equal(potionRes.executed.length, 1);
});

test('Opt 4a: waitForTurnReady wakes via SSE /events/stream and falls back to poll on 404', async () => {
  // Part A: SSE stream wakes waitForTurnReady cleanly
  let turnReadyA = false;
  const mockFetchSse = async (url) => {
    const parsedUrl = new URL(url);
    if (parsedUrl.pathname === '/decision-snapshot') {
      const state = buildCombatStateFixture({ multiplayer: true, turn: turnReadyA ? 2 : 1 });
      if (!turnReadyA) {
        state.combat.action_readiness = {
          can_use_combat_actions: false,
          local_ready_to_end_turn: true,
          all_players_ready_to_end_turn: false,
        };
      }
      return new Response(JSON.stringify({ ok: true, data: { state, available_actions: state.available_actions } }), { status: 200 });
    }
    if (parsedUrl.pathname === '/events/stream') {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(': stream opened\n\n'));
          setTimeout(() => {
            turnReadyA = true;
            controller.enqueue(encoder.encode('data: {"type":"turn_changed","turn":2}\n\n'));
          }, 25);
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    return new Response('{}', { status: 404 });
  };

  const clientSse = new Sts2Client({ baseUrl: 'http://127.0.0.1:8080', fetchFn: mockFetchSse });
  const resSse = await clientSse.waitForTurnReady({ timeoutMs: 2000, debounceMs: 15, pollIntervalMs: 300 });
  assert.equal(resSse.ready, true);
  assert.equal(resSse.via, 'sse');
  assert.equal(resSse.snapshot.state.turn, 2);

  // Part B: 404 on /events/stream falls back to polling
  let snapCountB = 0;
  const mockFetchPoll = async (url) => {
    const parsedUrl = new URL(url);
    if (parsedUrl.pathname === '/events/stream') {
      return new Response('Not Found', { status: 404 });
    }
    if (parsedUrl.pathname === '/decision-snapshot') {
      snapCountB += 1;
      const ready = snapCountB >= 2;
      const state = buildCombatStateFixture({ multiplayer: true, turn: ready ? 2 : 1 });
      if (!ready) {
        state.combat.action_readiness = {
          can_use_combat_actions: false,
          local_ready_to_end_turn: true,
          all_players_ready_to_end_turn: false,
        };
      }
      return new Response(JSON.stringify({ ok: true, data: { state, available_actions: state.available_actions } }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };

  const clientPoll = new Sts2Client({ baseUrl: 'http://127.0.0.1:8080', fetchFn: mockFetchPoll });
  const resPoll = await clientPoll.waitForTurnReady({ timeoutMs: 2000, pollIntervalMs: 20 });
  assert.equal(resPoll.ready, true);
  assert.equal(resPoll.via, 'poll');
  assert.equal(resPoll.snapshot.state.turn, 2);
});

test('Opt 4b: executeBatch with waitForTurn=true blocks via SSE after end_turn until Turn 2 ready', async () => {
  const tmpDir = makeTmpDir();
  const seen = new SeenCache(path.join(tmpDir, 'seen.json'));

  let phase = 'turn1'; // 'turn1' -> 'waiting' -> 'turn2'
  const mockFetch = async (url, init) => {
    const parsedUrl = new URL(url);
    const makeCurrentState = () => {
      const turn = phase === 'turn2' ? 2 : 1;
      const state = buildCombatStateFixture({ multiplayer: true, turn });
      if (phase === 'waiting') {
        state.combat.action_readiness = {
          can_use_combat_actions: false,
          local_ready_to_end_turn: true,
          all_players_ready_to_end_turn: false,
        };
      }
      return state;
    };

    if (parsedUrl.pathname === '/decision-snapshot') {
      const state = makeCurrentState();
      return new Response(JSON.stringify({ ok: true, data: { state, available_actions: state.available_actions } }), { status: 200 });
    }
    if (parsedUrl.pathname === '/action' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      if (body.action === 'end_turn') {
        phase = 'waiting';
      }
      const nextState = makeCurrentState();
      return new Response(JSON.stringify({ ok: true, data: { action: body.action, status: 'completed', state: nextState } }), { status: 200 });
    }
    if (parsedUrl.pathname === '/events/stream') {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(': stream opened\n\n'));
          setTimeout(() => {
            phase = 'turn2';
            controller.enqueue(encoder.encode('data: {"type":"turn_started","turn":2}\n\n'));
          }, 25);
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    return new Response('{}', { status: 404 });
  };

  const client = new Sts2Client({ baseUrl: 'http://127.0.0.1:8080', fetchFn: mockFetch });
  const res = await executeBatch(client, 'end', {
    mode: 'coop',
    seenCache: seen,
    pollIntervalMs: 10,
    settleTimeoutMs: 500,
    waitForTurn: true,
    waitTimeoutMs: 2000,
  });

  assert.equal(res.stopReason, 'completed');
  assert.equal(res.executed.length, 1);
  assert.equal(res.waitVia, 'sse');
  assert.equal(res.finalState.turn, 2);
  assert.match(res.stateText, /等回合:sse/);
  assert.match(res.stateText, /T2/);
});
