import { Hono } from "hono";
import type { Env } from "../env";
import { executeConversationRequest, openAiError, streamHeaders } from "./openai";
import { getSettings } from "../settings";
import { buildAuthCookie } from "../grok/headers";
import { generateImagineWs, resolveAspectRatio } from "../grok/imagineExperimental";
import { selectBestToken } from "../repo/tokens";

const FUNCTION_TASK_PREFIX = "function-task:";

type FunctionSession = {
  type: "imagine" | "video";
  prompt: string;
  aspect_ratio: string;
  nsfw?: boolean;
  image_url?: string | null;
  video_length?: number;
  resolution_name?: string;
  preset?: string;
  created_at: number;
};

async function getFunctionSettings(env: Env) {
  return getSettings(env);
}

async function getConfiguredFunctionKey(env: Env): Promise<string> {
  const settings = await getFunctionSettings(env);
  return String(settings.global.function_key ?? "").trim();
}

async function isFunctionAuthValid(args: {
  env: Env;
  bearer?: string | null;
  queryKey?: string | null;
}): Promise<boolean> {
  const configured = await getConfiguredFunctionKey(args.env);
  if (!configured) return true;
  const bearer = String(args.bearer ?? "").trim();
  const queryKey = String(args.queryKey ?? "").trim();
  return bearer === configured || queryKey === configured;
}

async function requireFunctionAuth(c: any, next: () => Promise<void>) {
  const authHeader = c.req.header("Authorization") ?? null;
  const matched = String(authHeader ?? "").match(/^Bearer\s+(.+)$/i);
  const bearer = matched?.[1]?.trim() || "";
  const queryKey = String(c.req.query("function_key") ?? "");
  const ok = await isFunctionAuthValid({
    env: c.env,
    bearer,
    queryKey,
  });
  if (!ok) {
    return c.json({ error: "密钥无效", code: "INVALID_FUNCTION_KEY" }, 401);
  }
  await next();
}

function functionContext(c: any): any {
  return {
    env: c.env,
    req: { raw: c.req.raw },
    executionCtx: c.executionCtx,
    get: () => ({ key: null, name: "Function", is_admin: true }),
  };
}

function taskStorageKey(taskId: string): string {
  return `${FUNCTION_TASK_PREFIX}${taskId}`;
}

async function saveFunctionTask(env: Env, taskId: string, session: FunctionSession): Promise<void> {
  await env.KV_CACHE.put(taskStorageKey(taskId), JSON.stringify(session), {
    expirationTtl: 60 * 30,
  });
}

