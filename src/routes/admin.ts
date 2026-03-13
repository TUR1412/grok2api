import { Hono } from "hono";
import type { Env } from "../env";
import { requireAdminAuth } from "../auth";
import {
  getSettings,
  saveSettings,
  normalizeCfCookie,
  normalizeImageGenerationMethod,
} from "../settings";
import {
  addApiKey,
  batchAddApiKeys,
  batchDeleteApiKeys,
  batchUpdateApiKeyStatus,
  deleteApiKey,
  listApiKeys,
  validateApiKey,
  updateApiKeyLimits,
  updateApiKeyName,
  updateApiKeyStatus,
} from "../repo/apiKeys";
import { displayKey } from "../utils/crypto";
import { createAdminSession, deleteAdminSession, verifyAdminSession } from "../repo/adminSessions";
import {
  addTokens,
  applyCooldown,
  deleteTokens,
  getAllTags,
  listTokens,
  recordTokenFailure,
  selectBestToken,
  tokenRowToInfo,
  updateTokenNote,
  updateTokenTags,
  updateTokenLimits,
} from "../repo/tokens";
import { generateImagineWs, resolveAspectRatio } from "../grok/imagineExperimental";
import { checkRateLimits } from "../grok/rateLimits";
import { addRequestLog, clearRequestLogs, getRequestLogs, getRequestStats } from "../repo/logs";
import { getRefreshProgress, setRefreshProgress } from "../repo/refreshProgress";
import {
  deleteCacheRows,
  getCacheSizeBytes,
  listCacheRowsByType,
  listOldestRows,
  type CacheType,
} from "../repo/cache";
import { dbAll, dbFirst, dbRun } from "../db";
import { nowMs } from "../utils/time";
import { listUsageForDay, localDayString } from "../repo/apiKeyUsage";

function jsonError(message: string, code: string): Record<string, unknown> {
  return { error: message, code };
}

function parseBearer(auth: string | null): string | null {
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || null;
}

function validateTokenType(token_type: string): "sso" | "ssoSuper" {
  if (token_type !== "sso" && token_type !== "ssoSuper") throw new Error("无效的Token类型");
  return token_type;
}

function formatBytes(sizeBytes: number): string {
  const kb = 1024;
  const mb = 1024 * 1024;
  if (sizeBytes < mb) return `${(sizeBytes / kb).toFixed(1)} KB`;
  return `${(sizeBytes / mb).toFixed(1)} MB`;
}

function normalizeSsoToken(raw: string): string {
  const t = (raw || "").trim();
  return t.startsWith("sso=") ? t.slice(4).trim() : t;
}

async function tryResetAdminToDefault(args: {
  env: Env;
  username?: string | null;
  password?: string | null;
  bearer?: string | null;
}): Promise<boolean> {
  const wantsResetByLogin =
    String(args.username ?? "").trim() === "admin" &&
    String(args.password ?? "").trim() === "admin";
  const wantsResetByBearer = String(args.bearer ?? "").trim() === "admin";
  if (!wantsResetByLogin && !wantsResetByBearer) return false;

  await saveSettings(args.env, {
    global_config: {
      admin_username: "admin",
      admin_password: "admin",
    },
  });
  return true;
}

async function clearKvCacheByType(
  env: Env,
  type: CacheType | null,
  batch = 200,
  maxLoops = 20,
): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < maxLoops; i++) {
    const rows = await listOldestRows(env.DB, type, null, batch);
    if (!rows.length) break;
    const keys = rows.map((r) => r.key);
    await Promise.all(keys.map((k) => env.KV_CACHE.delete(k)));
    await deleteCacheRows(env.DB, keys);
    deleted += keys.length;
    if (keys.length < batch) break;
  }
  return deleted;
}

function base64UrlEncodeString(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodeAssetPath(raw: string): string {
  try {
    const u = new URL(raw);
    return `u_${base64UrlEncodeString(u.toString())}`;
  } catch {
    const p = raw.startsWith("/") ? raw : `/${raw}`;
    return `p_${base64UrlEncodeString(p)}`;
  }
}

function parseWsMessageData(data: unknown): Record<string, unknown> | null {
  let raw = "";
  if (typeof data === "string") raw = data;
  else if (data instanceof ArrayBuffer) raw = new TextDecoder().decode(data);
  else if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    raw = new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore parse errors
  }
  return null;
}

function wsSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseImagineWsFailureStatus(message: string): number {
  const matched = message.match(/Imagine websocket connect failed:\s*(\d{3})\b/i);
  if (matched) {
    const status = Number(matched[1]);
    if (Number.isFinite(status) && status >= 100 && status <= 599) return status;
  }
  return 500;
}

async function verifyWsApiKeyForImagine(c: any): Promise<boolean> {
  const settings = await getSettings(c.env);
  const globalKey = String(settings.grok.api_key ?? "").trim();
  const token = String(c.req.query("api_key") ?? "").trim();

  if (token) {
    if (globalKey && token === globalKey) return true;
    const keyInfo = await validateApiKey(c.env.DB, token);
    return Boolean(keyInfo);
  }

  if (globalKey) return false;
  const row = await dbFirst<{ c: number }>(
    c.env.DB,
    "SELECT COUNT(1) as c FROM api_keys WHERE is_active = 1",
  );
  return (row?.c ?? 0) === 0;
}

export const adminRoutes = new Hono<{ Bindings: Env }>();

// ============================================================================
// Legacy-compatible Admin API (/api/v1/admin/*)
// Used by the newer multi-page admin UI in app/static.
// ============================================================================

function legacyOk(data: Record<string, unknown> = {}): Record<string, unknown> {
  return { status: "success", ...data };
}

function legacyErr(message: string): Record<string, unknown> {
  return { status: "error", error: message };
}

function sourceOk(data: Record<string, unknown> = {}): Record<string, unknown> {
  return { status: "success", ...data };
}

