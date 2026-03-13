import { dbFirst, dbRun } from "./db";
import type { Env } from "./env";
import { nowMs } from "./utils/time";

export interface GlobalSettings {
  base_url?: string;
  log_level?: string;
  image_mode?: "url" | "base64" | "b64_json";
  video_format?: "html" | "url";
  admin_username?: string;
  admin_password?: string;
  disable_memory?: boolean;
  custom_instruction?: string;
  image_cache_max_size_mb?: number;
  video_cache_max_size_mb?: number;
}

export interface GrokSettings {
  api_key?: string;
  proxy_url?: string;
  proxy_pool_url?: string;
  proxy_pool_interval?: number;
  cache_proxy_url?: string;
  cf_cookies?: string;
  cf_clearance?: string; // stored as VALUE only (no "cf_clearance=" prefix)
  skip_proxy_ssl_verify?: boolean;
  x_statsig_id?: string;
  dynamic_statsig?: boolean;
  user_agent?: string;
  filtered_tags?: string;
  show_thinking?: boolean;
  temporary?: boolean;
  video_poster_preview?: boolean;
  max_retry?: number;
  stream_first_response_timeout?: number;
  stream_chunk_timeout?: number;
  stream_total_timeout?: number;
  retry_status_codes?: number[];
  reset_session_status_codes?: number[];
  retry_backoff_base?: number;
  retry_backoff_factor?: number;
  retry_backoff_max?: number;
  retry_budget?: number;
  image_generation_method?: string;
}

export interface TokenSettings {
  auto_refresh?: boolean;
  refresh_interval_hours?: number;
  super_refresh_interval_hours?: number;
  fail_threshold?: number;
  save_delay_ms?: number;
  usage_flush_interval_sec?: number;
  reload_interval_sec?: number;
}

export interface CacheSettings {
  enable_auto_clean?: boolean;
  limit_mb?: number;
  keep_base64_cache?: boolean;
}

export interface ImageSettings {
  timeout?: number;
  stream_timeout?: number;
  final_timeout?: number;
  blocked_grace_seconds?: number;
  nsfw?: boolean;
  medium_min_bytes?: number;
  final_min_bytes?: number;
  blocked_parallel_attempts?: number;
  blocked_parallel_enabled?: boolean;
}

export interface VideoSettings {
  concurrent?: number;
  timeout?: number;
  stream_timeout?: number;
  upscale_timing?: "single" | "complete";
}

export interface PerformanceSettings {
  assets_max_concurrent?: number;
  media_max_concurrent?: number;
  usage_max_concurrent?: number;
  assets_delete_batch_size?: number;
  admin_assets_batch_size?: number;
}

export interface RegisterSettings {
  worker_domain?: string;
  email_domain?: string;
  admin_password?: string;
  yescaptcha_key?: string;
  solver_url?: string;
  solver_browser_type?: string;
  solver_threads?: number;
  register_threads?: number;
  default_count?: number;
  auto_start_solver?: boolean;
  solver_debug?: boolean;
  max_errors?: number;
  max_runtime_minutes?: number;
}

export interface SettingsBundle {
  global: Required<GlobalSettings>;
  grok: Required<GrokSettings>;
  token: Required<TokenSettings>;
  cache: Required<CacheSettings>;
  image: Required<ImageSettings>;
  video: Required<VideoSettings>;
  performance: Required<PerformanceSettings>;
  register: Required<RegisterSettings>;
}