async function loadFunctionTask(env: Env, taskId: string): Promise<FunctionSession | null> {
  const raw = await env.KV_CACHE.get(taskStorageKey(taskId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as FunctionSession;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function dropFunctionTasks(env: Env, taskIds: string[]): Promise<number> {
  const unique = [...new Set(taskIds.map((taskId) => String(taskId || "").trim()).filter(Boolean))];
  await Promise.all(unique.map((taskId) => env.KV_CACHE.delete(taskStorageKey(taskId))));
  return unique.length;
}

function imageEvent(event: string, data: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ type: event, ...data })}\n\n`;
}

export const functionRoutes = new Hono<{ Bindings: Env }>();

functionRoutes.get("/v1/function/verify", async (c) => {
  const authHeader = c.req.header("Authorization") ?? null;
  const matched = String(authHeader ?? "").match(/^Bearer\s+(.+)$/i);
  const bearer = matched?.[1]?.trim() || "";
  const queryKey = String(c.req.query("function_key") ?? "");
  const ok = await isFunctionAuthValid({
    env: c.env,
    bearer,
    queryKey,
  });
  if (!ok) return c.json({ error: "密钥无效", code: "INVALID_FUNCTION_KEY" }, 401);
  return c.json({ status: "success", verified: true });
});

functionRoutes.post("/v1/function/chat/completions", requireFunctionAuth, async (c) => {
  const body = await c.req.json();
  const ctx = functionContext(c);
  const outcome = await executeConversationRequest(ctx, {
    model: String(body.model ?? ""),
    messages: Array.isArray(body.messages) ? body.messages : [],
    stream: Boolean(body.stream),
    temperature: Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : undefined,
    topP: Number.isFinite(Number(body.top_p)) ? Number(body.top_p) : undefined,
    tools: Array.isArray(body.tools) ? body.tools : null,
    toolChoice: body.tool_choice,
    parallelToolCalls: body.parallel_tool_calls !== false,
    reasoningEffort: typeof body.reasoning_effort === "string" ? body.reasoning_effort : null,
    videoConfig: body.video_config,
  });
  if ("errorResponse" in outcome) return outcome.errorResponse;
  if ("stream" in outcome) return new Response(outcome.stream, { headers: streamHeaders() });
  return c.json(outcome.json);
});

functionRoutes.get("/v1/function/imagine/config", async (c) => {
  const settings = await getFunctionSettings(c.env);
  return c.json({
    final_min_bytes: Number(settings.image.final_min_bytes ?? 100000),
    medium_min_bytes: Number(settings.image.medium_min_bytes ?? 30000),
    nsfw: Boolean(settings.image.nsfw),
  });
});

functionRoutes.post("/v1/function/imagine/start", requireFunctionAuth, async (c) => {
  const body = await c.req.json();
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) return c.json({ detail: "Prompt cannot be empty" }, 400);
  const taskId = crypto.randomUUID().replaceAll("-", "");
  const aspectRatio = resolveAspectRatio(String(body.aspect_ratio ?? "2:3"));
  await saveFunctionTask(c.env, taskId, {
    type: "imagine",
    prompt,
    aspect_ratio: aspectRatio,
    nsfw: body.nsfw !== false,
    created_at: Date.now(),
  });
  return c.json({ task_id: taskId, aspect_ratio: aspectRatio });
});

functionRoutes.post("/v1/function/imagine/stop", requireFunctionAuth, async (c) => {
  const body = await c.req.json();
  const removed = await dropFunctionTasks(c.env, Array.isArray(body.task_ids) ? body.task_ids : []);
  return c.json({ status: "success", removed });
});

functionRoutes.get("/v1/function/imagine/sse", async (c) => {
  const taskId = String(c.req.query("task_id") ?? "").trim();
  const session = await loadFunctionTask(c.env, taskId);
  if (!session || session.type !== "imagine") {
    return c.text("Task not found", 404);
  }
  const ok = await isFunctionAuthValid({
    env: c.env,
    queryKey: c.req.query("function_key") ?? "",
  });
  if (!ok) return c.text("Unauthorized", 401);

  const settings = await getFunctionSettings(c.env);
  const token = await selectBestToken(c.env.DB, "grok-imagine-1.0", {
    preferTags: settings.image.nsfw ? ["nsfw"] : undefined,
    refreshCooling: true,
  });
  if (!token) return c.text("No available token", 503);
  const cookie = buildAuthCookie(token.token, settings.grok);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        const urls = await generateImagineWs({
          prompt: session.prompt,
          n: 6,
          cookie,
          settings: settings.grok,
          timeoutMs: Math.max(10000, Math.floor(Number(settings.image.stream_timeout ?? 60) * 1000)),
          aspectRatio: session.aspect_ratio,
        });
        let sequence = 0;
        for (const rawUrl of urls) {
          sequence += 1;
          controller.enqueue(
            encoder.encode(
              imageEvent("image_generation.completed", {
                image_id: `${taskId}-${sequence}`,
                url: rawUrl,
                sequence,
                elapsed_ms: 0,
                aspect_ratio: session.aspect_ratio,
                run_id: taskId,
                stage: "final",
              }),
            ),
          );
        }
        controller.close();
      } catch (error) {
        controller.enqueue(
          encoder.encode(
            imageEvent("error", {
              message: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

functionRoutes.get("/v1/function/imagine/ws", async (c) => {
  const upgrade = c.req.header("upgrade") ?? c.req.header("Upgrade");
  if (String(upgrade ?? "").toLowerCase() !== "websocket") {
    return c.text("Expected websocket upgrade", 426);
  }
  const ok = await isFunctionAuthValid({
    env: c.env,
    queryKey: c.req.query("function_key") ?? "",
  });
  const wsPair = new WebSocketPair();
  const client = wsPair[0];
  const server = wsPair[1];
  server.accept();

  if (!ok) {
    try {
      server.close(1008, "Auth failed");
    } catch {
      // ignore
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  const settings = await getFunctionSettings(c.env);
  let stopped = false;
  let currentTask = "";

  const send = (payload: Record<string, unknown>) => {
    if (stopped) return;
    try {
      server.send(JSON.stringify(payload));
    } catch {
      stopped = true;
    }
  };

  server.addEventListener("message", (event) => {
    const raw = typeof event.data === "string" ? event.data : "";
    let payload: Record<string, any> = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      payload = {};
    }
    const type = String(payload.type ?? "");
    if (type === "ping") {
      send({ type: "pong" });
      return;
    }
    if (type === "stop") {
      stopped = true;
      send({ type: "status", status: "stopped", run_id: currentTask });
      try {
        server.close(1000, "stopped");
      } catch {
        // ignore
      }
      return;
    }
    if (type !== "start") {
      send({ type: "error", message: "Unknown command" });
      return;
    }

    const prompt = String(payload.prompt ?? "").trim();
    if (!prompt) {
      send({ type: "error", message: "Prompt cannot be empty" });
      return;
    }
    const ratio = resolveAspectRatio(String(payload.aspect_ratio ?? "2:3"));
    const taskId = String(c.req.query("task_id") ?? "").trim() || crypto.randomUUID().replaceAll("-", "");
    currentTask = taskId;
    send({ type: "status", status: "running", prompt, aspect_ratio: ratio, run_id: taskId });

    void (async () => {
      const token = await selectBestToken(c.env.DB, "grok-imagine-1.0", {
        preferTags: settings.image.nsfw ? ["nsfw"] : undefined,
        refreshCooling: true,
      });
      if (!token) {
        send({ type: "error", message: "No available token" });
        return;
      }
      try {
        const cookie = buildAuthCookie(token.token, settings.grok);
        const urls = await generateImagineWs({
          prompt,
          n: 6,
          cookie,
          settings: settings.grok,
          timeoutMs: Math.max(10000, Math.floor(Number(settings.image.stream_timeout ?? 60) * 1000)),
          aspectRatio: ratio,
        });
        let sequence = 0;
        for (const rawUrl of urls) {
          if (stopped) break;
          sequence += 1;
          send({
            type: "image_generation.completed",
            image_id: `${taskId}-${sequence}`,
            url: rawUrl,
            sequence,
            elapsed_ms: 0,
            aspect_ratio: ratio,
            run_id: taskId,
            stage: "final",
          });
        }
        if (!stopped) send({ type: "status", status: "stopped", run_id: taskId });
      } catch (error) {
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    })();
  });

  server.addEventListener("close", () => {
    stopped = true;
  });
  server.addEventListener("error", () => {
    stopped = true;
  });

  return new Response(null, { status: 101, webSocket: client });
});

functionRoutes.post("/v1/function/video/start", requireFunctionAuth, async (c) => {
  const body = await c.req.json();
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) return c.json({ detail: "Prompt cannot be empty" }, 400);
  const taskId = crypto.randomUUID().replaceAll("-", "");
  await saveFunctionTask(c.env, taskId, {
    type: "video",
    prompt,
    aspect_ratio: resolveAspectRatio(String(body.aspect_ratio ?? "3:2")),
    image_url: body.image_url ? String(body.image_url) : null,
    video_length: Math.max(6, Math.min(30, Math.floor(Number(body.video_length ?? 6) || 6))),
    resolution_name: String(body.resolution_name ?? "480p"),
    preset: String(body.preset ?? "normal"),
    created_at: Date.now(),
  });
  return c.json({ task_id: taskId });
});

functionRoutes.get("/v1/function/video/sse", async (c) => {
  const taskId = String(c.req.query("task_id") ?? "").trim();
  const session = await loadFunctionTask(c.env, taskId);
  if (!session || session.type !== "video") return c.text("Task not found", 404);
  const ok = await isFunctionAuthValid({
    env: c.env,
    queryKey: c.req.query("function_key") ?? "",
  });
  if (!ok) return c.text("Unauthorized", 401);

  const messages: Array<Record<string, any>> = [{ role: "user", content: [{ type: "text", text: session.prompt }] }];
  if (session.image_url) {
    (messages[0]!.content as Array<Record<string, any>>).push({
      type: "image_url",
      image_url: { url: session.image_url },
    });
  }

  const outcome = await executeConversationRequest(functionContext(c), {
    model: "grok-imagine-1.0-video",
    messages,
    stream: true,
    videoConfig: {
      aspect_ratio: session.aspect_ratio,
      video_length: session.video_length ?? 6,
      resolution: session.resolution_name === "720p" || session.resolution_name === "HD" ? "HD" : "SD",
      preset: session.preset ?? "normal",
    },
  });
  if ("errorResponse" in outcome) return outcome.errorResponse;
  if ("json" in outcome) return c.json(outcome.json);
  return new Response(outcome.stream, { headers: streamHeaders() });
});

functionRoutes.post("/v1/function/video/stop", requireFunctionAuth, async (c) => {
  const body = await c.req.json();
  const removed = await dropFunctionTasks(c.env, Array.isArray(body.task_ids) ? body.task_ids : []);
  return c.json({ status: "success", removed });
});

functionRoutes.get("/v1/function/voice/token", requireFunctionAuth, async (c) => {
  return c.json({ error: "Voice is not supported on Cloudflare Workers", code: "voice_unsupported" }, 501);
});
