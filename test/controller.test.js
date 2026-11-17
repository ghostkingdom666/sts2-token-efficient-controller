import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverInstances, detectSessionContext, Sts2Client } from '../src/api_client.js';
import { compressState, computeCombatSummary, SeenCache } from '../src/compressor.js';
import { bindHandCardCids, detectCombatDivergence, executeBatch, parseActionSequence } from '../src/batch_runner.js';
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
