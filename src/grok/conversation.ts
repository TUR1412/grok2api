import type { GlobalSettings, GrokSettings } from "../settings";
import { getDynamicHeaders } from "./headers";
import { getModelInfo, toGrokModel } from "./models";
import { buildToolPrompt, formatToolHistory } from "./toolCall";

type OpenAIContentItem = {
  type?: string;
  text?: string;
  content?: string;
  image_url?: { url?: string; detail?: string } | string;
  input_image?: { image_url?: string; url?: string };
  image?: string;
  url?: string;
};

export interface OpenAIChatMessage {
  role: string;
  content: string | OpenAIContentItem[] | Record<string, any> | null;
  tool_calls?: Array<Record<string, any>>;
  tool_call_id?: string;
  name?: string;
}

export interface OpenAIChatRequestBody {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  video_config?: {
    aspect_ratio?: string;
    video_length?: number;
    resolution?: string;
    preset?: string;
  };
}

export const CONVERSATION_API = "https://grok.com/rest/app-chat/conversations/new";

function extractTextFromItem(item: OpenAIContentItem): string {
  if (!item || typeof item !== "object") return "";
  if (typeof item.text === "string" && item.text.trim()) return item.text;
  if (typeof item.content === "string" && item.content.trim()) return item.content;
  return "";
}

function extractImageUrlFromItem(item: OpenAIContentItem): string | null {
  if (!item || typeof item !== "object") return null;

  if (item.type === "image_url") {
    if (typeof item.image_url === "string" && item.image_url.trim()) {
      return item.image_url.trim();
    }
    if (item.image_url && typeof item.image_url === "object" && typeof item.image_url.url === "string") {
      return item.image_url.url.trim();
    }
  }

  if (item.type === "input_image" && item.input_image && typeof item.input_image === "object") {
    const url = item.input_image.image_url ?? item.input_image.url;
    if (typeof url === "string" && url.trim()) return url.trim();
  }

  if ((item.type === "image" || item.type === "input_image") && typeof item.url === "string" && item.url.trim()) {
    return item.url.trim();
  }

  if (typeof item.image === "string" && item.image.trim()) {
    return item.image.trim();
  }

  return null;
}

