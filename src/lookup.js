import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_CACHE_DIR = path.resolve(import.meta.dirname, '..', '.cache');
const VALID_COLLECTIONS = ['cards', 'relics', 'monsters', 'potions', 'events', 'powers', 'characters'];

function cachePathFor(cacheDir, collection, versionTag = 'latest') {
  const safeVersion = String(versionTag || 'latest').replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(cacheDir, `glossary_${collection}_${safeVersion}.json`);
}

export async function fetchCollectionCached(client, collection, {
  cacheDir = DEFAULT_CACHE_DIR,
  versionTag = 'latest',
  refresh = false,
} = {}) {
  const filePath = cachePathFor(cacheDir, collection, versionTag);
  if (!refresh && fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Refetch if cache file is unreadable.
    }
  }

  const data = await client.getDataCollection(collection);
  const items = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : []);
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(items), 'utf8');
  } catch {
    // Best-effort disk cache.
  }
  return items;
}

function formatCardEntry(card) {
  const cost = card.is_x_cost ? 'X费' : `${card.cost ?? 0}费`;
  const star = card.is_x_star_cost ? '/X星' : (card.star_cost > 0 ? `/${card.star_cost}星` : '');
  const base = `[卡:${card.id}] ${card.name} (${card.type || '?'} | ${card.rarity || '?'} | ${cost}${star}): ${card.description || ''}`;
  if (card.upgrade && card.upgrade.status === 'available') {
    const upgCost = card.upgrade.cost !== undefined ? `${card.upgrade.cost}费` : cost;
    return `${base}\n  ↳ 升级后(${upgCost}): ${card.upgrade.description || ''}`;
  }
  return base;
}

function formatGenericEntry(kind, item) {
  if (kind === 'relics') {
    return `[遗物:${item.id}] ${item.name} (${item.rarity || '?'}): ${item.description || ''}`;
  }
  if (kind === 'potions') {
    return `[药水:${item.id}] ${item.name} (${item.rarity || '?'} | ${item.usage || '?'}): ${item.description || ''}`;
  }
  if (kind === 'powers') {
    return `[状态:${item.id}] ${item.name} (${item.type || '?'}): ${item.description || ''}`;
  }
  if (kind === 'monsters') {
    const hp = item.min_hp !== undefined && item.max_hp !== undefined ? `HP ${item.min_hp}-${item.max_hp}` : '';
    return `[怪物:${item.id}] ${item.name} ${hp}`.trim();
  }
  if (kind === 'events') {
    const opts = Array.isArray(item.options) ? ` (${item.options.length}选项)` : '';
    return `[事件:${item.id}] ${item.name}${opts}: ${(item.description || '').slice(0, 120)}`;
  }
  if (kind === 'characters') {
    return `[角色:${item.id}] ${item.name}`;
  }
  return `[${kind}:${item.id}] ${item.name || ''}`;
}

export async function lookupKeyword(client, query, {
  type = 'all',
  limit = 8,
  cacheDir = DEFAULT_CACHE_DIR,
  refresh = false,
} = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) {
    throw new Error('请提供查询关键词，例如: node sts2.js lookup "痛击"');
  }

  let versionTag = 'latest';
  try {
    const health = await client.getHealth();
    if (health?.game_version) versionTag = health.game_version;
  } catch {
    // Allow lookup from local disk cache even when the game is closed!
  }

  const collections = type === 'all'
    ? ['cards', 'relics', 'potions', 'powers', 'monsters', 'events']
    : [type.toLowerCase()];

  for (const col of collections) {
    if (!VALID_COLLECTIONS.includes(col)) {
      throw new Error(`不支持的图鉴分类 "${col}"，可选: ${VALID_COLLECTIONS.join(', ')}`);
    }
  }

  const hits = [];
  for (const col of collections) {
    let items = [];
    try {
      items = await fetchCollectionCached(client, col, { cacheDir, versionTag, refresh });
    } catch {
      continue;
    }

    for (const item of items) {
      const idStr = String(item.id || '').toLowerCase();
      const nameStr = String(item.name || '').toLowerCase();
      const descStr = String(item.description || '').toLowerCase();
      let score = 0;
      if (idStr === q || nameStr === q) score = 100;
      else if (nameStr.startsWith(q) || idStr.startsWith(q)) score = 80;
      else if (nameStr.includes(q) || idStr.includes(q)) score = 60;
      else if (descStr.includes(q)) score = 30;

      if (score > 0) {
        hits.push({
          score,
          text: col === 'cards' ? formatCardEntry(item) : formatGenericEntry(col, item),
        });
      }
    }
  }

  hits.sort((a, b) => b.score - a.score);
  const sliced = hits.slice(0, limit);
  if (sliced.length === 0) {
    return `未找到匹配 "${query}" 的图鉴条目（如游戏未运行且本地尚未缓存图鉴，请先启动游戏执行一次 lookup）。`;
  }
  return sliced.map((h) => h.text).join('\n');
}