function toSourceConfig(settings: Awaited<ReturnType<typeof getSettings>>): Record<string, unknown> {
  return {
    app: {
      api_key: settings.grok.api_key ?? "",
      app_key: settings.global.admin_password ?? "admin",
      function_enabled: Boolean(settings.global.function_enabled),
      function_key: String(settings.global.function_key ?? ""),
      app_url: settings.global.base_url ?? "",
      image_format: settings.global.image_mode ?? "url",
      video_format: settings.global.video_format ?? "html",
      temporary: Boolean(settings.grok.temporary),
      disable_memory: Boolean(settings.global.disable_memory),
      stream: true,
      thinking: Boolean(settings.grok.show_thinking),
      dynamic_statsig: Boolean(settings.grok.dynamic_statsig),
      custom_instruction: String(settings.global.custom_instruction ?? ""),
      filter_tags: String(settings.grok.filtered_tags ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    },
    proxy: {
      base_proxy_url: String(settings.grok.proxy_url ?? ""),
      asset_proxy_url: String(settings.grok.cache_proxy_url ?? ""),
      skip_proxy_ssl_verify: Boolean(settings.grok.skip_proxy_ssl_verify),
      enabled: false,
      flaresolverr_url: "",
      refresh_interval: 600,
      timeout: 60,
      cf_clearance: String(settings.grok.cf_clearance ?? ""),
      browser: "",
      user_agent: String(settings.grok.user_agent ?? ""),
    },
    retry: {
      max_retry: Number(settings.grok.max_retry ?? 3),
      retry_status_codes: Array.isArray(settings.grok.retry_status_codes) ? settings.grok.retry_status_codes : [401, 429, 403],
      reset_session_status_codes: Array.isArray(settings.grok.reset_session_status_codes) ? settings.grok.reset_session_status_codes : [403],
      retry_backoff_base: Number(settings.grok.retry_backoff_base ?? 0.5),
      retry_backoff_factor: Number(settings.grok.retry_backoff_factor ?? 2),
      retry_backoff_max: Number(settings.grok.retry_backoff_max ?? 20),
      retry_budget: Number(settings.grok.retry_budget ?? 60),
    },
    chat: {
      concurrent: Number(settings.performance.media_max_concurrent ?? 50),
      timeout: Number(settings.grok.stream_total_timeout ?? 60),
      stream_timeout: Number(settings.grok.stream_chunk_timeout ?? 60),
    },
    video: {
      concurrent: Number(settings.video.concurrent ?? 100),
      timeout: Number(settings.video.timeout ?? 60),
      stream_timeout: Number(settings.video.stream_timeout ?? 60),
      upscale_timing: settings.video.upscale_timing ?? "complete",
    },
    image: {
      timeout: Number(settings.image.timeout ?? 60),
      stream_timeout: Number(settings.image.stream_timeout ?? 60),
      final_timeout: Number(settings.image.final_timeout ?? 15),
      blocked_grace_seconds: Number(settings.image.blocked_grace_seconds ?? 10),
      nsfw: Boolean(settings.image.nsfw),
      medium_min_bytes: Number(settings.image.medium_min_bytes ?? 30000),
      final_min_bytes: Number(settings.image.final_min_bytes ?? 100000),
      blocked_parallel_enabled: Boolean(settings.image.blocked_parallel_enabled),
      blocked_parallel_attempts: Number(settings.image.blocked_parallel_attempts ?? 5),
    },
    imagine_fast: {
      n: 1,
      size: "1024x1024",
      response_format: settings.global.image_mode ?? "url",
    },
    asset: {
      upload_concurrent: Number(settings.performance.assets_max_concurrent ?? 25),
      upload_timeout: 60,
      download_concurrent: Number(settings.performance.assets_max_concurrent ?? 25),
      download_timeout: 60,
      list_concurrent: Number(settings.performance.assets_max_concurrent ?? 25),
      list_timeout: 60,
      list_batch_size: 10,
      delete_concurrent: Number(settings.performance.assets_delete_batch_size ?? 10),
      delete_timeout: 60,
      delete_batch_size: 10,
    },
    voice: {
      timeout: 60,
    },
    token: {
      auto_refresh: Boolean(settings.token.auto_refresh),
      refresh_interval_hours: Number(settings.token.refresh_interval_hours ?? 8),
      super_refresh_interval_hours: Number(settings.token.super_refresh_interval_hours ?? 2),
      fail_threshold: Number(settings.token.fail_threshold ?? 5),
      save_delay_ms: Number(settings.token.save_delay_ms ?? 500),
      usage_flush_interval_sec: Number(settings.token.usage_flush_interval_sec ?? 5),
      reload_interval_sec: Number(settings.token.reload_interval_sec ?? 30),
    },
    cache: {
      enable_auto_clean: Boolean(settings.cache.enable_auto_clean),
      limit_mb: Number(settings.cache.limit_mb ?? 1024),
    },
    nsfw: {
      concurrent: 10,
      batch_size: 50,
      timeout: 60,
    },
    usage: {
      concurrent: Number(settings.performance.usage_max_concurrent ?? 25),
      batch_size: 50,
      timeout: 60,
    },
  };
}

function buildBatchSseResponse(streamFactory: (controller: ReadableStreamDefaultController<Uint8Array>) => Promise<void> | void): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      await streamFactory(controller);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function sseData(controller: ReadableStreamDefaultController<Uint8Array>, payload: Record<string, unknown>): void {
  const encoder = new TextEncoder();
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
}

function toPoolName(tokenType: "sso" | "ssoSuper"): "ssoBasic" | "ssoSuper" {
  return tokenType === "ssoSuper" ? "ssoSuper" : "ssoBasic";
}

function poolToTokenType(pool: string): "sso" | "ssoSuper" | null {
  if (pool === "ssoSuper") return "ssoSuper";
  if (pool === "ssoBasic") return "sso";
  return null;
}

async function getKvStats(db: Env["DB"]): Promise<{
  image: { count: number; size_bytes: number; size_mb: number };
  video: { count: number; size_bytes: number; size_mb: number };
}> {
  const rows = await dbAll<{ type: CacheType; count: number; bytes: number }>(
    db,
    "SELECT type as type, COUNT(1) as count, COALESCE(SUM(size),0) as bytes FROM kv_cache GROUP BY type",
  );
  let imageCount = 0;
  let videoCount = 0;
  let imageBytes = 0;
  let videoBytes = 0;
  for (const r of rows) {
    if (r.type === "image") {
      imageCount = r.count;
      imageBytes = r.bytes;
    }
    if (r.type === "video") {
      videoCount = r.count;
      videoBytes = r.bytes;
    }
  }
  const toMb = (b: number) => Math.round((b / (1024 * 1024)) * 10) / 10;
  return {
    image: { count: imageCount, size_bytes: imageBytes, size_mb: toMb(imageBytes) },
    video: { count: videoCount, size_bytes: videoBytes, size_mb: toMb(videoBytes) },
  };
}

async function proxyToApiAdmin(c: any, apiPath: string): Promise<Response> {
  const url = new URL(c.req.url);
  url.pathname = apiPath;
  const request = new Request(url.toString(), c.req.raw);
  return adminRoutes.fetch(request, c.env, c.executionCtx);
}

adminRoutes.post("/api/v1/admin/login", async (c) => {
  try {
    const body = (await c.req.json()) as { username?: string; password?: string };
    const username = String(body?.username ?? "").trim();
    const password = String(body?.password ?? "").trim();
    const reset = await tryResetAdminToDefault({
      env: c.env,
      username,
      password,
    });
    const settings = await getSettings(c.env);

    if (!reset && (username !== settings.global.admin_username || password !== settings.global.admin_password)) {
      return c.json(legacyErr("Invalid username or password"), 401);
    }

    // Return a short-lived admin session token as "api_key" (frontend expects this name).
    const token = await createAdminSession(c.env.DB);
    return c.json(legacyOk({ api_key: token }));
  } catch (e) {
    return c.json(legacyErr(`Login error: ${e instanceof Error ? e.message : String(e)}`), 500);
  }
});

adminRoutes.get("/api/v1/admin/storage", requireAdminAuth, async (c) => {
  return c.json({ type: "d1" });
});

adminRoutes.get("/api/v1/admin/config", requireAdminAuth, async (c) => {
  try {
    const settings = await getSettings(c.env);
    const filterTags = String(settings.grok.filtered_tags ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    return c.json({
      app: {
      api_key: settings.grok.api_key ?? "",
      admin_username: settings.global.admin_username ?? "admin",
      app_key: settings.global.admin_password ?? "admin",
      function_enabled: Boolean(settings.global.function_enabled),
      function_key: String(settings.global.function_key ?? ""),
      app_url: settings.global.base_url ?? "",
      image_format: settings.global.image_mode ?? "url",
      video_format: settings.global.video_format ?? "html",
        disable_memory: Boolean(settings.global.disable_memory),
        custom_instruction: String(settings.global.custom_instruction ?? ""),
      },
      grok: {
        temporary: Boolean(settings.grok.temporary),
        stream: true,
        thinking: Boolean(settings.grok.show_thinking),
        dynamic_statsig: Boolean(settings.grok.dynamic_statsig),
        filter_tags: filterTags,
        video_poster_preview: Boolean(settings.grok.video_poster_preview),
        timeout: Number(settings.grok.stream_total_timeout ?? 600),
        base_proxy_url: String(settings.grok.proxy_url ?? ""),
        asset_proxy_url: String(settings.grok.cache_proxy_url ?? ""),
        cf_cookies: String(settings.grok.cf_cookies ?? ""),
        cf_clearance: String(settings.grok.cf_clearance ?? ""),
        skip_proxy_ssl_verify: Boolean(settings.grok.skip_proxy_ssl_verify),
        max_retry: Number(settings.grok.max_retry ?? 3),
        retry_status_codes: Array.isArray(settings.grok.retry_status_codes) ? settings.grok.retry_status_codes : [401, 429, 403],
        reset_session_status_codes: Array.isArray(settings.grok.reset_session_status_codes)
          ? settings.grok.reset_session_status_codes
          : [403],
        retry_backoff_base: Number(settings.grok.retry_backoff_base ?? 0.5),
        retry_backoff_factor: Number(settings.grok.retry_backoff_factor ?? 2),
        retry_backoff_max: Number(settings.grok.retry_backoff_max ?? 20),
        retry_budget: Number(settings.grok.retry_budget ?? 60),
        image_generation_method: normalizeImageGenerationMethod(
          settings.grok.image_generation_method,
        ),
      },
      token: {
        auto_refresh: Boolean(settings.token.auto_refresh),
        refresh_interval_hours: Number(settings.token.refresh_interval_hours ?? 8),
        super_refresh_interval_hours: Number(settings.token.super_refresh_interval_hours ?? 2),
        fail_threshold: Number(settings.token.fail_threshold ?? 5),
        save_delay_ms: Number(settings.token.save_delay_ms ?? 500),
        usage_flush_interval_sec: Number(settings.token.usage_flush_interval_sec ?? 5),
        reload_interval_sec: Number(settings.token.reload_interval_sec ?? 30),
      },
      cache: {
        enable_auto_clean: Boolean(settings.cache.enable_auto_clean),
        limit_mb: Number(settings.cache.limit_mb ?? 1024),
        keep_base64_cache: Boolean(settings.cache.keep_base64_cache),
      },
      image: {
        timeout: Number(settings.image.timeout ?? 60),
        stream_timeout: Number(settings.image.stream_timeout ?? 60),
        final_timeout: Number(settings.image.final_timeout ?? 15),
        blocked_grace_seconds: Number(settings.image.blocked_grace_seconds ?? 10),
        nsfw: Boolean(settings.image.nsfw),
        medium_min_bytes: Number(settings.image.medium_min_bytes ?? 30000),
        final_min_bytes: Number(settings.image.final_min_bytes ?? 100000),
        blocked_parallel_attempts: Number(settings.image.blocked_parallel_attempts ?? 5),
        blocked_parallel_enabled: Boolean(settings.image.blocked_parallel_enabled),
      },
      video: {
        concurrent: Number(settings.video.concurrent ?? 100),
        timeout: Number(settings.video.timeout ?? 60),
        stream_timeout: Number(settings.video.stream_timeout ?? 60),
        upscale_timing: settings.video.upscale_timing ?? "complete",
      },
      performance: {
        assets_max_concurrent: Number(settings.performance.assets_max_concurrent ?? 25),
        media_max_concurrent: Number(settings.performance.media_max_concurrent ?? 50),
        usage_max_concurrent: Number(settings.performance.usage_max_concurrent ?? 25),
        assets_delete_batch_size: Number(settings.performance.assets_delete_batch_size ?? 10),
        admin_assets_batch_size: Number(settings.performance.admin_assets_batch_size ?? 10),
      },
      register: {
        worker_domain: settings.register.worker_domain ?? "",
        email_domain: settings.register.email_domain ?? "",
        admin_password: settings.register.admin_password ?? "",
        yescaptcha_key: settings.register.yescaptcha_key ?? "",
        solver_url: settings.register.solver_url ?? "",
        solver_browser_type: settings.register.solver_browser_type ?? "camoufox",
        solver_threads: Number(settings.register.solver_threads ?? 5),
        register_threads: Number(settings.register.register_threads ?? 10),
        default_count: Number(settings.register.default_count ?? 100),
        auto_start_solver: Boolean(settings.register.auto_start_solver),
        solver_debug: Boolean(settings.register.solver_debug),
        max_errors: Number(settings.register.max_errors ?? 0),
        max_runtime_minutes: Number(settings.register.max_runtime_minutes ?? 0),
      },
    });
  } catch (e) {
    return c.json(legacyErr(`Get config failed: ${e instanceof Error ? e.message : String(e)}`), 500);
  }
});

adminRoutes.post("/api/v1/admin/config", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as any;
    const appCfg = (body && typeof body === "object" ? body.app : null) as any;
    const grokCfg = (body && typeof body === "object" ? body.grok : null) as any;
    const tokenCfg = (body && typeof body === "object" ? body.token : null) as any;
    const cacheCfg = (body && typeof body === "object" ? body.cache : null) as any;
    const imageCfg = (body && typeof body === "object" ? body.image : null) as any;
    const videoCfg = (body && typeof body === "object" ? body.video : null) as any;
    const performanceCfg = (body && typeof body === "object" ? body.performance : null) as any;

    const global_config: any = {};
    const grok_config: any = {};
    const token_config: any = {};
    const cache_config: any = {};
    const image_config: any = {};
    const video_config: any = {};
    const performance_config: any = {};
    const register_config: any = {};

    if (appCfg && typeof appCfg === "object") {
      if (typeof appCfg.api_key === "string") grok_config.api_key = appCfg.api_key.trim();
      if (typeof appCfg.admin_username === "string") global_config.admin_username = appCfg.admin_username.trim() || "admin";
      if (typeof appCfg.app_key === "string") global_config.admin_password = appCfg.app_key.trim() || "admin";
      if (typeof appCfg.function_enabled === "boolean") global_config.function_enabled = appCfg.function_enabled;
      if (typeof appCfg.function_key === "string") global_config.function_key = appCfg.function_key.trim();
      if (typeof appCfg.app_url === "string") global_config.base_url = appCfg.app_url.trim();
      if (appCfg.video_format === "html" || appCfg.video_format === "url") {
        global_config.video_format = appCfg.video_format;
      }
      if (appCfg.image_format === "url" || appCfg.image_format === "base64" || appCfg.image_format === "b64_json")
        global_config.image_mode = appCfg.image_format;
      if (typeof appCfg.disable_memory === "boolean") global_config.disable_memory = appCfg.disable_memory;
      if (typeof appCfg.custom_instruction === "string") global_config.custom_instruction = appCfg.custom_instruction;
    }

    if (grokCfg && typeof grokCfg === "object") {
      if (typeof grokCfg.base_proxy_url === "string") grok_config.proxy_url = grokCfg.base_proxy_url.trim();
      if (typeof grokCfg.asset_proxy_url === "string") grok_config.cache_proxy_url = grokCfg.asset_proxy_url.trim();
      if (typeof grokCfg.cf_cookies === "string") grok_config.cf_cookies = grokCfg.cf_cookies.trim();
      if (typeof grokCfg.cf_clearance === "string") grok_config.cf_clearance = grokCfg.cf_clearance.trim();
      if (typeof grokCfg.skip_proxy_ssl_verify === "boolean") grok_config.skip_proxy_ssl_verify = grokCfg.skip_proxy_ssl_verify;
      if (typeof grokCfg.filter_tags === "string") {
        grok_config.filtered_tags = grokCfg.filter_tags;
      } else if (Array.isArray(grokCfg.filter_tags)) {
        grok_config.filtered_tags = grokCfg.filter_tags.map((x: any) => String(x ?? "").trim()).filter(Boolean).join(",");
      }
      if (typeof grokCfg.dynamic_statsig === "boolean") grok_config.dynamic_statsig = grokCfg.dynamic_statsig;
      if (typeof grokCfg.thinking === "boolean") grok_config.show_thinking = grokCfg.thinking;
      if (typeof grokCfg.temporary === "boolean") grok_config.temporary = grokCfg.temporary;
      if (typeof grokCfg.video_poster_preview === "boolean") grok_config.video_poster_preview = grokCfg.video_poster_preview;
      if (Number.isFinite(Number(grokCfg.max_retry))) grok_config.max_retry = Math.max(1, Math.floor(Number(grokCfg.max_retry)));
      if (Array.isArray(grokCfg.retry_status_codes))
        grok_config.retry_status_codes = grokCfg.retry_status_codes.map((x: any) => Number(x)).filter((n: number) => Number.isFinite(n));
      if (Array.isArray(grokCfg.reset_session_status_codes))
        grok_config.reset_session_status_codes = grokCfg.reset_session_status_codes
          .map((x: any) => Number(x))
          .filter((n: number) => Number.isFinite(n));
      if (Number.isFinite(Number(grokCfg.retry_backoff_base))) grok_config.retry_backoff_base = Math.max(0, Number(grokCfg.retry_backoff_base));
      if (Number.isFinite(Number(grokCfg.retry_backoff_factor))) grok_config.retry_backoff_factor = Math.max(1, Number(grokCfg.retry_backoff_factor));
      if (Number.isFinite(Number(grokCfg.retry_backoff_max))) grok_config.retry_backoff_max = Math.max(0, Number(grokCfg.retry_backoff_max));
      if (Number.isFinite(Number(grokCfg.retry_budget))) grok_config.retry_budget = Math.max(0, Number(grokCfg.retry_budget));
      if (Number.isFinite(Number(grokCfg.timeout))) grok_config.stream_total_timeout = Math.max(1, Math.floor(Number(grokCfg.timeout)));
      if (typeof grokCfg.image_generation_method === "string" && grokCfg.image_generation_method.trim()) {
        grok_config.image_generation_method = normalizeImageGenerationMethod(
          grokCfg.image_generation_method,
        );
      }
    }

    if (tokenCfg && typeof tokenCfg === "object") {
      if (typeof tokenCfg.auto_refresh === "boolean") token_config.auto_refresh = tokenCfg.auto_refresh;
      if (Number.isFinite(Number(tokenCfg.refresh_interval_hours)))
        token_config.refresh_interval_hours = Math.max(1, Number(tokenCfg.refresh_interval_hours));
      if (Number.isFinite(Number(tokenCfg.super_refresh_interval_hours)))
        token_config.super_refresh_interval_hours = Math.max(1, Number(tokenCfg.super_refresh_interval_hours));
      if (Number.isFinite(Number(tokenCfg.fail_threshold)))
        token_config.fail_threshold = Math.max(1, Math.floor(Number(tokenCfg.fail_threshold)));
      if (Number.isFinite(Number(tokenCfg.save_delay_ms)))
        token_config.save_delay_ms = Math.max(0, Math.floor(Number(tokenCfg.save_delay_ms)));
      if (Number.isFinite(Number(tokenCfg.usage_flush_interval_sec)))
        token_config.usage_flush_interval_sec = Math.max(0, Math.floor(Number(tokenCfg.usage_flush_interval_sec)));
      if (Number.isFinite(Number(tokenCfg.reload_interval_sec)))
        token_config.reload_interval_sec = Math.max(0, Math.floor(Number(tokenCfg.reload_interval_sec)));
    }

    if (cacheCfg && typeof cacheCfg === "object") {
      if (typeof cacheCfg.enable_auto_clean === "boolean") cache_config.enable_auto_clean = cacheCfg.enable_auto_clean;
      if (Number.isFinite(Number(cacheCfg.limit_mb))) cache_config.limit_mb = Math.max(1, Math.floor(Number(cacheCfg.limit_mb)));
      if (typeof cacheCfg.keep_base64_cache === "boolean") cache_config.keep_base64_cache = cacheCfg.keep_base64_cache;
    }

    if (imageCfg && typeof imageCfg === "object") {
      if (Number.isFinite(Number(imageCfg.timeout))) image_config.timeout = Math.max(1, Math.floor(Number(imageCfg.timeout)));
      if (Number.isFinite(Number(imageCfg.stream_timeout))) image_config.stream_timeout = Math.max(1, Math.floor(Number(imageCfg.stream_timeout)));
      if (Number.isFinite(Number(imageCfg.final_timeout))) image_config.final_timeout = Math.max(1, Number(imageCfg.final_timeout));
      if (Number.isFinite(Number(imageCfg.blocked_grace_seconds))) image_config.blocked_grace_seconds = Math.max(1, Number(imageCfg.blocked_grace_seconds));
      if (typeof imageCfg.nsfw === "boolean") image_config.nsfw = imageCfg.nsfw;
      if (Number.isFinite(Number(imageCfg.medium_min_bytes))) image_config.medium_min_bytes = Math.max(1, Math.floor(Number(imageCfg.medium_min_bytes)));
      if (Number.isFinite(Number(imageCfg.final_min_bytes))) image_config.final_min_bytes = Math.max(1, Math.floor(Number(imageCfg.final_min_bytes)));
      if (Number.isFinite(Number(imageCfg.blocked_parallel_attempts))) image_config.blocked_parallel_attempts = Math.max(0, Math.floor(Number(imageCfg.blocked_parallel_attempts)));
      if (typeof imageCfg.blocked_parallel_enabled === "boolean") image_config.blocked_parallel_enabled = imageCfg.blocked_parallel_enabled;
    }

    if (videoCfg && typeof videoCfg === "object") {
      if (Number.isFinite(Number(videoCfg.concurrent))) video_config.concurrent = Math.max(1, Math.floor(Number(videoCfg.concurrent)));
      if (Number.isFinite(Number(videoCfg.timeout))) video_config.timeout = Math.max(1, Math.floor(Number(videoCfg.timeout)));
      if (Number.isFinite(Number(videoCfg.stream_timeout))) video_config.stream_timeout = Math.max(1, Math.floor(Number(videoCfg.stream_timeout)));
      if (videoCfg.upscale_timing === "single" || videoCfg.upscale_timing === "complete") video_config.upscale_timing = videoCfg.upscale_timing;
    }

    if (performanceCfg && typeof performanceCfg === "object") {
      const fields = [
        "assets_max_concurrent",
        "media_max_concurrent",
        "usage_max_concurrent",
        "assets_delete_batch_size",
        "admin_assets_batch_size",
      ] as const;
      for (const f of fields) {
        if (Number.isFinite(Number(performanceCfg[f]))) performance_config[f] = Math.max(1, Math.floor(Number(performanceCfg[f])));
      }
    }

    const registerCfg = (body && typeof body === "object" ? body.register : null) as any;
    if (registerCfg && typeof registerCfg === "object") {
      if (typeof registerCfg.worker_domain === "string") register_config.worker_domain = registerCfg.worker_domain.trim();
      if (typeof registerCfg.email_domain === "string") register_config.email_domain = registerCfg.email_domain.trim();
      if (typeof registerCfg.admin_password === "string") register_config.admin_password = registerCfg.admin_password.trim();
      if (typeof registerCfg.yescaptcha_key === "string") register_config.yescaptcha_key = registerCfg.yescaptcha_key.trim();
      if (typeof registerCfg.solver_url === "string") register_config.solver_url = registerCfg.solver_url.trim();
      if (typeof registerCfg.solver_browser_type === "string") register_config.solver_browser_type = registerCfg.solver_browser_type.trim();
      if (Number.isFinite(Number(registerCfg.solver_threads))) register_config.solver_threads = Math.max(1, Math.floor(Number(registerCfg.solver_threads)));
      if (Number.isFinite(Number(registerCfg.register_threads))) register_config.register_threads = Math.max(1, Math.floor(Number(registerCfg.register_threads)));
      if (Number.isFinite(Number(registerCfg.default_count))) register_config.default_count = Math.max(1, Math.floor(Number(registerCfg.default_count)));
      if (typeof registerCfg.auto_start_solver === "boolean") register_config.auto_start_solver = registerCfg.auto_start_solver;
      if (typeof registerCfg.solver_debug === "boolean") register_config.solver_debug = registerCfg.solver_debug;
      if (Number.isFinite(Number(registerCfg.max_errors))) register_config.max_errors = Math.max(0, Math.floor(Number(registerCfg.max_errors)));
      if (Number.isFinite(Number(registerCfg.max_runtime_minutes))) register_config.max_runtime_minutes = Math.max(0, Math.floor(Number(registerCfg.max_runtime_minutes)));
    }

    await saveSettings(c.env, {
      global_config,
      grok_config,
      token_config,
      cache_config,
      image_config,
      video_config,
      performance_config,
      register_config,
    });
    return c.json(legacyOk({ message: "配置已更新" }));
  } catch (e) {
    return c.json(legacyErr(`Update config failed: ${e instanceof Error ? e.message : String(e)}`), 500);
  }
});