export function extractContent(messages: OpenAIChatMessage[]): { content: string; images: string[] } {
  const images: string[] = [];
  const extracted: Array<{ role: string; text: string }> = [];
  const normalizedMessages = formatToolHistory(messages as Array<Record<string, any>>);

  for (const msg of normalizedMessages) {
    const role = typeof msg.role === "string" && msg.role.trim() ? msg.role : "user";
    const content = msg.content ?? "";
    const parts: string[] = [];

    if (Array.isArray(content)) {
      for (const item of content as OpenAIContentItem[]) {
        const text = extractTextFromItem(item);
        if (text.trim()) parts.push(text);

        const imageUrl = extractImageUrlFromItem(item);
        if (imageUrl) images.push(imageUrl);
      }
    } else if (content && typeof content === "object") {
      const item = content as OpenAIContentItem;
      const text = extractTextFromItem(item);
      if (text.trim()) parts.push(text);
      const imageUrl = extractImageUrlFromItem(item);
      if (imageUrl) images.push(imageUrl);
    } else {
      const text = String(content ?? "");
      if (text.trim()) parts.push(text);
    }

    if (parts.length) {
      extracted.push({ role, text: parts.join("\n") });
    }
  }

  let lastUserIndex: number | null = null;
  for (let index = extracted.length - 1; index >= 0; index -= 1) {
    if (extracted[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }

  const out: string[] = [];
  for (let index = 0; index < extracted.length; index += 1) {
    const item = extracted[index]!;
    if (index === lastUserIndex) out.push(item.text);
    else out.push(`${item.role}: ${item.text}`);
  }

  return { content: out.join("\n\n"), images };
}

export function buildConversationPayload(args: {
  requestModel: string;
  content: string;
  imgIds: string[];
  imgUris: string[];
  postId?: string;
  videoConfig?: {
    aspect_ratio?: string;
    video_length?: number;
    resolution?: string;
    preset?: string;
  } | undefined;
  temperature?: number | undefined;
  topP?: number | undefined;
  reasoningEffort?: string | null | undefined;
  tools?: Array<Record<string, any>> | null | undefined;
  toolChoice?: unknown;
  parallelToolCalls?: boolean | undefined;
  settings: GrokSettings;
  globalSettings?: Pick<GlobalSettings, "disable_memory" | "custom_instruction"> | undefined;
}): { payload: Record<string, unknown>; referer?: string; isVideoModel: boolean } {
  const {
    requestModel,
    content,
    imgIds,
    postId,
    settings,
    globalSettings,
    tools,
    toolChoice,
    parallelToolCalls,
  } = args;
  const cfg = getModelInfo(requestModel);
  const { grokModel, mode, isVideoModel } = toGrokModel(requestModel);

  const modelConfigOverride: Record<string, unknown> = {};
  if (typeof args.temperature === "number" && Number.isFinite(args.temperature)) {
    modelConfigOverride.temperature = args.temperature;
  }
  if (typeof args.topP === "number" && Number.isFinite(args.topP)) {
    modelConfigOverride.topP = args.topP;
  }
  if (typeof args.reasoningEffort === "string" && args.reasoningEffort.trim()) {
    modelConfigOverride.reasoningEffort = args.reasoningEffort.trim();
  }

  if (cfg?.is_video_model) {
    if (!postId) throw new Error("视频模型缺少 postId（需要先创建 media post）");

    const aspectRatio = (args.videoConfig?.aspect_ratio ?? "").trim() || "3:2";
    const videoLengthRaw = Number(args.videoConfig?.video_length ?? 6);
    const videoLength = Number.isFinite(videoLengthRaw)
      ? Math.max(1, Math.floor(videoLengthRaw))
      : 6;
    const resolution = (args.videoConfig?.resolution ?? "SD") === "HD" ? "HD" : "SD";
    const preset = (args.videoConfig?.preset ?? "normal").trim();

    let modeFlag = "--mode=custom";
    if (preset === "fun") modeFlag = "--mode=extremely-crazy";
    else if (preset === "normal") modeFlag = "--mode=normal";
    else if (preset === "spicy") modeFlag = "--mode=extremely-spicy-or-crazy";

    const prompt = `${String(content || "").trim()} ${modeFlag}`.trim();
    const payload: Record<string, unknown> = {
      temporary: true,
      modelName: "grok-3",
      message: prompt,
      toolOverrides: { videoGen: true },
      enableSideBySide: true,
      responseMetadata: {
        experiments: [],
        modelConfigOverride: {
          modelMap: {
            videoGenModelConfig: {
              parentPostId: postId,
              aspectRatio,
              videoLength,
              videoResolution: resolution,
            },
          },
        },
      },
    };

    if (Object.keys(modelConfigOverride).length) {
      (payload.responseMetadata as Record<string, unknown>).modelConfigOverride = {
        ...(payload.responseMetadata as Record<string, any>).modelConfigOverride,
        ...modelConfigOverride,
      };
    }

    return {
      isVideoModel: true,
      referer: "https://grok.com/imagine",
      payload,
    };
  }

  const toolPrompt = buildToolPrompt(
    Array.isArray(tools) ? tools : [],
    toolChoice,
    parallelToolCalls !== false,
  );
  const finalMessage = toolPrompt ? `${toolPrompt}\n\n${content}` : content;

  const payload: Record<string, unknown> = {
    temporary: settings.temporary ?? true,
    modelName: grokModel,
    message: finalMessage,
    fileAttachments: imgIds,
    imageAttachments: [],
    disableSearch: false,
    enableImageGeneration: true,
    returnImageBytes: false,
    returnRawGrokInXaiRequest: false,
    enableImageStreaming: true,
    imageGenerationCount: 2,
    forceConcise: false,
    toolOverrides: {},
    enableSideBySide: true,
    sendFinalMetadata: true,
    isReasoning: false,
    webpageUrls: [],
    disableTextFollowUps: true,
    responseMetadata: { requestModelDetails: { modelId: grokModel } },
    disableMemory: globalSettings?.disable_memory ?? false,
    forceSideBySide: false,
    modelMode: mode,
    isAsyncChat: false,
  };

  const customInstruction = String(globalSettings?.custom_instruction ?? "").trim();
  if (customInstruction) {
    payload.customPersonality = customInstruction;
  }

  if (Object.keys(modelConfigOverride).length) {
    (payload.responseMetadata as Record<string, unknown>).modelConfigOverride = modelConfigOverride;
  }

  return {
    isVideoModel,
    payload,
  };
}

export async function sendConversationRequest(args: {
  payload: Record<string, unknown>;
  cookie: string;
  settings: GrokSettings;
  referer?: string;
}): Promise<Response> {
  const { payload, cookie, settings, referer } = args;
  const headers = getDynamicHeaders(settings, "/rest/app-chat/conversations/new");
  headers.Cookie = cookie;
  if (referer) headers.Referer = referer;
  const body = JSON.stringify(payload);

  return fetch(CONVERSATION_API, { method: "POST", headers, body });
}
