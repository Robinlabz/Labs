# Robin Labs — Docs (GitBook + Mintlify ready)

One markdown source of truth → two publish-ready docs sites. Write once in
`src/`, run the generator, connect whichever platform you like. This is how the
big launchpads get that polished docs site — they don't build it, they use a
docs platform and just write the pages.

```
docs/
├── src/            ← the ONLY place you edit content (8 markdown pages)
├── manifest.json   ← titles, descriptions, sidebar order/grouping
├── build.mjs       ← generates both outputs
├── gitbook/        ← generated — connect to GitBook
└── mintlify/       ← generated — connect to Mintlify
```

Regenerate after any edit:

```bash
node docs/build.mjs
```

## Publish with GitBook (what nad.fun uses)

1. Create a space at [gitbook.com](https://gitbook.com) (free tier is fine).
2. **Sync with Git** → point it at this repo, subdirectory `docs/gitbook`.
   GitBook reads `SUMMARY.md` for the sidebar and `README.md` as the landing.
3. In the space settings, set a **custom domain** → `docs.robinlabs.io`
   (add the CNAME GitBook shows you at your registrar).

Done — same look as the big pads, hosted for you, with search built in.

## Publish with Mintlify

1. Create a project at [mintlify.com](https://mintlify.com) and connect this
   repo, subdirectory `docs/mintlify`.
2. Mintlify reads `mint.json` for navigation/theme and renders the `.mdx` pages.
   Brand colors and the "Launch a coin" CTA are already set.
3. Add your **custom domain** → `docs.robinlabs.io` in the dashboard.

No "powered by" on Mintlify's free plan — it reads a notch more premium.

## Which one?

Both give you the recognizable big-pad docs look on a `docs.` subdomain with
zero hosting to run. GitBook is the most familiar; Mintlify looks slightly more
custom. Pick one, connect it, point the subdomain — the content is identical
either way because it comes from the same `src/`.