adminRoutes.get("/api/v1/admin/imagine/ws", async (c) => {
  const upgrade = c.req.header("upgrade") ?? c.req.header("Upgrade");
  if (String(upgrade ?? "").toLowerCase() !== "websocket") {
    return c.text("Expected websocket upgrade", 426);
  }

  const wsPair = new WebSocketPair();
  const client = wsPair[0];
  const server = wsPair[1];
  server.accept();

  const authed = await verifyWsApiKeyForImagine(c);
  if (!authed) {
    try {
      server.close(1008, "Auth failed");
    } catch {
      // ignore close failure
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  const settings = await getSettings(c.env);
  const cf = normalizeCfCookie(settings.grok.cf_clearance ?? "");

  let socketClosed = false;
  let runToken = 0;
  let currentRunId = "";
  let sequence = 0;
  let running = false;

  const send = (payload: Record<string, unknown>): boolean => {
    if (socketClosed) return false;
    try {
      server.send(JSON.stringify(payload));
      return true;
    } catch {
      socketClosed = true;
      return false;
    }
  };

  const stopRun = (sendStatus: boolean): void => {
    if (!running) return;
    running = false;
    runToken += 1;
    if (sendStatus && currentRunId) {
      send({ type: "status", status: "stopped", run_id: currentRunId });
    }
  };

  const startRun = (prompt: string, aspectRatio: string): void => {
    runToken += 1;
    const localToken = runToken;
    running = true;
    currentRunId = crypto.randomUUID().replaceAll("-", "");
    const runId = currentRunId;
    sequence = 0;

    send({
      type: "status",
      status: "running",
      prompt,
      aspect_ratio: aspectRatio,
      run_id: runId,
    });

    void (async () => {
      while (!socketClosed && localToken === runToken) {
        let chosen: { token: string; token_type: "sso" | "ssoSuper" } | null = null;
        try {
          chosen = await selectBestToken(c.env.DB, "grok-imagine-1.0");
          if (!chosen) {
            send({
              type: "error",
              message: "No available tokens. Please try again later.",
              code: "rate_limit_exceeded",
            });
            await wsSleep(2000);
            continue;
          }

          const cookie = cf
            ? `sso-rw=${chosen.token};sso=${chosen.token};${cf}`
            : `sso-rw=${chosen.token};sso=${chosen.token}`;
          const startAt = Date.now();
          const urls = await generateImagineWs({
            prompt,
            n: 6,
            cookie,
            settings: settings.grok,
            aspectRatio,
          });
          if (socketClosed || localToken !== runToken) break;

          const elapsedMs = Date.now() - startAt;
          let sentAny = false;
          for (const rawUrl of urls) {
            const raw = String(rawUrl ?? "").trim();
            if (!raw) continue;
            sentAny = true;
            sequence += 1;
            const encoded = encodeAssetPath(raw);
            const url = `/images/${encodeURIComponent(encoded)}`;
            const ok = send({
              type: "image",
              url,
              sequence,
              created_at: Date.now(),
              elapsed_ms: elapsedMs,
              aspect_ratio: aspectRatio,
              run_id: runId,
            });
            if (!ok) {
              socketClosed = true;
              break;
            }
          }

          if (!sentAny) {
            send({
              type: "error",
              message: "Image generation returned empty data.",
              code: "empty_image",
            });
          }
        } catch (e) {
          if (socketClosed || localToken !== runToken) break;
          const message = e instanceof Error ? e.message : String(e);
          if (chosen?.token) {
            const status = parseImagineWsFailureStatus(message);
            const trimmed = message.slice(0, 200);
            try {
              await recordTokenFailure(c.env.DB, chosen.token, status, trimmed);
              await applyCooldown(c.env.DB, chosen.token, status);
            } catch {
              // ignore token cooldown failures
            }
          }
          send({
            type: "error",
            message: message || "Internal error",
            code: "internal_error",
          });
          await wsSleep(1500);
        }
      }

      if (!socketClosed && localToken === runToken) {
        running = false;
        send({ type: "status", status: "stopped", run_id: runId });
      }
    })();
  };

  server.addEventListener("message", (event) => {
    const payload = parseWsMessageData(event.data);
    if (!payload) {
      send({
        type: "error",
        message: "Invalid message format.",
        code: "invalid_payload",
      });
      return;
    }

    const msgType = String(payload.type ?? "").trim();
    if (msgType === "start") {
      const prompt = String(payload.prompt ?? "").trim();
      if (!prompt) {
        send({
          type: "error",
          message: "Prompt cannot be empty.",
          code: "empty_prompt",
        });
        return;
      }
      const ratio = resolveAspectRatio(String(payload.aspect_ratio ?? "2:3").trim());
      stopRun(false);
      startRun(prompt, ratio);
      return;
    }

    if (msgType === "stop") {
      stopRun(true);
      return;
    }

    if (msgType === "ping") {
      send({ type: "pong" });
      return;
    }

    send({
      type: "error",
      message: "Unknown command.",
      code: "unknown_command",
    });
  });

  server.addEventListener("close", () => {
    socketClosed = true;
    runToken += 1;
    running = false;
  });
  server.addEventListener("error", () => {
    socketClosed = true;
    runToken += 1;
    running = false;
  });

  return new Response(null, { status: 101, webSocket: client });
});

adminRoutes.get("/api/v1/admin/tokens", requireAdminAuth, async (c) => {
  try {
    const rows = await listTokens(c.env.DB);
    const now = nowMs();

    const out: Record<"ssoBasic" | "ssoSuper", any[]> = { ssoBasic: [], ssoSuper: [] };
    for (const r of rows) {
      const pool = toPoolName(r.token_type);
      const isCooling = Boolean(r.cooldown_until && r.cooldown_until > now);
      const status = r.status === "expired" ? "invalid" : isCooling ? "cooling" : "active";
      const quotaKnown = Number.isFinite(r.remaining_queries) && r.remaining_queries >= 0;
      const quota = quotaKnown ? r.remaining_queries : -1;
      const heavyQuotaKnown =
        r.token_type === "ssoSuper" && Number.isFinite(r.heavy_remaining_queries) && r.heavy_remaining_queries >= 0;
      const heavyQuota = heavyQuotaKnown ? r.heavy_remaining_queries : -1;
      out[pool].push({
        token: `sso=${r.token}`,
        status,
        quota,
        quota_known: quotaKnown,
        heavy_quota: heavyQuota,
        heavy_quota_known: heavyQuotaKnown,
        token_type: r.token_type,
        note: r.note ?? "",
        fail_count: r.failed_count ?? 0,
        use_count: 0,
      });
    }
    return c.json(out);
  } catch (e) {
    return c.json(legacyErr(`Get tokens failed: ${e instanceof Error ? e.message : String(e)}`), 500);
  }
});

adminRoutes.post("/api/v1/admin/tokens", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    if (!body || typeof body !== "object") return c.json(legacyErr("Invalid payload"), 400);

    const rows = await listTokens(c.env.DB);
    const byType: Record<"sso" | "ssoSuper", Set<string>> = { sso: new Set(), ssoSuper: new Set() };
    for (const r of rows) byType[r.token_type].add(r.token);
    const existingAll = new Set<string>(rows.map((r) => r.token));
    const newlyAdded: string[] = [];

    const now = nowMs();
    const desiredByType: Record<"sso" | "ssoSuper", Set<string>> = { sso: new Set(), ssoSuper: new Set() };
    const stmts: D1PreparedStatement[] = [];

    for (const [pool, items] of Object.entries(body)) {
      const tokenType = poolToTokenType(pool);
      if (!tokenType) continue;
      const arr = Array.isArray(items) ? items : [];
      for (const it of arr) {
        const tokenRaw = typeof it === "string" ? it : (it as any)?.token;
        const token = normalizeSsoToken(String(tokenRaw ?? ""));
        if (!token) continue;
        desiredByType[tokenType].add(token);
        if (!existingAll.has(token)) {
          existingAll.add(token);
          newlyAdded.push(token);
        }

        const statusRaw = typeof it === "string" ? "active" : String((it as any)?.status ?? "active");
        const quotaRaw = typeof it === "string" ? 0 : Number((it as any)?.quota ?? 0);
        const quota = Number.isFinite(quotaRaw) && quotaRaw >= 0 ? Math.floor(quotaRaw) : -1;
        const heavyQuotaRaw =
          typeof it === "string"
            ? -1
            : Number((it as any)?.heavy_quota ?? (tokenType === "ssoSuper" ? quota : -1));
        const heavyQuota = Number.isFinite(heavyQuotaRaw) && heavyQuotaRaw >= 0 ? Math.floor(heavyQuotaRaw) : -1;
        const note = typeof it === "string" ? "" : String((it as any)?.note ?? "");

        const status = statusRaw === "invalid" ? "expired" : "active";
        const cooldownUntil = statusRaw === "cooling" ? now + 60 * 60 * 1000 : null;

        const remaining = quota >= 0 ? quota : -1;
        const heavy = tokenType === "ssoSuper" ? heavyQuota : -1;

        stmts.push(
          c.env.DB.prepare(
            "INSERT INTO tokens(token, token_type, created_time, remaining_queries, heavy_remaining_queries, status, failed_count, cooldown_until, last_failure_time, last_failure_reason, tags, note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(token) DO UPDATE SET token_type=excluded.token_type, remaining_queries=excluded.remaining_queries, heavy_remaining_queries=excluded.heavy_remaining_queries, status=excluded.status, cooldown_until=excluded.cooldown_until, note=excluded.note",
          ).bind(token, tokenType, now, remaining, heavy, status, 0, cooldownUntil, null, null, "[]", note),
        );
      }
    }

    // Delete tokens removed from the posted pools
    for (const tokenType of ["sso", "ssoSuper"] as const) {
      const existing = byType[tokenType];
      const desired = desiredByType[tokenType];
      const toDel: string[] = [];
      for (const t of existing) if (!desired.has(t)) toDel.push(t);
      if (toDel.length) {
        const placeholders = toDel.map(() => "?").join(",");
        stmts.push(c.env.DB.prepare(`DELETE FROM tokens WHERE token_type = ? AND token IN (${placeholders})`).bind(tokenType, ...toDel));
      }
    }

    if (stmts.length) await c.env.DB.batch(stmts);
    return c.json(legacyOk({ message: "Token 已更新" }));
  } catch (e) {
    return c.json(legacyErr(`Update tokens failed: ${e instanceof Error ? e.message : String(e)}`), 500);
  }
});

