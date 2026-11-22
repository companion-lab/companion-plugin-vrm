// Tests for the avatar reply contribution (../reply-shaping.ts): schema/prompt
// built from this plugin's own registries (built-ins + custom clips) and the
// apply routing through the avatar bus.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@companion-lab/plugin";
import {
  registerBuiltinEmotions,
  registerCustomEmotion,
  clearCustomEmotions,
  listEmotionNames,
} from "./engine/expression/registry";
import {
  registerBuiltin,
  registerCustom,
  clearCustomMotions,
  listMotionNames,
} from "./engine/idle/registry";
import {
  AVATAR_REPLY_TOOL,
  buildAvatarReplyPrompt,
  buildAvatarReplySchema,
  createAvatarReplyContribution,
  registerAvatarReplyShaping,
} from "./reply-shaping";

function mockCtx() {
  return {
    avatar: {
      setEmotion: vi.fn(),
      triggerMotion: vi.fn(),
    },
    reply: {
      register: vi.fn(),
    },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as PluginContext & {
    avatar: { setEmotion: ReturnType<typeof vi.fn>; triggerMotion: ReturnType<typeof vi.fn> };
    reply: { register: ReturnType<typeof vi.fn> };
  };
}

beforeEach(() => {
  clearCustomMotions();
  clearCustomEmotions();
  registerBuiltinEmotions();
  registerBuiltin("nod", {}, 1.1);
  registerBuiltin("shake", {}, 1.1);
  registerBuiltin("think", {}, 2.2);
});

afterEach(() => {
  clearCustomMotions();
  clearCustomEmotions();
});

describe("buildAvatarReplySchema", () => {
  it("enumerates built-in motions (none first) and emotions", () => {
    const schema = buildAvatarReplySchema() as {
      properties: { motion: { enum: string[] }; emotion: { enum: string[] } };
      required: string[];
    };
    expect(schema.properties.motion.enum).toEqual(["none", "nod", "shake", "think"]);
    expect(schema.properties.emotion.enum).toEqual(listEmotionNames());
    expect(schema.required).toEqual(["text", "emotion", "motion"]);
  });

  it("picks up custom clips after registration", () => {
    registerCustom({ name: "wave_hello", duration: 1.5, pose: {} });
    const schema = buildAvatarReplySchema() as {
      properties: { motion: { enum: string[] } };
    };
    expect(schema.properties.motion.enum).toContain("wave_hello");
  });
});

describe("buildAvatarReplyPrompt", () => {
  it("lists built-in motion descriptions and the inline-tag fallback", () => {
    const p = buildAvatarReplyPrompt();
    expect(p).toContain("companion avatar");
    expect(p).toContain("nod (head nod for yes agreement)");
    expect(p).toContain("<<motion:name>>");
    expect(p).toContain("<<emotion:name>>");
    expect(p).toContain("avatar_response");
  });

  it("uses a custom motion's own description", () => {
    registerCustom({
      name: "wave_hello",
      duration: 1.5,
      pose: {},
      description: "friendly wave hello",
    });
    expect(buildAvatarReplyPrompt()).toContain("wave_hello (friendly wave hello)");
  });

  it("humanizes customs without a description", () => {
    registerCustom({ name: "big_jump", duration: 1, pose: {} });
    expect(buildAvatarReplyPrompt()).toContain("big jump custom motion clip");
  });
});

describe("createAvatarReplyContribution", () => {
  it("carries the carrier tool name and schema", () => {
    const ctx = mockCtx();
    const c = createAvatarReplyContribution(ctx);
    expect(c.id).toBe("avatar-reply");
    expect(c.toolName).toBe(AVATAR_REPLY_TOOL);
    expect(c.schema).toEqual(buildAvatarReplySchema());
  });

  it("apply routes emotion/motion through the avatar bus", () => {
    const ctx = mockCtx();
    const c = createAvatarReplyContribution(ctx);
    c.apply({ text: "hi", emotion: "happy", motion: "nod" });
    expect(ctx.avatar.setEmotion).toHaveBeenCalledWith("happy");
    expect(ctx.avatar.triggerMotion).toHaveBeenCalledWith("nod");
  });

  it("apply stays still for none/empty values", () => {
    const ctx = mockCtx();
    const c = createAvatarReplyContribution(ctx);
    c.apply({ text: "hi", emotion: "neutral", motion: "none" });
    expect(ctx.avatar.setEmotion).toHaveBeenCalledWith("neutral");
    expect(ctx.avatar.triggerMotion).not.toHaveBeenCalled();
    c.apply({ text: "hi" });
    expect(ctx.avatar.triggerMotion).not.toHaveBeenCalled();
  });
});

describe("registerAvatarReplyShaping", () => {
  it("registers the contribution via ctx.reply", () => {
    const ctx = mockCtx();
    registerAvatarReplyShaping(ctx);
    expect(ctx.reply.register).toHaveBeenCalledTimes(1);
    const arg = (ctx.reply.register as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.toolName).toBe(AVATAR_REPLY_TOOL);
  });

  it("warns instead of throwing on a host without the surface", () => {
    const ctx = mockCtx();
    (ctx as unknown as { reply: undefined }).reply = undefined;
    expect(() => registerAvatarReplyShaping(ctx)).not.toThrow();
    expect(ctx.log.warn).not.toHaveBeenCalled();
  });

  it("warns when registration throws", () => {
    const ctx = mockCtx();
    (ctx.reply.register as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() => registerAvatarReplyShaping(ctx)).not.toThrow();
    expect(ctx.log.warn).toHaveBeenCalled();
  });
});
