# Yaad TV

Old-time Jamaican TV channels where **everyone watches the same clip at the same second**.
Backend: Convex. Frontend: plain HTML on GitHub Pages, with no build step.

```
convex/schema.ts      tables: channels, clips
convex/tv.ts          all queries + mutations (public + admin)
convex/tsconfig.json  Convex's default TS config
docs/index.html       the telly (viewer page)
docs/admin.html       control room: preview, measure, approve
docs/config.js        your Convex URL goes here
.github/workflows/deploy-convex.yml   deploys convex/ on every push
```

## How the sync works (the Convex lesson)

Nothing is streamed. Each channel stores an **epoch** (the time its loop started), and each clip stores its **length**.
Every browser asks the server for the time (`serverTime`) and then works out
`(now − epoch) mod total length` → *which clip, how many seconds in*. Same inputs give the same answer on every phone.

- `schedule` is a **reactive query**. When you approve or pull a clip, Convex pushes the new loop to every open telly. You don't write any websocket code.
- When the loop changes, `withRebase` (in `tv.ts`) moves the epoch so the clip currently on air carries on at the same second. Nobody jumps.
- If a YouTube embed fails, that viewer shows static for the rest of the slot (staying in sync) and reports it. After 3 reports the clip is pulled to **Flagged** for you to review.
- Mutations are transactions: the read-modify-write in `like` and `approve` can't race.

## Setup (all from iPhone)

1. **Convex:** sign in at dashboard.convex.dev → create a project.
   - Production deployment → **Settings → URL & Deploy Key**: copy the **Deployment URL** and generate a **Production deploy key**.
   - Settings → **Environment Variables**: add `ADMIN_TOKEN` = a long random string (your admin password).
2. **GitHub:** create a repo and add these files (keep the folder paths).
   - Repo → Settings → Secrets and variables → **Actions** → new secret `CONVEX_DEPLOY_KEY` = the deploy key.
   - Actions tab → "Deploy Convex backend" → **Run workflow**. Wait for a green tick. If it fails, the log says why.
3. **Frontend:** edit `docs/config.js` and paste your Deployment URL. Put your email in the takedown link in `docs/index.html`.
   - Settings → **Pages** → Deploy from a branch → `main` / `/docs`.
4. Open `…github.io/<repo>/admin.html` → enter `ADMIN_TOKEN` → **Create channels**.
5. Submit clips on the main page → in admin, **Preview** each one (this measures its length and proves it embeds) → **Approve**.

## Known limits (scrappy on purpose)

- Likes and fail reports are only de-duplicated per browser, so someone determined could spam them. Next step: the Convex rate-limiter component.
- iPhone needs one tap ("Turn on the TV") before sound plays. Test on iOS Safari after each change.
- Fan uploads vanish. Static plus flagging handles that, but keep seeding new clips.
- The script tag pins `convex@1.51.0`. Bump it occasionally.

## Next things to learn with it

- **Presence:** "23 people watching CH 02", using a heartbeat mutation plus a scheduled cleanup (Convex cron).
- **Trim points:** start/end seconds per clip, so you can use just one ad from a 20-minute compilation.
- **Live chat per channel:** a reactive query over a `messages` table.
