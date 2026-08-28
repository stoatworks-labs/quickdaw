import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/**
 * The two headers that grant `SharedArrayBuffer`.
 *
 * Every buffer in this app is shared between the audio thread, a Worker and the
 * page, so without cross-origin isolation QuickDaw does not run at all — it
 * says so and stops. `public/_headers` sets the same pair on the deployed site;
 * these are for `npm run dev` and `npm run preview`, which do not read that
 * file, and without them the app is unusable in development while working
 * perfectly in production, which is the worst way round.
 *
 * `require-corp` blocks cross-origin subresources. Nothing here loads any: the
 * fonts are system fonts, the icons are local, and the only external reference
 * in the page is an `og:image` URL that is metadata rather than a fetch.
 */
const isolation: Plugin = {
  name: 'quickdaw-cross-origin-isolation',
  configureServer(server) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      next();
    });
  },
  configurePreviewServer(server) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      next();
    });
  },
};

/**
 * Stamp the version this build produced onto the support-footer script tag.
 *
 * The tag stays in index.html — it is the same document in dev — but the
 * version cannot be written beside it: a literal goes stale the moment a
 * release is tagged, and a feedback report naming the wrong build is worse than
 * one naming no build at all.
 */
function supportFooterVersion(): Plugin {
  const tag = /<script\s[^>]*\bsrc="[^"]*support-footer\.js"/;
  return {
    name: 'stoatworks-support-footer-version',
    transformIndexHtml: {
      order: 'post',
      handler(html: string) {
        // Loud on purpose. The tag is hand-written markup, so a rename or a
        // tidy-up could silently detach the version from every report filed
        // afterwards, and nothing downstream would look wrong.
        if (!tag.test(html)) {
          throw new Error('no support-footer.js tag in index.html — nothing to stamp');
        }
        return html.replace(tag, (m) => `${m} data-version="v${pkg.version}"`);
      },
    },
  };
}

// Static SPA. Output goes to dist/, which is what the Cloudflare Worker
// publishes. The two AudioWorklet processors are NOT bundled — they live in
// public/ and are loaded by URL at runtime.
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(`v${pkg.version}`) },
  plugins: [react(), isolation, supportFooterVersion()],
  // Absolute, unlike the rest of the fleet's tools: the service worker is
  // registered at '/sw.js' and the workers are resolved against the module URL,
  // so this app is only ever served from an origin root.
  base: '/',
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