adminRoutes.post("/api/v1/admin/tokens/refresh", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as any;
    const tokens: string[] = [];
    if (body && typeof body === "object") {
      if (typeof body.token === "string") tokens.push(body.token);
      if (Array.isArray(body.tokens)) tokens.push(...body.tokens.filter((x: any) => typeof x === "string"));
    }
    const unique = [...new Set(tokens.map((t) => normalizeSsoToken(t)).filter(Boolean))];
    if (!unique.length) return c.json(legacyErr("No tokens provided"), 400);

    const settings = await getSettings(c.env);
    const cf = normalizeCfCookie(settings.grok.cf_clearance ?? "");

    const placeholders = unique.map(() => "?").join(",");
    const typeRows = placeholders
      ? await dbAll<{ token: string; token_type: string }>(
          c.env.DB,
          `SELECT token, token_type FROM tokens WHERE token IN (${placeholders})`,
          unique,
        )
      : [];
    const tokenTypeByToken = new Map(typeRows.map((r) => [r.token, r.token_type]));

    const results: Record<string, boolean> = {};
    for (const t of unique) {
      try {
        const cookie = cf ? `sso-rw=${t};sso=${t};${cf}` : `sso-rw=${t};sso=${t}`;
        const tokenType = tokenTypeByToken.get(t) ?? "sso";
        const r = await checkRateLimits(cookie, settings.grok, "grok-4");
        const remaining = (r as any)?.remainingTokens;
        let heavyRemaining: number | null = null;
        if (tokenType === "ssoSuper") {
          const rh = await checkRateLimits(cookie, settings.grok, "grok-4-heavy");
          const hv = (rh as any)?.remainingTokens;
          if (typeof hv === "number") heavyRemaining = hv;
        }
        if (typeof remaining === "number") {
          await updateTokenLimits(c.env.DB, t, {
            remaining_queries: remaining,
            ...(heavyRemaining !== null ? { heavy_remaining_queries: heavyRemaining } : {}),
          });
          results[`sso=${t}`] = true;
        } else {
          results[`sso=${t}`] = false;
        }
      } catch {
        results[`sso=${t}`] = false;
      }
      await new Promise((res) => setTimeout(res, 50));
    }

    return c.json(legacyOk({ results }));
  } catch (e) {
    return c.json(legacyErr(`Refresh failed: ${e instanceof Error ? e.message : String(e)}`), 500);
  }
});

adminRoutes.get("/api/v1/admin/cache/local", requireAdminAuth, async (c) => {
  try {
    const stats = await getKvStats(c.env.DB);
    return c.json({ local_image: stats.image, local_video: stats.video });
  } catch (e) {
    return c.json(legacyErr(`Get cache stats failed: ${e instanceof Error ? e.message : String(e)}`), 500);
  }
});

adminRoutes.get("/api/v1/admin/cache", requireAdminAuth, async (c) => {
  try {
    const stats = await getKvStats(c.env.DB);
    return c.json({
      local_image: stats.image,
      local_video: stats.video,
      online: { count: 0, status: "not_loaded", token: null, last_asset_clear_at: null },
      online_accounts: [],
      online_scope: "none",
      online_details: [],
    });
  } catch (e) {
    return c.json(legacyErr(`Get cache failed: ${e instanceof Error ? e.message : String(e)}`), 500);
  }
});

adminRoutes.post("/api/v1/admin/cache/clear", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as any;
    const t = String(body?.type ?? "image").toLowerCase();
    const type: CacheType = t === "video" ? "video" : "image";
    const deleted = await clearKvCacheByType(c.env, type);
    return c.json(legacyOk({ result: { deleted } }));
  } catch (e) {
    return c.json(legacyErr(`Clear cache failed: ${e instanceof Error ? e.message : String(e)}`), 500);
  }
});

adminRoutes.get("/api/v1/admin/cache/list", requireAdminAuth, async (c) => {
  try {
    const t = String(c.req.query("type") ?? "image").toLowerCase();
    const type: CacheType = t === "video" ? "video" : "image";
    const page = Math.max(1, Number(c.req.query("page") ?? 1));
    const pageSize = Math.max(1, Math.min(5000, Number(c.req.query("page_size") ?? 1000)));
    const offset = (page - 1) * pageSize;

    const { total, items } = await listCacheRowsByType(c.env.DB, type, pageSize, offset);
    const mapped = items.map((it) => {
      const name = it.key.startsWith(`${type}/`) ? it.key.slice(type.length + 1) : it.key;
      return {
        name,
        size_bytes: it.size,
        mtime_ms: it.last_access_at || it.created_at,
        preview_url: type === "image" ? `/images/${encodeURIComponent(name)}` : "",
      };
    });

    return c.json(legacyOk({ total, page, page_size: pageSize, items: mapped }));
  } catch (e) {
    return c.json(legacyErr(`List cache failed: ${e instanceof Error ? e.message : String(e)}`), 500);
  }
});

