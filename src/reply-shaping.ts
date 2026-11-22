// The avatar's reply contribution: what the chat loop's structured reply must
// carry (text + emotion + motion) and how the avatar reacts to it.
//
// Ported from the chat plugin's old net/avatar.ts after that knowledge moved
// here — the emotion/motion lists come straight from this plugin's own
// registries (engine/expression/registry.ts + engine/idle/registry.ts), so
// the chat side carries no avatar knowledge at all. `apply` routes through
// the avatar bus (ctx.avatar), so whichever engine plugin currently owns the
// bus applies the fields and resolves names against its own registries.
//
// Registration lives in engine.ts (right after ctx.avatar.provide and on
// library reloads): the bus queues library registrations until the handlers
// install, so only the engine knows when the registries hold the complete
// sets the schema enums are built from.

import type { PluginContext, ReplyContribution } from "@companion-lab/plugin";
import { listEmotionNames } from "./engine/expression/registry";
import {
  BUILTIN_MOTION_DESCRIPTIONS,
  getMotion,
  isBuiltinMotionName,
  listMotionNames,
} from "./engine/idle/registry";

// Carrier tool name the providers force on the final turn.
export const AVATAR_REPLY_TOOL = "avatar_response";

// Best-effort motion description for the prompt: the entry's own
// description, then the built-in table, then the humanized fallback the
// chat plugin used for custom motions without one.
function motionDescription(name: string): string {
  if (name === "none") return BUILTIN_MOTION_DESCRIPTIONS.none;
  const d =
    getMotion(name)?.description?.trim() || BUILTIN_MOTION_DESCRIPTIONS[name];
  if (d) return d;
  const human = name.replace(/[_-]+/g, " ").trim() || name;
  return `${human} custom motion clip`;
}

function buildMotionDescription(): string {
  const all = listMotionNames();
  const customs = all.filter((m) => m !== "none" && !isBuiltinMotionName(m));
  const builtinEntries = all.filter((m) => m !== "none" && isBuiltinMotionName(m));
  const fmt = (m: string) => `${m} (${motionDescription(m)})`;
  const parts: string[] = [];
  if (customs.length) parts.push(`Custom: ${customs.map(fmt).join(", ")}`);
  if (builtinEntries.length)
    parts.push(`Built-in: ${builtinEntries.map(fmt).join(", ")}`);
  parts.push(`none (${motionDescription("none")})`);
  return `The physical motion to accompany the response. Available motions: ${parts.join(". ")}. Rules: default to "none" unless the user explicitly asks for a motion or the reply clearly matches a description. Prefer a matching custom motion over built-ins. Return the exact name.`;
}

// Single source of truth for what the avatar can do, injected as plain text
// into the chat system prompt so it reaches every provider — including the
// ones with no JSON schema (OpenAI).
function buildAvatarDirectives(): string {
  const lines: string[] = [buildMotionDescription()];
  lines.push(`Available expressions: ${listEmotionNames().join(", ")}.`);
  lines.push(
    'When the user explicitly requests a motion or an expression by name, you MUST honour it: pick that exact name in the motion or emotion field even if your reply text does not imply it. If a custom motion or expression name closely matches what they asked for, prefer the custom one over the built-ins. Never invent a name that is not in the lists above — if nothing matches, use "none" for motion and "neutral" for emotion, and describe in text what you cannot do instead of pretending.',
  );
  lines.push(
    "If you are answering as plain text instead of calling the avatar_response function, mark them inline instead: write <<motion:name>> and <<emotion:name>> somewhere in the reply. Those tags are stripped before the text is spoken, so never mention them to the user.",
  );
  return lines.join("\n");
}

export function buildAvatarReplySchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      text: { type: "string" },
      emotion: {
        type: "string",
        description: "The emotional expression to accompany the response",
        enum: listEmotionNames(),
      },
      motion: {
        type: "string",
        description: buildMotionDescription(),
        enum: listMotionNames(),
      },
    },
    required: ["text", "emotion", "motion"],
    additionalProperties: false,
  };
}

export function buildAvatarReplyPrompt(): string {
  return [
    "You are the user's companion avatar. Respond to the user with helpful text, and select the most appropriate emotion and physical motion to accompany your response.",
    buildAvatarDirectives(),
  ].join("\n");
}

export function createAvatarReplyContribution(
  ctx: PluginContext,
): ReplyContribution {
  return {
    id: "avatar-reply",
    prompt: buildAvatarReplyPrompt(),
    schema: buildAvatarReplySchema(),
    toolName: AVATAR_REPLY_TOOL,
    // Route through the avatar bus (engine-agnostic): the current engine
    // provider resolves the names against its own registries. Unknown names
    // and "none" stay still, matching the old chat-side behavior.
    apply: (reply) => {
      if (!reply || typeof reply !== "object") return;
      const emotion = typeof reply.emotion === "string" ? reply.emotion.trim() : "";
      if (emotion) ctx.avatar.setEmotion(emotion);
      const motion = typeof reply.motion === "string" ? reply.motion.trim() : "";
      if (motion && motion.toLowerCase() !== "none") ctx.avatar.triggerMotion(motion);
    },
  };
}

/** Register (or refresh) the avatar reply shape. Optional-chained so an
 *  older host without the ctx.reply surface simply skips shaping (the chat
 *  plugin then runs as plain prose). */
export function registerAvatarReplyShaping(ctx: PluginContext): void {
  try {
    ctx.reply?.register?.(createAvatarReplyContribution(ctx));
  } catch (e) {
    ctx.log.warn(
      `avatar reply shaping registration failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
