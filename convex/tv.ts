import { mutation, query, MutationCtx, QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { kind, status } from "./schema";

// Convex exposes env vars set in the dashboard on process.env.
declare const process: { env: Record<string, string | undefined> };

type Kind = Doc<"channels">["slug"];

const FAIL_LIMIT = 3; // reports before a clip is pulled from the loop

const DEFAULT_CHANNELS: { slug: Kind; name: string; number: number }[] = [
  { slug: "ads", name: "Yaad Ads & Jingles", number: 2 },
  { slug: "shows", name: "Shows & Comedy", number: 4 },
  { slug: "news", name: "News & Moments", number: 7 },
  { slug: "music", name: "Music & Videos", number: 11 },
];

// ---------- helpers ----------

function assertAdmin(token: string) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected || token !== expected) throw new ConvexError("Not authorised");
}

function parseYouTubeId(input: string): string | null {
  const s = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const m = s.match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/))([A-Za-z0-9_-]{11})/,
  );
  return m ? m[1] : null;
}

async function getChannel(ctx: QueryCtx, slug: Kind) {
  return await ctx.db
    .query("channels")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
}

// The playable loop: approved clips with a known duration, in order.
async function loadLoop(ctx: QueryCtx, slug: Kind) {
  const rows = await ctx.db
    .query("clips")
    .withIndex("by_channel_status_order", (q) =>
      q.eq("channel", slug).eq("status", "approved"),
    )
    .collect();
  return rows.filter((c) => (c.durationSec ?? 0) > 0);
}

// Where is the loop right now? Returns the clip index and seconds into it.
function locate(loop: Doc<"clips">[], epoch: number, now: number) {
  const total = loop.reduce((s, c) => s + c.durationSec!, 0);
  if (total <= 0) return null;
  let t = (((now - epoch) / 1000) % total + total) % total;
  for (let i = 0; i < loop.length; i++) {
    const d = loop[i].durationSec!;
    if (t < d) return { index: i, offset: t };
    t -= d;
  }
  return { index: 0, offset: 0 };
}

function startOf(loop: Doc<"clips">[], id: Id<"clips">) {
  let s = 0;
  for (const c of loop) {
    if (c._id === id) return s;
    s += c.durationSec!;
  }
  return null;
}

/**
 * Run a change to a channel's loop without making viewers jump.
 * Before: note which clip is playing and how far in.
 * After: move the channel's epoch so that same clip is still at the same second
 * (or, if it was removed, so the next surviving clip starts now).
 */
async function withRebase(
  ctx: MutationCtx,
  slug: Kind,
  change: () => Promise<void>,
) {
  const channel = await getChannel(ctx, slug);
  if (!channel) {
    await change();
    return;
  }
  const now = Date.now();
  const before = await loadLoop(ctx, slug);
  const pos = locate(before, channel.epoch, now);

  await change();

  const after = await loadLoop(ctx, slug);
  let p = 0;
  if (pos) {
    const current = before[pos.index];
    const start = startOf(after, current._id);
    if (start !== null) {
      p = start + pos.offset;
    } else {
      for (let i = pos.index + 1; i < before.length; i++) {
        const s = startOf(after, before[i]._id);
        if (s !== null) {
          p = s;
          break;
        }
      }
    }
  }
  await ctx.db.patch(channel._id, { epoch: now - p * 1000 });
}

// ---------- public ----------

/** Clock sync. A mutation (not a query) so it's never served from cache. */
export const serverTime = mutation({
  args: {},
  handler: async () => Date.now(),
});

export const channels = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("channels").collect();
    return rows
      .sort((a, b) => a.number - b.number)
      .map(({ slug, name, number }) => ({ slug, name, number }));
  },
});

/** Everything a viewer needs to compute "what's on now". Reactive: updates push to every viewer. */
export const schedule = query({
  args: { channel: kind },
  handler: async (ctx, { channel }) => {
    const ch = await getChannel(ctx, channel);
    if (!ch) return null;
    const loop = await loadLoop(ctx, channel);
    return {
      epoch: ch.epoch,
      clips: loop.map((c) => ({
        id: c._id,
        youtubeId: c.youtubeId,
        title: c.title,
        decade: c.decade ?? null,
        durationSec: c.durationSec!,
        likes: c.likes,
      })),
    };
  },
});

export const topClips = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("clips")
      .withIndex("by_status_likes", (q) => q.eq("status", "approved"))
      .order("desc")
      .take(10);
    return rows.map((c) => ({
      id: c._id,
      title: c.title,
      likes: c.likes,
      channel: c.channel,
      decade: c.decade ?? null,
    }));
  },
});