adminRoutes.post("/api/v1/admin/cache/item/delete", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as any;
    const t = String(body?.type ?? "image").toLowerCase();
    const type: CacheType = t === "video" ? "video" : "image";
    const name = String(body?.name ?? "").trim();
    if (!name) return c.json(legacyErr("Missing file name"), 400);
    const key = name.startsWith(`${type}/`) ? name : `${type}/${name}`;
    await c.env.KV_CACHE.delete(key);
    await dbRun(c.env.DB, "DELETE FROM kv_cache WHERE key = ?", [key]);
    return c.json(legacyOk({ result: { deleted: true } }));
  } catch (e) {
    return c.json(legacyErr(`Delete failed: ${e instanceof Error ? e.message : String(e)}`), 500);
  }
});

adminRoutes.post("/api/v1/admin/cache/online/clear", requireAdminAuth, async (c) => {
  return c.json(legacyErr("Online assets clear is not supported on Cloudflare Workers"), 501);
});

// ============================================================================
// Source-compatible Admin API (/v1/admin/*)
// Used by upstream static admin UI.
// ============================================================================

adminRoutes.get("/v1/admin/verify", async (c) => {
  const token = parseBearer(c.req.header("Authorization") ?? null);
  if (!token) {
    return c.json({ error: "缺少会话", code: "MISSING_SESSION" }, 401);
  }

  const reset = await tryResetAdminToDefault({
    env: c.env,
    bearer: token,
  });
  if (reset) {
    return c.json(sourceOk({ verified: true, reset: true }));
  }

  const settings = await getSettings(c.env);
  const appKey = String(settings.global.admin_password ?? "").trim();
  if (appKey && token === appKey) {
    return c.json(sourceOk({ verified: true }));
  }

  const sessionOk = await verifyAdminSession(c.env.DB, token);
  if (!sessionOk) {
    return c.json({ error: "会话已过期", code: "SESSION_EXPIRED" }, 401);
  }
  return c.json(sourceOk({ verified: true }));
});

adminRoutes.get("/v1/admin/storage", requireAdminAuth, async (c) =>
  proxyToApiAdmin(c, "/api/v1/admin/storage"),
);

adminRoutes.get("/v1/admin/config", requireAdminAuth, async (c) => {
  try {
    const settings = await getSettings(c.env);
    return c.json(toSourceConfig(settings));
  } catch (e) {
    return c.json(legacyErr(`Get config failed: ${e instanceof Error ? e.message : String(e)}`), 500);
  }
});

adminRoutes.post("/v1/admin/config", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as any;
    const app = body?.app ?? {};
    const proxy = body?.proxy ?? {};
    const retry = body?.retry ?? {};
    const chat = body?.chat ?? {};
    const image = body?.image ?? {};
    const video = body?.video ?? {};
    const token = body?.token ?? {};
    const cache = body?.cache ?? {};
    const usage = body?.usage ?? {};
    const asset = body?.asset ?? {};

    const global_config: Record<string, unknown> = {};
    const grok_config: Record<string, unknown> = {};
    const token_config: Record<string, unknown> = {};
    const cache_config: Record<string, unknown> = {};
    const image_config: Record<string, unknown> = {};
    const video_config: Record<string, unknown> = {};
    const performance_config: Record<string, unknown> = {};

    if (typeof app.api_key === "string") grok_config.api_key = app.api_key.trim();
    if (typeof app.app_key === "string") global_config.admin_password = app.app_key.trim() || "admin";
    if (typeof app.function_enabled === "boolean") global_config.function_enabled = app.function_enabled;
    if (typeof app.function_key === "string") global_config.function_key = app.function_key.trim();
    if (typeof app.app_url === "string") global_config.base_url = app.app_url.trim();
    if (typeof app.image_format === "string") global_config.image_mode = app.image_format;
    if (app.video_format === "html" || app.video_format === "url") global_config.video_format = app.video_format;
    if (typeof app.disable_memory === "boolean") global_config.disable_memory = app.disable_memory;
    if (typeof app.custom_instruction === "string") global_config.custom_instruction = app.custom_instruction;
    if (typeof app.dynamic_statsig === "boolean") grok_config.dynamic_statsig = app.dynamic_statsig;
    if (typeof app.thinking === "boolean") grok_config.show_thinking = app.thinking;
    if (typeof app.temporary === "boolean") grok_config.temporary = app.temporary;
    if (Array.isArray(app.filter_tags)) {
      grok_config.filtered_tags = app.filter_tags.map((value: any) => String(value ?? "").trim()).filter(Boolean).join(",");
    }

    if (typeof proxy.base_proxy_url === "string") grok_config.proxy_url = proxy.base_proxy_url.trim();
    if (typeof proxy.asset_proxy_url === "string") grok_config.cache_proxy_url = proxy.asset_proxy_url.trim();
    if (typeof proxy.cf_clearance === "string") grok_config.cf_clearance = proxy.cf_clearance.trim();
    if (typeof proxy.user_agent === "string") grok_config.user_agent = proxy.user_agent.trim();
    if (typeof proxy.skip_proxy_ssl_verify === "boolean") grok_config.skip_proxy_ssl_verify = proxy.skip_proxy_ssl_verify;

    if (Number.isFinite(Number(retry.max_retry))) grok_config.max_retry = Math.max(1, Math.floor(Number(retry.max_retry)));
    if (Array.isArray(retry.retry_status_codes)) grok_config.retry_status_codes = retry.retry_status_codes.map((v: any) => Number(v)).filter((n: number) => Number.isFinite(n));
    if (Array.isArray(retry.reset_session_status_codes)) grok_config.reset_session_status_codes = retry.reset_session_status_codes.map((v: any) => Number(v)).filter((n: number) => Number.isFinite(n));
    if (Number.isFinite(Number(retry.retry_backoff_base))) grok_config.retry_backoff_base = Math.max(0, Number(retry.retry_backoff_base));
    if (Number.isFinite(Number(retry.retry_backoff_factor))) grok_config.retry_backoff_factor = Math.max(1, Number(retry.retry_backoff_factor));
    if (Number.isFinite(Number(retry.retry_backoff_max))) grok_config.retry_backoff_max = Math.max(0, Number(retry.retry_backoff_max));
    if (Number.isFinite(Number(retry.retry_budget))) grok_config.retry_budget = Math.max(0, Number(retry.retry_budget));

    if (Number.isFinite(Number(chat.timeout))) grok_config.stream_total_timeout = Math.max(1, Math.floor(Number(chat.timeout)));
    if (Number.isFinite(Number(chat.stream_timeout))) grok_config.stream_chunk_timeout = Math.max(1, Math.floor(Number(chat.stream_timeout)));

    if (Number.isFinite(Number(video.concurrent))) video_config.concurrent = Math.max(1, Math.floor(Number(video.concurrent)));
    if (Number.isFinite(Number(video.timeout))) video_config.timeout = Math.max(1, Math.floor(Number(video.timeout)));
    if (Number.isFinite(Number(video.stream_timeout))) video_config.stream_timeout = Math.max(1, Math.floor(Number(video.stream_timeout)));
    if (video.upscale_timing === "single" || video.upscale_timing === "complete") video_config.upscale_timing = video.upscale_timing;

    if (Number.isFinite(Number(image.timeout))) image_config.timeout = Math.max(1, Math.floor(Number(image.timeout)));
    if (Number.isFinite(Number(image.stream_timeout))) image_config.stream_timeout = Math.max(1, Math.floor(Number(image.stream_timeout)));
    if (Number.isFinite(Number(image.final_timeout))) image_config.final_timeout = Math.max(1, Number(image.final_timeout));
    if (Number.isFinite(Number(image.blocked_grace_seconds))) image_config.blocked_grace_seconds = Math.max(1, Number(image.blocked_grace_seconds));
    if (typeof image.nsfw === "boolean") image_config.nsfw = image.nsfw;
    if (Number.isFinite(Number(image.medium_min_bytes))) image_config.medium_min_bytes = Math.max(1, Math.floor(Number(image.medium_min_bytes)));
    if (Number.isFinite(Number(image.final_min_bytes))) image_config.final_min_bytes = Math.max(1, Math.floor(Number(image.final_min_bytes)));
    if (typeof image.blocked_parallel_enabled === "boolean") image_config.blocked_parallel_enabled = image.blocked_parallel_enabled;
    if (Number.isFinite(Number(image.blocked_parallel_attempts))) image_config.blocked_parallel_attempts = Math.max(0, Math.floor(Number(image.blocked_parallel_attempts)));

    if (typeof token.auto_refresh === "boolean") token_config.auto_refresh = token.auto_refresh;
    if (Number.isFinite(Number(token.refresh_interval_hours))) token_config.refresh_interval_hours = Math.max(1, Number(token.refresh_interval_hours));
    if (Number.isFinite(Number(token.super_refresh_interval_hours))) token_config.super_refresh_interval_hours = Math.max(1, Number(token.super_refresh_interval_hours));
    if (Number.isFinite(Number(token.fail_threshold))) token_config.fail_threshold = Math.max(1, Math.floor(Number(token.fail_threshold)));
    if (Number.isFinite(Number(token.save_delay_ms))) token_config.save_delay_ms = Math.max(0, Math.floor(Number(token.save_delay_ms)));
    if (Number.isFinite(Number(token.usage_flush_interval_sec))) token_config.usage_flush_interval_sec = Math.max(0, Math.floor(Number(token.usage_flush_interval_sec)));
    if (Number.isFinite(Number(token.reload_interval_sec))) token_config.reload_interval_sec = Math.max(0, Math.floor(Number(token.reload_interval_sec)));

    if (typeof cache.enable_auto_clean === "boolean") cache_config.enable_auto_clean = cache.enable_auto_clean;
    if (Number.isFinite(Number(cache.limit_mb))) cache_config.limit_mb = Math.max(1, Math.floor(Number(cache.limit_mb)));

    if (Number.isFinite(Number(usage.concurrent))) performance_config.usage_max_concurrent = Math.max(1, Math.floor(Number(usage.concurrent)));
    if (Number.isFinite(Number(asset.upload_concurrent))) performance_config.assets_max_concurrent = Math.max(1, Math.floor(Number(asset.upload_concurrent)));
    if (Number.isFinite(Number(asset.delete_concurrent))) performance_config.assets_delete_batch_size = Math.max(1, Math.floor(Number(asset.delete_concurrent)));

    await saveSettings(c.env, { global_config, grok_config, token_config, cache_config, image_config, video_config, performance_config });
    return c.json(sourceOk({ message: "配置已更新" }));
  } catch (e) {
    return c.json(legacyErr(`Update config failed: ${e instanceof Error ? e.message : String(e)}`), 500);
  }
});

adminRoutes.get("/v1/admin/tokens", requireAdminAuth, async (c) =>
  proxyToApiAdmin(c, "/api/v1/admin/tokens"),
);

adminRoutes.post("/v1/admin/tokens", requireAdminAuth, async (c) =>
  proxyToApiAdmin(c, "/api/v1/admin/tokens"),
);

