#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { discoverInstances, Sts2ApiError, Sts2Client } from './src/api_client.js';
import { executeBatch } from './src/batch_runner.js';
import { compressState, SeenCache } from './src/compressor.js';
import { lookupKeyword } from './src/lookup.js';

const CACHE_DIR = path.resolve(import.meta.dirname, '.cache');

function parseCliArgs(argv) {
  const positionals = [];
  const flags = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { command: positionals[0] || 'help', args: positionals.slice(1), flags };
}

function printHelp() {
  console.log(`杀戮尖塔2 极简省流 AI 控制器 (CLI)

用法:
  node sts2.js health [--instance human|companion|<pid>] [--url <http://...>]
      检查 Mod 安装与游戏本地 HTTP 接口连通状态

  node sts2.js observe [--mode assist|auto|coop] [--full] [--instance ...]
      只读获取当前极简战报与确定性数值算术（军师/辅助模式）

  node sts2.js wait [--mode coop|auto|assist] [--timeout <秒>] [--full] [--instance ...]
      多人联机零Token等待：通过 SSE 事件流静默阻塞至队友出完牌、轮到我方行动，再返回战报

  node sts2.js act "<动作序列>" [--mode auto|assist|coop] [--reason "<理由>"] [--retarget safe|off|any] [--no-retarget] [--wait] [--wait-timeout <秒>] [--full]
      执行整回合动作队列（支持瞬态就绪等待、队友击杀顺位映射、无反伤/非特殊机制怪安全自动转火），返回下一决策点战报
      动作示例:
        "play 0 0; play 2; end"     打出0号牌打0号怪 -> 打2号牌 -> 结束回合
        "play cid:12 0; potion 0 0" 按稳定 cid 打牌 + 用药水
        "map 1"                     选地图节点1
        "pick_card 0; collect"      选奖励卡0并自动领取后续战利品
        "event 0" / "rest 1" / "shop open" / "buy_card 0" / "proceed"

  node sts2.js lookup "<关键词>" [--type all|cards|relics|monsters|potions|events|powers] [--refresh]
      按需查询卡牌（含升级前后对比）、遗物、怪物、药水、事件图鉴

  node sts2.js cache clear
      清理词条去重与图鉴本地缓存`);
}

function detectInstalledModLocation() {
  const roots = [];
  if (process.env.STS2_GAME_DIR) {
    roots.push(process.env.STS2_GAME_DIR);
  }
  roots.push('C:\\Program Files (x86)\\Steam\\steamapps\\common\\Slay the Spire 2');
  for (const drive of ['C', 'D', 'E', 'F', 'G']) {
    roots.push(`${drive}:\\SteamLibrary\\steamapps\\common\\Slay the Spire 2`);
    roots.push(`${drive}:\\Steam\\steamapps\\common\\Slay the Spire 2`);
  }

  for (const root of roots) {
    const candidates = [
      path.join(root, 'mods', 'STS2AIAgent'),
      path.join(root, 'mods'),
      path.resolve(root, '..', '..', 'workshop', 'content', '2868840', '3796486050'),
    ];
    for (const dir of candidates) {
      if (fs.existsSync(path.join(dir, 'STS2AIAgent.dll'))
        && (fs.existsSync(path.join(dir, 'mod_id.json')) || fs.existsSync(path.join(dir, 'STS2AIAgent.json')))) {
        return dir;
      }
    }
  }
  return null;
}

async function runHealth(client, flags) {
  const modsDir = detectInstalledModLocation();
  const modInstalled = Boolean(modsDir);

  const instances = await discoverInstances({ selector: flags.instance || 'human' });
  try {
    const h = await client.getHealth();
    const lines = [
      `[连接正常] 服务=${h.service} Mod版本=${h.mod_version} 游戏版本=${h.game_version} 状态=${h.status}`,
      `地址=http://${h.api_host}:${h.api_port} PID=${h.process_id} 角色=${h.instance_role} 兼容自检缺失=${h.compatibility?.reflected_members_missing ?? 0}`,
      `本地Mod文件=${modInstalled ? '已部署 (' + modsDir + ')' : '运行中 (已由游戏或工坊加载)'}`,
    ];
    if (h.companion) {
      lines.push(`AI队友实例: http://${h.companion.api_host}:${h.companion.api_port} (PID=${h.companion.process_id}, auto_play=${h.companion.auto_play})`);
    }
    if (instances.length > 1) {
      lines.push(`检测到多个活跃实例: ${instances.map((x) => `${x.health.instance_role}:${x.health.api_port}(pid=${x.health.process_id})`).join(', ')}`);
    }
    console.log(lines.join('\n'));
  } catch (err) {
    console.log([
      `[未连接游戏] ${err.message}`,
      `本地Mod文件状态=${modInstalled ? '已安装至 ' + modsDir + ' (affects_gameplay: false)' : '未在默认目录检测到（如已装在其他路径或通过工坊订阅可忽略）'}`,
      '提示: 请在 Steam 选择“带 Mod 启动 (Play with Mods)”运行《杀戮尖塔2》，并在 Mods 界面勾选启用 STS2 AI Agent。',
    ].join('\n'));
    process.exitCode = 1;
  }
}