const DEFAULTS: SettingsBundle = {
  global: {
    base_url: "",
    log_level: "INFO",
    image_mode: "url",
    video_format: "html",
    admin_username: "admin",
    admin_password: "admin",
    disable_memory: true,
    custom_instruction: "",
    image_cache_max_size_mb: 512,
    video_cache_max_size_mb: 1024,
  },
  grok: {
    api_key: "",
    proxy_url: "",
    proxy_pool_url: "",
    proxy_pool_interval: 300,
    cache_proxy_url: "",
    cf_cookies: "",
    cf_clearance: "",
    skip_proxy_ssl_verify: false,
    x_statsig_id: "",
    dynamic_statsig: true,
    user_agent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    filtered_tags: "xaiartifact,xai:tool_usage_card",
    show_thinking: true,
    temporary: false,
    video_poster_preview: false,
    max_retry: 3,
    stream_first_response_timeout: 30,
    stream_chunk_timeout: 120,
    stream_total_timeout: 600,
    retry_status_codes: [401, 429, 403],
    reset_session_status_codes: [403],
    retry_backoff_base: 0.5,
    retry_backoff_factor: 2,
    retry_backoff_max: 20,
    retry_budget: 60,
    image_generation_method: "legacy",
  },
  token: {
    auto_refresh: true,
    refresh_interval_hours: 8,
    super_refresh_interval_hours: 2,
    fail_threshold: 5,
    save_delay_ms: 500,
    usage_flush_interval_sec: 5,
    reload_interval_sec: 30,
  },
  cache: {
    enable_auto_clean: true,
    limit_mb: 1024,
    keep_base64_cache: true,
  },
  image: {
    timeout: 60,
    stream_timeout: 60,
    final_timeout: 15,
    blocked_grace_seconds: 10,
    nsfw: true,
    medium_min_bytes: 30_000,
    final_min_bytes: 100_000,
    blocked_parallel_attempts: 5,
    blocked_parallel_enabled: true,
  },
  video: {
    concurrent: 100,
    timeout: 60,
    stream_timeout: 60,
    upscale_timing: "complete",
  },
  performance: {
    assets_max_concurrent: 25,
    media_max_concurrent: 50,
    usage_max_concurrent: 25,
    assets_delete_batch_size: 10,
    admin_assets_batch_size: 10,
  },
  register: {
    worker_domain: "",
    email_domain: "",
    admin_password: "",
    yescaptcha_key: "",
    solver_url: "http://127.0.0.1:5072",
    solver_browser_type: "camoufox",
    solver_threads: 5,
    register_threads: 10,
    default_count: 100,
    auto_start_solver: true,
    solver_debug: false,
    max_errors: 0,
    max_runtime_minutes: 0,
  },
};

const IMAGE_METHOD_LEGACY = "legacy";
const IMAGE_METHOD_IMAGINE_WS_EXPERIMENTAL = "imagine_ws_experimental";
const IMAGE_METHOD_ALIASES: Record<string, string> = {
  imagine_ws: IMAGE_METHOD_IMAGINE_WS_EXPERIMENTAL,
  experimental: IMAGE_METHOD_IMAGINE_WS_EXPERIMENTAL,
  new: IMAGE_METHOD_IMAGINE_WS_EXPERIMENTAL,
  new_method: IMAGE_METHOD_IMAGINE_WS_EXPERIMENTAL,
};

function safeParseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function stripCfPrefix(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("cf_clearance=") ? trimmed.slice("cf_clearance=".length) : trimmed;
}

export function normalizeCfCookie(value: string): string {
  const cleaned = stripCfPrefix(value);
  return cleaned ? `cf_clearance=${cleaned}` : "";
}

export function normalizeImageGenerationMethod(value: unknown): string {
  const candidate = String(value ?? "")
    .trim()
    .toLowerCase();
  if (candidate === IMAGE_METHOD_IMAGINE_WS_EXPERIMENTAL) {
    return IMAGE_METHOD_IMAGINE_WS_EXPERIMENTAL;
  }
  if (IMAGE_METHOD_ALIASES[candidate]) {
    return IMAGE_METHOD_ALIASES[candidate];
  }
  return IMAGE_METHOD_LEGACY;
}