adminRoutes.post("/v1/admin/tokens/refresh", requireAdminAuth, async (c) =>
  proxyToApiAdmin(c, "/api/v1/admin/tokens/refresh"),
);

adminRoutes.post("/v1/admin/tokens/refresh/async", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { tokens?: string[] };
    const unique = Array.isArray(body?.tokens)
      ? [...new Set(body.tokens.map((token) => normalizeSsoToken(String(token ?? ""))).filter(Boolean))]
      : [];
    if (!unique.length) return c.json(legacyErr("No tokens provided"), 400);

    await setRefreshProgress(c.env.DB, {
      running: true,
      current: 0,
      total: unique.length,
      success: 0,
      failed: 0,
    });

    const settings = await getSettings(c.env);
    const cf = normalizeCfCookie(settings.grok.cf_clearance ?? "");

    c.executionCtx.waitUntil((async () => {
      let success = 0;
      let failed = 0;
      for (let i = 0; i < unique.length; i++) {
        const latest = await getRefreshProgress(c.env.DB);
        if (!latest.running) {
          await setRefreshProgress(c.env.DB, { running: false, current: i, total: unique.length, success, failed });
          return;
        }
        const token = unique[i]!;
        try {
          const cookie = cf ? `sso-rw=${token};sso=${token};${cf}` : `sso-rw=${token};sso=${token}`;
          const result = await checkRateLimits(cookie, settings.grok, "grok-4");
          const remaining = (result as any)?.remainingTokens;
          if (typeof remaining === "number") {
            await updateTokenLimits(c.env.DB, token, { remaining_queries: remaining });
            success += 1;
          } else {
            failed += 1;
          }
        } catch {
          failed += 1;
        }
        await setRefreshProgress(c.env.DB, { running: true, current: i + 1, total: unique.length, success, failed });
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await setRefreshProgress(c.env.DB, { running: false, current: unique.length, total: unique.length, success, failed });
    })());

    return c.json(sourceOk({ task_id: "token-refresh" }));
  } catch (e) {
    return c.json(legacyErr(`Refresh failed: ${e instanceof Error ? e.message : String(e)}`), 500);
  }
});

adminRoutes.post("/v1/admin/tokens/nsfw/enable/async", requireAdminAuth, async (c) => {
  return c.json(sourceOk({ task_id: "nsfw-unsupported", warning: "NSFW async refresh is not supported on Cloudflare Workers" }));
});

adminRoutes.get("/v1/admin/cache", requireAdminAuth, async (c) =>
  proxyToApiAdmin(c, "/api/v1/admin/cache"),
);

adminRoutes.get("/v1/admin/cache/list", requireAdminAuth, async (c) =>
  proxyToApiAdmin(c, "/api/v1/admin/cache/list"),
);

adminRoutes.post("/v1/admin/cache/clear", requireAdminAuth, async (c) =>
  proxyToApiAdmin(c, "/api/v1/admin/cache/clear"),
);

adminRoutes.post("/v1/admin/cache/item/delete", requireAdminAuth, async (c) =>
  proxyToApiAdmin(c, "/api/v1/admin/cache/item/delete"),
);

adminRoutes.post("/v1/admin/cache/online/load/async", requireAdminAuth, async (c) => {
  return c.json(sourceOk({ task_id: "cache-load-unsupported", warning: "Online asset load is not supported on Cloudflare Workers" }));
});

adminRoutes.post("/v1/admin/cache/online/clear/async", requireAdminAuth, async (c) => {
  return c.json(sourceOk({ task_id: "cache-clear-unsupported", warning: "Online asset clear is not supported on Cloudflare Workers" }));
});

adminRoutes.post("/v1/admin/cache/online/clear", requireAdminAuth, async (c) => {
  return c.json(legacyErr("Online assets clear is not supported on Cloudflare Workers"), 501);
});

adminRoutes.get("/v1/admin/batch/:taskId/stream", async (c) => {
  const token = String(c.req.query("app_key") ?? "").trim();
  const settings = await getSettings(c.env);
  if (!token || token !== String(settings.global.admin_password ?? "").trim()) {
    return c.text("Unauthorized", 401);
  }

  const taskId = c.req.param("taskId");
  if (taskId === "nsfw-unsupported" || taskId === "cache-load-unsupported" || taskId === "cache-clear-unsupported") {
    return buildBatchSseResponse((controller) => {
      sseData(controller, {
        type: "done",
        total: 0,
        processed: 0,
        warning: "This operation is not supported on Cloudflare Workers",
        result: taskId === "nsfw-unsupported" ? { summary: { ok: 0, fail: 0 } } : { results: {} },
      });
      controller.close();
    });
  }

  if (taskId !== "token-refresh") {
    return c.text("Not Found", 404);
  }

  return buildBatchSseResponse(async (controller) => {
    while (true) {
      const progress = await getRefreshProgress(c.env.DB);
      sseData(controller, {
        type: progress.running ? "progress" : "done",
        total: progress.total,
        processed: progress.current,
        result: { summary: { ok: progress.success, fail: progress.failed } },
      });
      if (!progress.running) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    controller.close();
  });
});

adminRoutes.post("/v1/admin/batch/:taskId/cancel", requireAdminAuth, async (c) => {
  const taskId = c.req.param("taskId");
  if (taskId === "token-refresh") {
    await setRefreshProgress(c.env.DB, { running: false });
  }
  return c.json(sourceOk({ cancelled: true }));
});

adminRoutes.get("/api/v1/admin/metrics", requireAdminAuth, async (c) => {
  try {
    const now = nowMs();
    const rows = await listTokens(c.env.DB);
    let total = 0;
    let active = 0;
    let cooling = 0;
    let expired = 0;
    let chatQuota = 0;
    for (const t of rows) {
      total += 1;
      if (t.status === "expired") {
        expired += 1;
        continue;
      }
      if (t.cooldown_until && t.cooldown_until > now) {
        cooling += 1;
        continue;
      }
      active += 1;
      if (t.remaining_queries > 0) chatQuota += t.remaining_queries;
    }

    const stats = await getKvStats(c.env.DB);
    const reqStats = await getRequestStats(c.env.DB);
    const totalCallsRow = await dbFirst<{ c: number }>(c.env.DB, "SELECT COUNT(1) as c FROM request_logs");
    const totalCalls = totalCallsRow?.c ?? 0;

    return c.json({
      tokens: {
        total,
        active,
        cooling,
        expired,
        disabled: 0,
        chat_quota: chatQuota,
        image_quota: Math.floor(chatQuota / 2),
        total_calls: totalCalls,
      },
      cache: { local_image: stats.image, local_video: stats.video },
      request_stats: reqStats,
    });
  } catch (e) {
    return c.json(legacyErr(`Get metrics failed: ${e instanceof Error ? e.message : String(e)}`), 500);
  }
});

adminRoutes.get("/api/v1/admin/logs/files", requireAdminAuth, async (c) => {
  const now = nowMs();
  return c.json({ files: [{ name: "request_logs", size_bytes: 0, mtime_ms: now }] });
});

adminRoutes.get("/api/v1/admin/logs/tail", requireAdminAuth, async (c) => {
  try {
    const file = String(c.req.query("file") ?? "request_logs");
    const limit = Math.max(50, Math.min(5000, Number(c.req.query("lines") ?? 500)));
    const rows = await getRequestLogs(c.env.DB, limit);
    const lines = rows.map((r) => `${r.time} | ${r.status} | ${r.model} | ${r.ip} | ${r.key_name} | ${r.error}`.trim());
    return c.json({ file, lines });
  } catch (e) {
    return c.json(legacyErr(`Tail failed: ${e instanceof Error ? e.message : String(e)}`), 500);
  }
});

adminRoutes.post("/api/login", async (c) => {
  try {
    const body = (await c.req.json()) as { username?: string; password?: string };
    const username = String(body.username ?? "").trim();
    const password = String(body.password ?? "").trim();
    const reset = await tryResetAdminToDefault({
      env: c.env,
      username,
      password,
    });
    const settings = await getSettings(c.env);

    if (!reset && (username !== settings.global.admin_username || password !== settings.global.admin_password)) {
      return c.json({ success: false, message: "用户名或密码错误" });
    }

    const token = await createAdminSession(c.env.DB);
    return c.json({ success: true, token, message: "登录成功" });
  } catch (e) {
    return c.json(jsonError(`登录失败: ${e instanceof Error ? e.message : String(e)}`, "LOGIN_ERROR"), 500);
  }
});

adminRoutes.post("/api/logout", requireAdminAuth, async (c) => {
  try {
    const token = parseBearer(c.req.header("Authorization") ?? null);
    if (token) await deleteAdminSession(c.env.DB, token);
    return c.json({ success: true, message: "登出成功" });
  } catch (e) {
    return c.json(jsonError(`登出失败: ${e instanceof Error ? e.message : String(e)}`, "LOGOUT_ERROR"), 500);
  }
});

adminRoutes.get("/api/settings", requireAdminAuth, async (c) => {
  try {
    const settings = await getSettings(c.env);
    return c.json({ success: true, data: settings });
  } catch (e) {
    return c.json(jsonError(`获取失败: ${e instanceof Error ? e.message : String(e)}`, "GET_SETTINGS_ERROR"), 500);
  }
});

adminRoutes.post("/api/settings", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { global_config?: any; grok_config?: any };
    await saveSettings(c.env, { global_config: body.global_config, grok_config: body.grok_config });
    return c.json({ success: true, message: "配置更新成功" });
  } catch (e) {
    return c.json(jsonError(`更新失败: ${e instanceof Error ? e.message : String(e)}`, "UPDATE_SETTINGS_ERROR"), 500);
  }
});

adminRoutes.get("/api/storage/mode", requireAdminAuth, async (c) => {
  return c.json({ success: true, data: { mode: "D1" } });
});

adminRoutes.get("/api/tokens", requireAdminAuth, async (c) => {
  try {
    const rows = await listTokens(c.env.DB);
    const infos = rows.map(tokenRowToInfo);
    return c.json({ success: true, data: infos, total: infos.length });
  } catch (e) {
    return c.json(jsonError(`获取失败: ${e instanceof Error ? e.message : String(e)}`, "TOKENS_LIST_ERROR"), 500);
  }
});

adminRoutes.post("/api/tokens/add", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { tokens?: string[]; token_type?: string };
    const token_type = validateTokenType(String(body.token_type ?? ""));
    const tokens = Array.isArray(body.tokens) ? body.tokens : [];
    const count = await addTokens(c.env.DB, tokens, token_type);
    return c.json({ success: true, message: `添加成功(${count})` });
  } catch (e) {
    return c.json(jsonError(`添加失败: ${e instanceof Error ? e.message : String(e)}`, "TOKENS_ADD_ERROR"), 500);
  }
});

adminRoutes.post("/api/tokens/delete", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { tokens?: string[]; token_type?: string };
    const token_type = validateTokenType(String(body.token_type ?? ""));
    const tokens = Array.isArray(body.tokens) ? body.tokens : [];
    const deleted = await deleteTokens(c.env.DB, tokens, token_type);
    return c.json({ success: true, message: `删除成功(${deleted})` });
  } catch (e) {
    return c.json(jsonError(`删除失败: ${e instanceof Error ? e.message : String(e)}`, "TOKENS_DELETE_ERROR"), 500);
  }
});

adminRoutes.post("/api/tokens/tags", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { token?: string; token_type?: string; tags?: string[] };
    const token_type = validateTokenType(String(body.token_type ?? ""));
    const token = String(body.token ?? "");
    const tags = Array.isArray(body.tags) ? body.tags : [];
    await updateTokenTags(c.env.DB, token, token_type, tags);
    return c.json({ success: true, message: "标签更新成功", tags });
  } catch (e) {
    return c.json(jsonError(`更新失败: ${e instanceof Error ? e.message : String(e)}`, "UPDATE_TAGS_ERROR"), 500);
  }
});