async function runObserve(client, flags) {
  const mode = String(flags.mode || 'assist').toLowerCase();
  const full = Boolean(flags.full);
  const snap = await client.getSnapshot();
  const seenCache = new SeenCache(path.join(CACHE_DIR, 'seen_cache.json'));
  const output = compressState(snap.state, {
    availableActions: snap.available_actions,
    mode,
    full,
    seenCache,
  });
  console.log(output);
}

async function runWait(client, flags) {
  const mode = String(flags.mode || 'coop').toLowerCase();
  const full = Boolean(flags.full);
  const timeoutSec = Number(flags.timeout);
  const timeoutMs = Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : 120_000;
  const res = await client.waitForTurnReady({ timeoutMs });
  const snap = res.snapshot || await client.getSnapshot();
  const seenCache = new SeenCache(path.join(CACHE_DIR, 'seen_cache.json'));
  const banner = res.ready
    ? `[等待完成] 通道:${res.via} | 轮到我方行动`
    : `[等待超时] 已等待 ${Math.round(timeoutMs / 1000)}s，队友仍在行动中`;
  const output = compressState(snap.state, {
    availableActions: snap.available_actions,
    mode,
    full,
    seenCache,
    extraBanner: banner,
  });
  console.log(output);
}

async function runAct(client, args, flags) {
  const seq = args.join(' ').trim();
  if (!seq) {
    throw new Error('缺少动作序列，例如: node sts2.js act "play 0 0; end"');
  }
  const mode = String(flags.mode || 'auto').toLowerCase();
  const full = Boolean(flags.full);
  const reason = typeof flags.reason === 'string' ? flags.reason : null;
  const retarget = flags['no-retarget']
    ? 'off'
    : String(flags.retarget || 'safe').toLowerCase();
  if (!['safe', 'off', 'any'].includes(retarget)) {
    throw new Error(`无效的 --retarget 参数 "${retarget}"，可选值为 safe / off / any`);
  }
  const waitForTurn = Boolean(flags.wait);
  const waitTimeoutSec = Number(flags['wait-timeout'] ?? flags.timeout);
  const waitTimeoutMs = Number.isFinite(waitTimeoutSec) && waitTimeoutSec > 0
    ? waitTimeoutSec * 1000
    : 120_000;
  const seenCache = new SeenCache(path.join(CACHE_DIR, 'seen_cache.json'));

  const result = await executeBatch(client, seq, {
    mode,
    reason,
    full,
    seenCache,
    retarget,
    waitForTurn,
    waitTimeoutMs,
  });
  console.log(result.stateText);
}

async function runLookup(client, args, flags) {
  const query = args.join(' ').trim();
  const text = await lookupKeyword(client, query, {
    type: String(flags.type || 'all'),
    refresh: Boolean(flags.refresh),
    cacheDir: CACHE_DIR,
  });
  console.log(text);
}

function runCacheClear() {
  const seen = new SeenCache(path.join(CACHE_DIR, 'seen_cache.json'));
  seen.clear();
  if (fs.existsSync(CACHE_DIR)) {
    for (const file of fs.readdirSync(CACHE_DIR)) {
      if (file.endsWith('.json')) {
        fs.unlinkSync(path.join(CACHE_DIR, file));
      }
    }
  }
  console.log('已清空本地词条去重与图鉴缓存。');
}

async function main() {
  const { command, args, flags } = parseCliArgs(process.argv.slice(2));
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === 'reset-cache' || (command === 'cache' && args[0] === 'clear')) {
    runCacheClear();
    return;
  }

  const client = new Sts2Client({
    baseUrl: typeof flags.url === 'string' ? flags.url : undefined,
    instance: typeof flags.instance === 'string' ? flags.instance : undefined,
  });

  switch (command) {
    case 'health':
      await runHealth(client, flags);
      break;
    case 'observe':
      await runObserve(client, flags);
      break;
    case 'wait':
      await runWait(client, flags);
      break;
    case 'act':
      await runAct(client, args, flags);
      break;
    case 'lookup':
      await runLookup(client, args, flags);
      break;
    default:
      throw new Error(`未知命令: "${command}"。运行 "node sts2.js help" 查看帮助。`);
  }
}

main().catch((err) => {
  if (err instanceof Sts2ApiError) {
    console.error(`[API错误:${err.code}] ${err.message}`);
  } else {
    console.error(`[错误] ${err.message}`);
  }
  process.exitCode = 1;
});