export async function getSettings(env: Env): Promise<SettingsBundle> {
  const globalRow = await dbFirst<{ value: string }>(
    env.DB,
    "SELECT value FROM settings WHERE key = ?",
    ["global"],
  );
  const grokRow = await dbFirst<{ value: string }>(
    env.DB,
    "SELECT value FROM settings WHERE key = ?",
    ["grok"],
  );
  const tokenRow = await dbFirst<{ value: string }>(
    env.DB,
    "SELECT value FROM settings WHERE key = ?",
    ["token"],
  );
  const cacheRow = await dbFirst<{ value: string }>(
    env.DB,
    "SELECT value FROM settings WHERE key = ?",
    ["cache"],
  );
  const imageRow = await dbFirst<{ value: string }>(
    env.DB,
    "SELECT value FROM settings WHERE key = ?",
    ["image"],
  );
  const videoRow = await dbFirst<{ value: string }>(
    env.DB,
    "SELECT value FROM settings WHERE key = ?",
    ["video"],
  );
  const performanceRow = await dbFirst<{ value: string }>(
    env.DB,
    "SELECT value FROM settings WHERE key = ?",
    ["performance"],
  );
  const registerRow = await dbFirst<{ value: string }>(
    env.DB,
    "SELECT value FROM settings WHERE key = ?",
    ["register"],
  );

  const globalCfg = globalRow?.value
    ? safeParseJson<GlobalSettings>(globalRow.value, DEFAULTS.global)
    : DEFAULTS.global;
  const grokCfg = grokRow?.value
    ? safeParseJson<GrokSettings>(grokRow.value, DEFAULTS.grok)
    : DEFAULTS.grok;
  const tokenCfg = tokenRow?.value
    ? safeParseJson<TokenSettings>(tokenRow.value, DEFAULTS.token)
    : DEFAULTS.token;
  const cacheCfg = cacheRow?.value
    ? safeParseJson<CacheSettings>(cacheRow.value, DEFAULTS.cache)
    : DEFAULTS.cache;
  const imageCfg = imageRow?.value
    ? safeParseJson<ImageSettings>(imageRow.value, DEFAULTS.image)
    : DEFAULTS.image;
  const videoCfg = videoRow?.value
    ? safeParseJson<VideoSettings>(videoRow.value, DEFAULTS.video)
    : DEFAULTS.video;
  const performanceCfg = performanceRow?.value
    ? safeParseJson<PerformanceSettings>(performanceRow.value, DEFAULTS.performance)
    : DEFAULTS.performance;
  const registerCfg = registerRow?.value
    ? safeParseJson<RegisterSettings>(registerRow.value, DEFAULTS.register)
    : DEFAULTS.register;

  const mergedGrok = {
    ...DEFAULTS.grok,
    ...grokCfg,
    cf_clearance: stripCfPrefix(grokCfg.cf_clearance ?? ""),
  };
  mergedGrok.image_generation_method = normalizeImageGenerationMethod(
    mergedGrok.image_generation_method,
  );

  return {
    global: { ...DEFAULTS.global, ...globalCfg },
    grok: mergedGrok,
    token: { ...DEFAULTS.token, ...tokenCfg },
    cache: { ...DEFAULTS.cache, ...cacheCfg },
    image: { ...DEFAULTS.image, ...imageCfg },
    video: { ...DEFAULTS.video, ...videoCfg },
    performance: { ...DEFAULTS.performance, ...performanceCfg },
    register: { ...DEFAULTS.register, ...registerCfg },
  };
}

export async function saveSettings(
  env: Env,
  updates: {
    global_config?: GlobalSettings;
    grok_config?: GrokSettings;
    token_config?: TokenSettings;
    cache_config?: CacheSettings;
    image_config?: ImageSettings;
    video_config?: VideoSettings;
    performance_config?: PerformanceSettings;
    register_config?: RegisterSettings;
  },
): Promise<void> {
  const now = nowMs();
  const current = await getSettings(env);

  const nextGlobal: GlobalSettings = { ...current.global, ...(updates.global_config ?? {}) };
  const nextGrok: GrokSettings = {
    ...current.grok,
    ...(updates.grok_config ?? {}),
    cf_clearance: stripCfPrefix(updates.grok_config?.cf_clearance ?? current.grok.cf_clearance ?? ""),
  };
  nextGrok.image_generation_method = normalizeImageGenerationMethod(nextGrok.image_generation_method);
  const nextToken: TokenSettings = { ...current.token, ...(updates.token_config ?? {}) };
  const nextCache: CacheSettings = { ...current.cache, ...(updates.cache_config ?? {}) };
  const nextImage: ImageSettings = { ...current.image, ...(updates.image_config ?? {}) };
  const nextVideo: VideoSettings = { ...current.video, ...(updates.video_config ?? {}) };
  const nextPerformance: PerformanceSettings = { ...current.performance, ...(updates.performance_config ?? {}) };
  const nextRegister: RegisterSettings = { ...current.register, ...(updates.register_config ?? {}) };

  await dbRun(
    env.DB,
    "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    ["global", JSON.stringify(nextGlobal), now],
  );
  await dbRun(
    env.DB,
    "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    ["grok", JSON.stringify(nextGrok), now],
  );
  await dbRun(
    env.DB,
    "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    ["token", JSON.stringify(nextToken), now],
  );
  await dbRun(
    env.DB,
    "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    ["cache", JSON.stringify(nextCache), now],
  );
  await dbRun(
    env.DB,
    "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    ["image", JSON.stringify(nextImage), now],
  );
  await dbRun(
    env.DB,
    "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    ["video", JSON.stringify(nextVideo), now],
  );
  await dbRun(
    env.DB,
    "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    ["performance", JSON.stringify(nextPerformance), now],
  );
  await dbRun(
    env.DB,
    "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    ["register", JSON.stringify(nextRegister), now],
  );
}