adminRoutes.post("/api/tokens/note", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { token?: string; token_type?: string; note?: string };
    const token_type = validateTokenType(String(body.token_type ?? ""));
    const token = String(body.token ?? "");
    const note = String(body.note ?? "");
    await updateTokenNote(c.env.DB, token, token_type, note);
    return c.json({ success: true, message: "备注更新成功", note });
  } catch (e) {
    return c.json(jsonError(`更新失败: ${e instanceof Error ? e.message : String(e)}`, "UPDATE_NOTE_ERROR"), 500);
  }
});

adminRoutes.get("/api/tokens/tags/all", requireAdminAuth, async (c) => {
  try {
    const tags = await getAllTags(c.env.DB);
    return c.json({ success: true, data: tags });
  } catch (e) {
    return c.json(jsonError(`获取失败: ${e instanceof Error ? e.message : String(e)}`, "GET_TAGS_ERROR"), 500);
  }
});

adminRoutes.post("/api/tokens/test", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { token?: string; token_type?: string };
    const token_type = validateTokenType(String(body.token_type ?? ""));
    const token = String(body.token ?? "");
    const settings = await getSettings(c.env);

    const cf = normalizeCfCookie(settings.grok.cf_clearance ?? "");
    const cookie = cf ? `sso-rw=${token};sso=${token};${cf}` : `sso-rw=${token};sso=${token}`;

    const result = await checkRateLimits(cookie, settings.grok, "grok-4");
    if (result) {
      const remaining = (result as any).remainingTokens ?? -1;
      const limit = (result as any).limit ?? -1;

      let heavyRemaining: number | null = null;
      if (token_type === "ssoSuper") {
        const heavy = await checkRateLimits(cookie, settings.grok, "grok-4-heavy");
        const v = (heavy as any)?.remainingTokens;
        if (typeof v === "number") heavyRemaining = v;
      }
      await updateTokenLimits(c.env.DB, token, {
        remaining_queries: typeof remaining === "number" ? remaining : -1,
        ...(heavyRemaining !== null ? { heavy_remaining_queries: heavyRemaining } : {}),
      });
      return c.json({
        success: true,
        message: "Token有效",
        data: {
          valid: true,
          remaining_queries: typeof remaining === "number" ? remaining : -1,
          heavy_remaining_queries: heavyRemaining !== null ? heavyRemaining : -1,
          limit,
        },
      });
    }

    // Fallback：根据本地状态判断原因
    const rows = await listTokens(c.env.DB);
    const row = rows.find((r) => r.token === token && r.token_type === token_type);
    if (!row) {
      return c.json({ success: false, message: "Token数据异常", data: { valid: false, error_type: "unknown" } });
    }
    const now = Date.now();
    if (row.status === "expired") {
      return c.json({ success: false, message: "Token已失效", data: { valid: false, error_type: "expired", error_code: 401 } });
    }
    if (row.cooldown_until && row.cooldown_until > now) {
      const remaining = Math.floor((row.cooldown_until - now + 999) / 1000);
      return c.json({
        success: false,
        message: "Token处于冷却中",
        data: { valid: false, error_type: "cooldown", error_code: 429, cooldown_remaining: remaining },
      });
    }
    const exhausted =
      token_type === "ssoSuper"
        ? row.remaining_queries === 0 || row.heavy_remaining_queries === 0
        : row.remaining_queries === 0;
    if (exhausted) {
      return c.json({
        success: false,
        message: "Token额度耗尽",
        data: { valid: false, error_type: "exhausted", error_code: "quota_exhausted" },
      });
    }
    return c.json({
      success: false,
      message: "服务器被 block 或网络错误",
      data: { valid: false, error_type: "blocked", error_code: 403 },
    });
  } catch (e) {
    return c.json(jsonError(`测试失败: ${e instanceof Error ? e.message : String(e)}`, "TEST_TOKEN_ERROR"), 500);
  }
});

adminRoutes.post("/api/tokens/refresh-all", requireAdminAuth, async (c) => {
  try {
    const progress = await getRefreshProgress(c.env.DB);
    if (progress.running) {
      return c.json({ success: false, message: "刷新任务正在进行中", data: progress });
    }

    const tokens = await listTokens(c.env.DB);
    await setRefreshProgress(c.env.DB, {
      running: true,
      current: 0,
      total: tokens.length,
      success: 0,
      failed: 0,
    });

    const settings = await getSettings(c.env);
    const cf = normalizeCfCookie(settings.grok.cf_clearance ?? "");

    c.executionCtx.waitUntil(
      (async () => {
        let success = 0;
        let failed = 0;
        for (let i = 0; i < tokens.length; i++) {
          const t = tokens[i]!;
          const cookie = cf ? `sso-rw=${t.token};sso=${t.token};${cf}` : `sso-rw=${t.token};sso=${t.token}`;
          const r = await checkRateLimits(cookie, settings.grok, "grok-4");
          if (r) {
            const remaining = (r as any).remainingTokens;
            let heavyRemaining: number | null = null;
            if (t.token_type === "ssoSuper") {
              const rh = await checkRateLimits(cookie, settings.grok, "grok-4-heavy");
              const hv = (rh as any)?.remainingTokens;
              if (typeof hv === "number") heavyRemaining = hv;
            }
            if (typeof remaining === "number") {
              await updateTokenLimits(c.env.DB, t.token, {
                remaining_queries: remaining,
                ...(heavyRemaining !== null ? { heavy_remaining_queries: heavyRemaining } : {}),
              });
            }
            success += 1;
          } else {
            failed += 1;
          }
          await setRefreshProgress(c.env.DB, { running: true, current: i + 1, total: tokens.length, success, failed });
          await new Promise((res) => setTimeout(res, 100));
        }
        await setRefreshProgress(c.env.DB, { running: false, current: tokens.length, total: tokens.length, success, failed });
      })(),
    );

    return c.json({ success: true, message: "刷新任务已启动", data: { started: true } });
  } catch (e) {
    return c.json(jsonError(`刷新失败: ${e instanceof Error ? e.message : String(e)}`, "REFRESH_ALL_ERROR"), 500);
  }
});

adminRoutes.get("/api/tokens/refresh-progress", requireAdminAuth, async (c) => {
  try {
    const progress = await getRefreshProgress(c.env.DB);
    return c.json({ success: true, data: progress });
  } catch (e) {
    return c.json(jsonError(`获取失败: ${e instanceof Error ? e.message : String(e)}`, "GET_PROGRESS_ERROR"), 500);
  }
});

adminRoutes.get("/api/stats", requireAdminAuth, async (c) => {
  try {
    const rows = await listTokens(c.env.DB);
    const now = Date.now();

    const calc = (type: "sso" | "ssoSuper") => {
      const tokens = rows.filter((r) => r.token_type === type);
      const total = tokens.length;
      const expired = tokens.filter((t) => t.status === "expired").length;
      let cooldown = 0;
      let exhausted = 0;
      let unused = 0;
      let active = 0;

      for (const t of tokens) {
        if (t.status === "expired") continue;
        if (t.cooldown_until && t.cooldown_until > now) {
          cooldown += 1;
          continue;
        }

        const isUnused = type === "ssoSuper" ? t.remaining_queries === -1 && t.heavy_remaining_queries === -1 : t.remaining_queries === -1;
        if (isUnused) {
          unused += 1;
          continue;
        }

        const isExhausted = type === "ssoSuper" ? t.remaining_queries === 0 || t.heavy_remaining_queries === 0 : t.remaining_queries === 0;
        if (isExhausted) {
          exhausted += 1;
          continue;
        }
        active += 1;
      }

      return { total, expired, active, cooldown, exhausted, unused };
    };

    const normal = calc("sso");
    const superStats = calc("ssoSuper");
    return c.json({ success: true, data: { normal, super: superStats, total: normal.total + superStats.total } });
  } catch (e) {
    return c.json(jsonError(`获取失败: ${e instanceof Error ? e.message : String(e)}`, "STATS_ERROR"), 500);
  }
});

adminRoutes.get("/api/request-stats", requireAdminAuth, async (c) => {
  try {
    const stats = await getRequestStats(c.env.DB);
    return c.json({ success: true, data: stats });
  } catch (e) {
    return c.json(jsonError(`获取失败: ${e instanceof Error ? e.message : String(e)}`, "REQUEST_STATS_ERROR"), 500);
  }
});

// === API Keys (admin UI) ===
function randomKeyName(): string {
  return `key-${crypto.randomUUID().slice(0, 8)}`;
}

adminRoutes.get("/api/v1/admin/keys", requireAdminAuth, async (c) => {
  try {
    const keys = await listApiKeys(c.env.DB);
    const tz = Math.max(-720, Math.min(840, Number(c.env.CACHE_RESET_TZ_OFFSET_MINUTES ?? 480)));
    const day = localDayString(nowMs(), tz);
    const usageRows = await listUsageForDay(c.env.DB, day);
    const usageMap = new Map(usageRows.map((r) => [r.key, r]));

    const data = keys.map((k) => {
      const used = usageMap.get(k.key) ?? { chat_used: 0, heavy_used: 0, image_used: 0, video_used: 0 };
      const remaining = {
        chat: k.chat_limit < 0 ? null : Math.max(0, k.chat_limit - Number((used as any).chat_used ?? 0)),
        heavy: k.heavy_limit < 0 ? null : Math.max(0, k.heavy_limit - Number((used as any).heavy_used ?? 0)),
        image: k.image_limit < 0 ? null : Math.max(0, k.image_limit - Number((used as any).image_used ?? 0)),
        video: k.video_limit < 0 ? null : Math.max(0, k.video_limit - Number((used as any).video_used ?? 0)),
      };
      return {
        ...k,
        is_active: Boolean(k.is_active),
        display_key: displayKey(k.key),
        usage_today: {
          chat_used: Number((used as any).chat_used ?? 0),
          heavy_used: Number((used as any).heavy_used ?? 0),
          image_used: Number((used as any).image_used ?? 0),
          video_used: Number((used as any).video_used ?? 0),
        },
        remaining_today: remaining,
      };
    });

    return c.json({ success: true, data });
  } catch (e) {
    return c.json(jsonError(`获取失败: ${e instanceof Error ? e.message : String(e)}`, "ADMIN_KEYS_LIST_ERROR"), 500);
  }
});

adminRoutes.post("/api/v1/admin/keys", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as any;
    const name = String(body?.name ?? "").trim() || randomKeyName();
    const key = String(body?.key ?? "").trim();
    const limits = body?.limits && typeof body.limits === "object" ? body.limits : {};

    const row = await addApiKey(c.env.DB, name, {
      ...(key ? { key } : {}),
      limits: {
        chat_limit: limits.chat_per_day ?? limits.chat_limit,
        heavy_limit: limits.heavy_per_day ?? limits.heavy_limit,
        image_limit: limits.image_per_day ?? limits.image_limit,
        video_limit: limits.video_per_day ?? limits.video_limit,
      },
    });

    const isActive = body?.is_active !== undefined ? Boolean(body.is_active) : true;
    if (!isActive) await updateApiKeyStatus(c.env.DB, row.key, false);

    return c.json({ success: true, data: { ...row, is_active: isActive, display_key: displayKey(row.key) } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE|constraint/i.test(msg)) return c.json(jsonError("Key 已存在", "KEY_EXISTS"), 400);
    return c.json(jsonError(`创建失败: ${msg}`, "ADMIN_KEYS_CREATE_ERROR"), 500);
  }
});

