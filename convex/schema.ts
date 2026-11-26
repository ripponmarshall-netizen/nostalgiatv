import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const kind = v.union(
  v.literal("ads"),
  v.literal("shows"),
  v.literal("news"),
  v.literal("music"),
);

export const status = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected"),
  v.literal("flagged"), // auto-pulled after repeated embed failures
);

export default defineSchema({
  // One row per channel. `epoch` is the moment (ms) the channel's loop started.
  // Every viewer computes "what's on now" from epoch + clip durations,
  // so everyone sees the same clip at the same second without streaming anything.
  channels: defineTable({
    slug: kind,
    name: v.string(),
    number: v.number(),
    epoch: v.number(),
  }).index("by_slug", ["slug"]),

  clips: defineTable({
    youtubeId: v.string(),
    title: v.string(),
    channel: kind,
    decade: v.optional(v.string()),
    status,
    durationSec: v.optional(v.number()), // measured on approval
    order: v.number(), // position in the channel loop
    likes: v.number(),
    failCount: v.number(),
    submittedAt: v.number(),
  })
    .index("by_channel_status_order", ["channel", "status", "order"])
    .index("by_status", ["status"])
    .index("by_status_likes", ["status", "likes"])
    .index("by_youtubeId", ["youtubeId"]),
});