export const submit = mutation({
  args: {
    url: v.string(),
    title: v.string(),
    channel: kind,
    decade: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const youtubeId = parseYouTubeId(args.url);
    if (!youtubeId) throw new ConvexError("That doesn't look like a YouTube link.");
    const title = args.title.trim().slice(0, 120);
    if (title.length < 3) throw new ConvexError("Give it a short title.");
    const decade = args.decade?.trim().slice(0, 10) || undefined;

    const existing = await ctx.db
      .query("clips")
      .withIndex("by_youtubeId", (q) => q.eq("youtubeId", youtubeId))
      .first();
    if (existing) throw new ConvexError("Someone already sent that one in. Big up!");

    await ctx.db.insert("clips", {
      youtubeId,
      title,
      channel: args.channel,
      decade,
      status: "pending",
      order: 0,
      likes: 0,
      failCount: 0,
      submittedAt: Date.now(),
    });
    return "Thanks! It'll go on air once it's approved.";
  },
});

export const like = mutation({
  args: { clipId: v.id("clips") },
  handler: async (ctx, { clipId }) => {
    const clip = await ctx.db.get(clipId);
    if (!clip || clip.status !== "approved") return;
    await ctx.db.patch(clipId, { likes: clip.likes + 1 });
  },
});

/** Called by a viewer's player when YouTube refuses to play a clip. */
export const reportFail = mutation({
  args: { clipId: v.id("clips") },
  handler: async (ctx, { clipId }) => {
    const clip = await ctx.db.get(clipId);
    if (!clip || clip.status !== "approved") return;
    const failCount = clip.failCount + 1;
    if (failCount < FAIL_LIMIT) {
      await ctx.db.patch(clipId, { failCount });
      return;
    }
    await withRebase(ctx, clip.channel, async () => {
      await ctx.db.patch(clipId, { failCount, status: "flagged" });
    });
  },
});

// ---------- admin (token = ADMIN_TOKEN env var set in the Convex dashboard) ----------

export const adminCheck = query({
  args: { token: v.string() },
  handler: async (_ctx, { token }) => {
    assertAdmin(token);
    return true;
  },
});

export const seedChannels = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    assertAdmin(token);
    let created = 0;
    for (const c of DEFAULT_CHANNELS) {
      if (await getChannel(ctx, c.slug)) continue;
      await ctx.db.insert("channels", { ...c, epoch: Date.now() });
      created++;
    }
    return created;
  },
});

export const adminList = query({
  args: { token: v.string(), status },
  handler: async (ctx, { token, status }) => {
    assertAdmin(token);
    return await ctx.db
      .query("clips")
      .withIndex("by_status", (q) => q.eq("status", status))
      .order("desc")
      .take(50);
  },
});

export const approve = mutation({
  args: {
    token: v.string(),
    clipId: v.id("clips"),
    durationSec: v.number(),
    title: v.optional(v.string()),
    channel: v.optional(kind),
  },
  handler: async (ctx, args) => {
    assertAdmin(args.token);
    const clip = await ctx.db.get(args.clipId);
    if (!clip) throw new ConvexError("Clip not found");
    if (!(args.durationSec > 0)) throw new ConvexError("Play the preview first so I can measure its length.");
    const channel = args.channel ?? clip.channel;

    const last = await ctx.db
      .query("clips")
      .withIndex("by_channel_status_order", (q) =>
        q.eq("channel", channel).eq("status", "approved"),
      )
      .order("desc")
      .first();

    await withRebase(ctx, channel, async () => {
      await ctx.db.patch(args.clipId, {
        status: "approved",
        channel,
        title: args.title?.trim().slice(0, 120) || clip.title,
        durationSec: Math.floor(args.durationSec),
        order: (last?.order ?? 0) + 1,
        failCount: 0,
      });
    });
  },
});

/** Reject a pending clip, or pull an approved/flagged one off air. */
export const reject = mutation({
  args: { token: v.string(), clipId: v.id("clips") },
  handler: async (ctx, { token, clipId }) => {
    assertAdmin(token);
    const clip = await ctx.db.get(clipId);
    if (!clip) return;
    await withRebase(ctx, clip.channel, async () => {
      await ctx.db.patch(clipId, { status: "rejected" });
    });
  },
});

/** Put a flagged clip back on air (e.g. it was a false alarm). */
export const restore = mutation({
  args: { token: v.string(), clipId: v.id("clips") },
  handler: async (ctx, { token, clipId }) => {
    assertAdmin(token);
    const clip = await ctx.db.get(clipId);
    if (!clip || !clip.durationSec) return;
    await withRebase(ctx, clip.channel, async () => {
      await ctx.db.patch(clipId, { status: "approved", failCount: 0 });
    });
  },
});
