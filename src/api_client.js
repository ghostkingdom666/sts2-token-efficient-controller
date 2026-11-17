import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_READ_TIMEOUT_MS = 10_000;
const DEFAULT_ACTION_TIMEOUT_MS = 75_000;
const DEFAULT_ACTION_IN_FLIGHT_RETRIES = 6;
const HINT_FILE_PREFIX = 'sts2-ai-agent-instance-';

export class Sts2ApiError extends Error {
  constructor(message, { statusCode = 0, code = 'api_error', details = null, retryable = false } = {}) {
    super(message);
    this.name = 'Sts2ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Inspects a snapshot or state payload and returns normalized mode/session metadata.
 */
export function detectSessionContext(state) {
  if (!state || typeof state !== 'object') {
    return {
      backend: 'sts2-ai-agent',
      mode: 'unknown',
      phase: 'unknown',
      screen: 'UNKNOWN',
      isMultiplayer: false,
      inCombat: false,
      localPlayerId: null,
      playerCount: 1,
      waitingForOthers: false,
      waitingReason: null,
    };
  }

  const session = state.session && typeof state.session === 'object' ? state.session : {};
  const mp = state.multiplayer && typeof state.multiplayer === 'object' ? state.multiplayer : null;
  const lobby = state.multiplayer_lobby && typeof state.multiplayer_lobby === 'object' ? state.multiplayer_lobby : null;
  const charSel = state.character_select && typeof state.character_select === 'object' ? state.character_select : null;
  const map = state.map && typeof state.map === 'object' ? state.map : null;
  const combat = state.combat && typeof state.combat === 'object' ? state.combat : null;
  const readiness = combat?.action_readiness && typeof combat.action_readiness === 'object'
    ? combat.action_readiness
    : null;
  const gameOver = state.game_over && typeof state.game_over === 'object' ? state.game_over : null;

  const isMultiplayer = Boolean(
    session.mode === 'multiplayer'
    || mp?.is_multiplayer
    || charSel?.is_multiplayer
    || lobby
    || (Array.isArray(state.run?.players) && state.run.players.length > 1)
    || (Array.isArray(combat?.players) && combat.players.length > 1),
  );

  let waitingForOthers = false;
  let waitingReason = null;

  if (isMultiplayer) {
    if (charSel?.is_waiting_for_players) {
      waitingForOthers = true;
      waitingReason = '已准备，等待队友选角/准备';
    } else if (map?.local_vote) {
      waitingForOthers = true;
      waitingReason = `已投票(${map.local_vote}), 等待队友投票`;
    } else if (readiness?.local_ready_to_end_turn && !readiness?.all_players_ready_to_end_turn) {
      waitingForOthers = true;
      waitingReason = '已结束回合，等待队友行动';
    } else if (gameOver?.waiting_for_other_players) {
      waitingForOthers = true;
      waitingReason = '结算页面等待其他玩家推进';
    } else if (lobby && lobby.has_lobby && lobby.local_ready && (lobby.players?.some((p) => !(p.ready ?? p.is_ready)))) {
      waitingForOthers = true;
      waitingReason = '联机大厅等待队友准备';
    }
  }

  return {
    backend: 'sts2-ai-agent',
    mode: isMultiplayer ? 'multiplayer' : (session.mode || 'singleplayer'),
    phase: session.phase || (state.screen === 'MAIN_MENU' ? 'menu' : 'run'),
    screen: state.screen || 'UNKNOWN',
    isMultiplayer,
    inCombat: Boolean(state.in_combat),
    localPlayerId: mp?.local_player_id ?? null,
    playerCount: mp?.player_count ?? state.run?.players?.length ?? combat?.players?.length ?? 1,
    waitingForOthers,
    waitingReason,
  };
}

/**
 * Discovers live STS2AIAgent HTTP endpoints from temp hint files and standard ports.
 */
export async function discoverInstances({
  tempDir = os.tmpdir(),
  fetchFn = globalThis.fetch,
  selector = process.env.STS2_API_INSTANCE || 'human',
  timeoutMs = 350,
} = {}) {
  const candidates = [];
  let files = [];
  try {
    files = fs.readdirSync(tempDir)
      .filter((name) => name.startsWith(HINT_FILE_PREFIX) && name.endsWith('.json'))
      .map((name) => {
        const fullPath = path.join(tempDir, name);
        try {
          const stat = fs.statSync(fullPath);
          return { fullPath, mtimeMs: stat.mtimeMs, size: stat.size };
        } catch {
          return null;
        }
      })
      .filter((entry) => entry && entry.size > 0 && entry.size <= 4096)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 50);
  } catch {
    files = [];
  }

  for (const file of files) {
    try {
      const hint = JSON.parse(fs.readFileSync(file.fullPath, 'utf8'));
      const pid = hint?.process_id;
      const port = hint?.api_port;
      const role = hint?.instance_role;
      if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port) || port <= 0 || port > 65535) {
        continue;
      }
      if (selector === 'human' || selector === 'companion') {
        if (role !== selector) continue;
      } else if (/^\d+$/.test(String(selector))) {
        if (pid !== Number(selector)) continue;
      }
      const url = `http://127.0.0.1:${port}`;
      const health = await probeSts2Health(url, { fetchFn, timeoutMs });
      if (health && health.process_id === pid && health.api_port === port) {
        candidates.push({ url, health, source: 'hint' });
      }
    } catch {
      // Ignore stale or malformed hint files.
    }
  }

  if (candidates.length > 0) {
    return candidates;
  }

  // Probe standard default ports when no valid hint file matched.
  const fallbackPorts = [8080, 15526];
  for (const port of fallbackPorts) {
    const url = `http://127.0.0.1:${port}`;
    const health = await probeSts2Health(url, { fetchFn, timeoutMs });
    if (health) {
      if (selector === 'companion' && health.instance_role !== 'companion') {
        if (health.companion?.api_port) {
          const compUrl = `http://${health.companion.api_host || '127.0.0.1'}:${health.companion.api_port}`;
          const compHealth = await probeSts2Health(compUrl, { fetchFn, timeoutMs });
          if (compHealth) {
            return [{ url: compUrl, health: compHealth, source: 'companion-redirect' }];
          }
        }
        continue;
      }
      return [{ url, health, source: `port-${port}` }];
    }
  }

  return [];
}