adminRoutes.post("/api/v1/admin/keys/update", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as any;
    const key = String(body?.key ?? "").trim();
    if (!key) return c.json(jsonError("Missing key", "MISSING_KEY"), 400);
    const existed = await dbFirst<{ key: string }>(c.env.DB, "SELECT key FROM api_keys WHERE key = ?", [key]);
    if (!existed) return c.json(jsonError("Key not found", "NOT_FOUND"), 404);

    if (body?.name !== undefined) {
      const name = String(body.name ?? "").trim();
      if (name) await updateApiKeyName(c.env.DB, key, name);
    }

    if (body?.is_active !== undefined) {
      await updateApiKeyStatus(c.env.DB, key, Boolean(body.is_active));
    }

    if (body?.limits && typeof body.limits === "object") {
      const limits = body.limits;
      await updateApiKeyLimits(c.env.DB, key, {
        ...(limits.chat_per_day !== undefined || limits.chat_limit !== undefined
          ? { chat_limit: limits.chat_per_day ?? limits.chat_limit }
          : {}),
        ...(limits.heavy_per_day !== undefined || limits.heavy_limit !== undefined
          ? { heavy_limit: limits.heavy_per_day ?? limits.heavy_limit }
          : {}),
        ...(limits.image_per_day !== undefined || limits.image_limit !== undefined
          ? { image_limit: limits.image_per_day ?? limits.image_limit }
          : {}),
        ...(limits.video_per_day !== undefined || limits.video_limit !== undefined
          ? { video_limit: limits.video_per_day ?? limits.video_limit }
          : {}),
      });
    }

    return c.json({ success: true });
  } catch (e) {
    return c.json(jsonError(`更新失败: ${e instanceof Error ? e.message : String(e)}`, "ADMIN_KEYS_UPDATE_ERROR"), 500);
  }
});

adminRoutes.post("/api/v1/admin/keys/delete", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as any;
    const key = String(body?.key ?? "").trim();
    if (!key) return c.json(jsonError("Missing key", "MISSING_KEY"), 400);
    const ok = await deleteApiKey(c.env.DB, key);
    return c.json(ok ? { success: true } : jsonError("Key not found", "NOT_FOUND"), ok ? 200 : 404);
  } catch (e) {
    return c.json(jsonError(`删除失败: ${e instanceof Error ? e.message : String(e)}`, "ADMIN_KEYS_DELETE_ERROR"), 500);
  }
});

// === API Keys ===
adminRoutes.get("/api/keys", requireAdminAuth, async (c) => {
  try {
    const keys = await listApiKeys(c.env.DB);
    const settings = await getSettings(c.env);
    const globalKeySet = Boolean((settings.grok.api_key ?? "").trim());
    const data = keys.map((k) => ({ ...k, display_key: displayKey(k.key) }));
    return c.json({ success: true, data, global_key_set: globalKeySet });
  } catch (e) {
    return c.json(jsonError(`获取失败: ${e instanceof Error ? e.message : String(e)}`, "KEYS_LIST_ERROR"), 500);
  }
});

adminRoutes.post("/api/keys/add", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { name?: string };
    const name = String(body.name ?? "").trim();
    if (!name) return c.json({ success: false, message: "name不能为空" });
    const row = await addApiKey(c.env.DB, name);
    return c.json({ success: true, data: row, message: "Key创建成功" });
  } catch (e) {
    return c.json(jsonError(`添加失败: ${e instanceof Error ? e.message : String(e)}`, "KEY_ADD_ERROR"), 500);
  }
});

adminRoutes.post("/api/keys/batch-add", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { name_prefix?: string; count?: number };
    const prefix = String(body.name_prefix ?? "").trim();
    const count = Math.max(1, Math.min(100, Number(body.count ?? 1)));
    if (!prefix) return c.json({ success: false, message: "name_prefix不能为空" });
    const rows = await batchAddApiKeys(c.env.DB, prefix, count);
    return c.json({ success: true, data: rows, message: `成功创建 ${rows.length} 个Key` });
  } catch (e) {
    return c.json(jsonError(`批量添加失败: ${e instanceof Error ? e.message : String(e)}`, "KEY_BATCH_ADD_ERROR"), 500);
  }
});

adminRoutes.post("/api/keys/delete", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { key?: string };
    const key = String(body.key ?? "");
    if (!key) return c.json({ success: false, message: "Key不能为空" });
    const ok = await deleteApiKey(c.env.DB, key);
    return c.json(ok ? { success: true, message: "Key删除成功" } : { success: false, message: "Key不存在" });
  } catch (e) {
    return c.json(jsonError(`删除失败: ${e instanceof Error ? e.message : String(e)}`, "KEY_DELETE_ERROR"), 500);
  }
});

adminRoutes.post("/api/keys/batch-delete", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { keys?: string[] };
    const keys = Array.isArray(body.keys) ? body.keys : [];
    const deleted = await batchDeleteApiKeys(c.env.DB, keys);
    return c.json({ success: true, message: `成功删除 ${deleted} 个Key` });
  } catch (e) {
    return c.json(jsonError(`批量删除失败: ${e instanceof Error ? e.message : String(e)}`, "KEY_BATCH_DELETE_ERROR"), 500);
  }
});

adminRoutes.post("/api/keys/status", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { key?: string; is_active?: boolean };
    const key = String(body.key ?? "");
    const ok = await updateApiKeyStatus(c.env.DB, key, Boolean(body.is_active));
    return c.json(ok ? { success: true, message: "状态更新成功" } : { success: false, message: "Key不存在" });
  } catch (e) {
    return c.json(jsonError(`更新失败: ${e instanceof Error ? e.message : String(e)}`, "KEY_STATUS_ERROR"), 500);
  }
});

adminRoutes.post("/api/keys/batch-status", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { keys?: string[]; is_active?: boolean };
    const keys = Array.isArray(body.keys) ? body.keys : [];
    const updated = await batchUpdateApiKeyStatus(c.env.DB, keys, Boolean(body.is_active));
    return c.json({ success: true, message: `成功更新 ${updated} 个Key 状态` });
  } catch (e) {
    return c.json(jsonError(`批量更新失败: ${e instanceof Error ? e.message : String(e)}`, "KEY_BATCH_STATUS_ERROR"), 500);
  }
});

adminRoutes.post("/api/keys/name", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { key?: string; name?: string };
    const ok = await updateApiKeyName(c.env.DB, String(body.key ?? ""), String(body.name ?? ""));
    return c.json(ok ? { success: true, message: "备注更新成功" } : { success: false, message: "Key不存在" });
  } catch (e) {
    return c.json(jsonError(`更新失败: ${e instanceof Error ? e.message : String(e)}`, "KEY_NAME_ERROR"), 500);
  }
});

// === Logs ===
adminRoutes.get("/api/logs", requireAdminAuth, async (c) => {
  try {
    const limitStr = c.req.query("limit");
    const limit = Math.max(1, Math.min(5000, Number(limitStr ?? 1000)));
    const logs = await getRequestLogs(c.env.DB, limit);
    return c.json({ success: true, data: logs });
  } catch (e) {
    return c.json(jsonError(`获取失败: ${e instanceof Error ? e.message : String(e)}`, "GET_LOGS_ERROR"), 500);
  }
});

adminRoutes.post("/api/logs/clear", requireAdminAuth, async (c) => {
  try {
    await clearRequestLogs(c.env.DB);
    return c.json({ success: true, message: "日志已清空" });
  } catch (e) {
    return c.json(jsonError(`清空失败: ${e instanceof Error ? e.message : String(e)}`, "CLEAR_LOGS_ERROR"), 500);
  }
});

// Cache endpoints (Workers Cache API 无法枚举/统计；这里提供兼容返回，保持后台可用)
adminRoutes.get("/api/cache/size", requireAdminAuth, async (c) => {
  try {
    const bytes = await getCacheSizeBytes(c.env.DB);
    return c.json({
      success: true,
      data: {
        image_size: formatBytes(bytes.image),
        video_size: formatBytes(bytes.video),
        total_size: formatBytes(bytes.total),
        image_size_bytes: bytes.image,
        video_size_bytes: bytes.video,
        total_size_bytes: bytes.total,
      },
    });
  } catch (e) {
    return c.json(jsonError(`获取失败: ${e instanceof Error ? e.message : String(e)}`, "CACHE_SIZE_ERROR"), 500);
  }
});

adminRoutes.get("/api/cache/list", requireAdminAuth, async (c) => {
  try {
    const t = (c.req.query("type") ?? "image").toLowerCase();
    const type: CacheType = t === "video" ? "video" : "image";
    const limit = Math.max(1, Math.min(200, Number(c.req.query("limit") ?? 50)));
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0));

    const { total, items } = await listCacheRowsByType(c.env.DB, type, limit, offset);
    const mapped = items.map((it) => {
      const name = it.key.startsWith(`${type}/`) ? it.key.slice(type.length + 1) : it.key;
      return {
        name,
        size: formatBytes(it.size),
        mtime: it.last_access_at || it.created_at,
        url: `/images/${name}`,
      };
    });

    return c.json({
      success: true,
      data: { total, items: mapped, offset, limit, has_more: offset + mapped.length < total },
    });
  } catch (e) {
    return c.json(jsonError(`获取失败: ${e instanceof Error ? e.message : String(e)}`, "CACHE_LIST_ERROR"), 500);
  }
});

adminRoutes.post("/api/cache/clear", requireAdminAuth, async (c) => {
  try {
    const deletedImages = await clearKvCacheByType(c.env, "image");
    const deletedVideos = await clearKvCacheByType(c.env, "video");
    return c.json({
      success: true,
      message: `缓存清理完成，已删除 ${deletedImages + deletedVideos} 个文件`,
      data: { deleted_count: deletedImages + deletedVideos },
    });
  } catch (e) {
    return c.json(jsonError(`清理失败: ${e instanceof Error ? e.message : String(e)}`, "CACHE_CLEAR_ERROR"), 500);
  }
});
adminRoutes.post("/api/cache/clear/images", requireAdminAuth, async (c) => {
  try {
    const deleted = await clearKvCacheByType(c.env, "image");
    return c.json({ success: true, message: `图片缓存清理完成，已删除 ${deleted} 个文件`, data: { deleted_count: deleted, type: "images" } });
  } catch (e) {
    return c.json(jsonError(`清理失败: ${e instanceof Error ? e.message : String(e)}`, "IMAGE_CACHE_CLEAR_ERROR"), 500);
  }
});
adminRoutes.post("/api/cache/clear/videos", requireAdminAuth, async (c) => {
  try {
    const deleted = await clearKvCacheByType(c.env, "video");
    return c.json({ success: true, message: `视频缓存清理完成，已删除 ${deleted} 个文件`, data: { deleted_count: deleted, type: "videos" } });
  } catch (e) {
    return c.json(jsonError(`清理失败: ${e instanceof Error ? e.message : String(e)}`, "VIDEO_CACHE_CLEAR_ERROR"), 500);
  }
});

// A lightweight endpoint to create an audit log from the panel if needed (optional)
adminRoutes.post("/api/logs/add", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { model?: string; status?: number; error?: string };
    await addRequestLog(c.env.DB, {
      ip: "admin",
      model: String(body.model ?? "admin"),
      duration: 0,
      status: Number(body.status ?? 200),
      key_name: "admin",
      token_suffix: "",
      error: String(body.error ?? ""),
    });
    return c.json({ success: true });
  } catch (e) {
    return c.json(jsonError(`写入失败: ${e instanceof Error ? e.message : String(e)}`, "LOG_ADD_ERROR"), 500);
  }
});
