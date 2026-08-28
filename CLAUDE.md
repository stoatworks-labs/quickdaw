# CLAUDE.md — QuickDaw

Command reference. For the model, the invariants and the traps, read
[AGENTS.md](AGENTS.md) first.

## Commands

```bash
npm install
npm run dev          # vite dev server — sends the COOP/COEP pair
npm test             # vitest — 80 tests
npm run test:watch
npm run build        # tsc -b && vite build -> dist/
npm run lint         # oxlint
npm run typecheck    # tsc -b
npm run preview      # serve the built dist/ — also sends COOP/COEP, but NOT
                     # the rest of _headers
```

## Deploy

```bash
cf-run npx wrangler deploy
```

Live at **https://quickdaw.stoatworks-labs.com**. `cf-run` supplies the
Cloudflare API token from the keychain. Never `wrangler login`. This is a Worker
with static assets (`[assets] directory`), not Pages, and the custom domain is
declared in `wrangler.toml` rather than set in the dashboard.

## Ground rules

- **`public/_headers` is load-bearing, not hardening.** It carries the
  `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` pair that makes
  the page cross-origin isolated. No isolation means no `SharedArrayBuffer`,
  and every buffer in the app is one — a deploy that loses that file comes up
  saying it cannot run. Check it first if that ever happens.
- **A gap in a take costs content, never time.** Lost frames are padded with
  silence and recorded in `take.json`. Do not "simplify" the writer into
  skipping them — see AGENTS.md §5, and `chain.test.ts`.
- **The pre-roll is the write buffer.** Pressing record moves a read position
  backwards; nothing is copied. Do not add a second buffer.
- The two AudioWorklet processors live in `public/` and are loaded by URL. They
  are not bundled, so they must be valid plain JS, and their layout constants
  arrive in `processorOptions` rather than being duplicated there.
- **The test signal is the fastest check that anything works.** Pick "Test signal" in
  the interface list — no hardware, no permission — and input 1 must read
  **-18.0**. If it does not, the metering or the gain staging is wrong, and
  nothing further is worth debugging until it does.
- **Verify a take by its length.** Every interesting failure mode shows up as a
  take that is the wrong length. A stopwatch beats reading the code.
- Public repo. "Commit" = commit **and** push.