async function probeSts2Health(baseUrl, { fetchFn = globalThis.fetch, timeoutMs = 350 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${baseUrl}/health`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (body?.ok === true && body?.data?.service === 'sts2-ai-agent') {
      return body.data;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export class Sts2Client {
  constructor({
    baseUrl = process.env.STS2_API_BASE_URL || null,
    instance = process.env.STS2_API_INSTANCE || 'human',
    readTimeoutMs = DEFAULT_READ_TIMEOUT_MS,
    actionTimeoutMs = DEFAULT_ACTION_TIMEOUT_MS,
    fetchFn = globalThis.fetch,
    tempDir = os.tmpdir(),
  } = {}) {
    this.explicitBaseUrl = baseUrl ? baseUrl.replace(/\/+$/, '') : null;
    this.baseUrl = this.explicitBaseUrl;
    this.instance = instance;
    this.readTimeoutMs = readTimeoutMs;
    this.actionTimeoutMs = actionTimeoutMs;
    this.fetchFn = fetchFn;
    this.tempDir = tempDir;
    this.backendKind = 'sts2-ai-agent';
  }

  async resolveBaseUrl() {
    if (this.baseUrl) return this.baseUrl;
    const found = await discoverInstances({
      tempDir: this.tempDir,
      fetchFn: this.fetchFn,
      selector: this.instance,
    });
    if (found.length > 0) {
      this.baseUrl = found[0].url;
      return this.baseUrl;
    }
    throw new Sts2ApiError(
      `无法连接到杀戮尖塔2本地接口 (instance=${this.instance})。请确认游戏已通过“带 Mod 启动”运行，且 STS2AIAgent 已启用。`,
      { code: 'connection_error', retryable: true },
    );
  }

  async _request(method, routePath, body = null, { timeoutMs = this.readTimeoutMs } = {}) {
    const base = await this.resolveBaseUrl();
    const url = `${base}${routePath}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const init = {
        method,
        headers: {
          Accept: 'application/json',
        },
        signal: controller.signal,
      };
      if (body !== null && body !== undefined) {
        init.headers['Content-Type'] = 'application/json; charset=utf-8';
        init.body = JSON.stringify(body);
      }

      const res = await this.fetchFn(url, init);
      const text = await res.text();
      let parsed;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        throw new Sts2ApiError(`服务端返回了非 JSON 响应 (${res.status})`, {
          statusCode: res.status,
          code: 'invalid_response',
          details: { raw: text.slice(0, 200), path: routePath },
        });
      }

      if (!res.ok || parsed?.ok === false) {
        const err = parsed?.error || {};
        throw new Sts2ApiError(err.message || `HTTP ${res.status} on ${routePath}`, {
          statusCode: res.status,
          code: err.code || 'http_error',
          details: err.details ?? null,
          retryable: Boolean(err.retryable),
        });
      }

      return parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
    } catch (error) {
      if (error instanceof Sts2ApiError) {
        throw error;
      }
      if (error?.name === 'AbortError') {
        throw new Sts2ApiError(`请求 ${routePath} 超时 (${timeoutMs}ms)`, {
          code: method === 'POST' ? 'outcome_unknown' : 'timeout',
          details: { path: routePath, method },
          retryable: method !== 'POST',
        });
      }
      throw new Sts2ApiError(`请求 ${routePath} 网络失败: ${error?.message || error}`, {
        code: 'connection_error',
        details: { path: routePath, method },
        retryable: method !== 'POST',
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async getHealth() {
    return this._request('GET', '/health');
  }

  async getRawState() {
    return this._request('GET', '/state');
  }

  async getAvailableActions() {
    const data = await this._request('GET', '/actions/available');
    return Array.isArray(data?.actions) ? data.actions : [];
  }

  /**
   * Fetches an atomic decision snapshot (compact agent_view + descriptors from one frame).
   * Falls back to GET /state + GET /actions/available if /decision-snapshot returns 404.
   */
  async getSnapshot() {
    try {
      const snap = await this._request('GET', '/decision-snapshot');
      if (snap && snap.state) {
        return {
          state: snap.state,
          available_actions: Array.isArray(snap.available_actions) ? snap.available_actions : [],
          isCompact: true,
        };
      }
    } catch (error) {
      if (!(error instanceof Sts2ApiError) || error.code !== 'not_found') {
        throw error;
      }
    }

    const [rawState, actions] = await Promise.all([
      this.getRawState(),
      this.getAvailableActions(),
    ]);
    return {
      state: rawState,
      available_actions: actions,
      isCompact: false,
    };
  }

  async getDataCollection(collection) {
    return this._request('GET', `/data/${encodeURIComponent(collection)}`, null, { timeoutMs: 20_000 });
  }

  /**
   * Submits a single action to POST /action.
   * Only retries on 409 action_in_flight (where the mod guarantees nothing executed).
   * Never replays outcome_unknown or other errors.
   */
  async postAction(actionBody, { maxInFlightRetries = DEFAULT_ACTION_IN_FLIGHT_RETRIES } = {}) {
    let attempt = 0;
    while (true) {
      try {
        return await this._request('POST', '/action', actionBody, { timeoutMs: this.actionTimeoutMs });
      } catch (error) {
        const canRetryInFlight = error instanceof Sts2ApiError
          && error.code === 'action_in_flight'
          && error.retryable
          && attempt < maxInFlightRetries;
        if (!canRetryInFlight) {
          throw error;
        }
        attempt += 1;
        await sleep(180 * attempt);
      }
    }
  }

  /**
   * Polls /decision-snapshot until the game settles into an actionable frame or hits timeout.
   */
  async waitUntilActionable({ timeoutMs = 8000, pollIntervalMs = 180 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastSnap = null;

    while (true) {
      try {
        lastSnap = await this.getSnapshot();
      } catch (error) {
        if (error instanceof Sts2ApiError && error.code === 'state_unavailable' && Date.now() < deadline) {
          await sleep(pollIntervalMs);
          continue;
        }
        throw error;
      }

      const st = lastSnap.state;
      const ctx = detectSessionContext(st);
      if (ctx.waitingForOthers) {
        return { actionable: false, waitingForOthers: true, snapshot: lastSnap };
      }

      const screen = st?.screen || 'UNKNOWN';
      if (screen !== 'UNKNOWN') {
        const readiness = st?.combat?.action_readiness;
        if (screen === 'COMBAT' && readiness) {
          if (readiness.can_use_combat_actions === true) {
            return { actionable: true, waitingForOthers: false, snapshot: lastSnap };
          }
          // Non-combat overlays inside combat (e.g., hand/grid selection or blocking modal) are actionable immediately.
          if (st?.selection || st?.modal) {
            return { actionable: true, waitingForOthers: false, snapshot: lastSnap };
          }
        } else if (Array.isArray(st?.available_actions) && st.available_actions.length > 0) {
          return { actionable: true, waitingForOthers: false, snapshot: lastSnap };
        } else if (screen === 'PAUSE_MENU' || screen === 'GAME_OVER') {
          return { actionable: true, waitingForOthers: false, snapshot: lastSnap };
        }
      }

      if (Date.now() >= deadline) {
        return { actionable: false, waitingForOthers: false, snapshot: lastSnap };
      }
      await sleep(pollIntervalMs);
    }
  }
}
