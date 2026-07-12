// Sonde de capacités : de quoi dispose RÉELLEMENT chaque moteur pour un pool
// de workers (OffscreenCanvas, worker imbriqué comme le fait pdf.js, worker
// module, convertToBlob JPEG) ? Décide si le moteur de filigrane peut quitter
// le fil principal, et sur quels navigateurs il faut garder la voie actuelle.
//
// Lancé par `bun run test:e2e` sur les trois moteurs de la CI ; le job WebKit
// est la seule mesure fiable du moteur de Safari/iOS (impossible localement).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { browserName, launchBrowser, MAP_UPSERT_POLYFILL } from "./helpers/browser";
import { E2E_ORIGIN, startServer, type E2eServer } from "./helpers/server";

const OUT_DIR = join(import.meta.dir, "..", "out");

let server: E2eServer;
let browser: Browser;

beforeAll(async () => {
  server = startServer(OUT_DIR);
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser?.close();
  server?.stop();
});

type Caps = {
  offscreenCanvasMain: boolean;
  cores: number | null;
  deviceMemory: number | null;
  worker: {
    offscreenCanvas?: boolean;
    jpegType?: string;
    jpegBytes?: number;
    nested?: unknown;
    nestedModule?: unknown;
    err?: string;
  };
};

describe("capacités worker du moteur", () => {
  test(
    "relève OffscreenCanvas, worker imbriqué, worker module, convertToBlob JPEG",
    async () => {
      const context = await browser.newContext({ serviceWorkers: "block" });
      await context.addInitScript(MAP_UPSERT_POLYFILL);
      const page = await context.newPage();
      await page.goto(`${E2E_ORIGIN}/fr`);

      const caps: Caps = await page.evaluate(async () => {
        // Worker externe (blob:) qui teste ce dont le pool aurait besoin.
        // Un worker imbriqué reproduit ce que fait pdf.js (il crée le sien).
        const src = `
          self.onmessage = async () => {
            const r = { offscreenCanvas: typeof OffscreenCanvas !== "undefined" };
            if (r.offscreenCanvas) {
              try {
                const c = new OffscreenCanvas(8, 8);
                const ctx = c.getContext("2d");
                ctx.fillStyle = "#f00"; ctx.fillRect(0, 0, 8, 8);
                const b = await c.convertToBlob({ type: "image/jpeg", quality: 0.8 });
                r.jpegType = b.type; r.jpegBytes = b.size;
              } catch (e) { r.jpegType = "throw: " + e.message; }
            }
            const innerSrc = URL.createObjectURL(
              new Blob(["self.postMessage('pong')"], { type: "text/javascript" }));
            const probe = (opts) => new Promise((res) => {
              try {
                const w = opts ? new Worker(innerSrc, opts) : new Worker(innerSrc);
                const t = setTimeout(() => res("timeout"), 8000);
                w.onmessage = (e) => { clearTimeout(t); res(e.data); w.terminate(); };
                w.onerror = (e) => { clearTimeout(t); res("error: " + (e.message || "?")); };
              } catch (e) { res("throw: " + e.message); }
            });
            r.nested = await probe(null);
            r.nestedModule = await probe({ type: "module" });
            self.postMessage(r);
          };
        `;
        const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
        const worker = await new Promise<Caps["worker"]>((resolve) => {
          let w: Worker;
          try {
            w = new Worker(url);
          } catch (e) {
            resolve({ err: "construction: " + (e as Error).message });
            return;
          }
          const t = setTimeout(() => resolve({ err: "timeout 20s" }), 20_000);
          w.onmessage = (e) => { clearTimeout(t); resolve(e.data); w.terminate(); };
          w.onerror = (e) => { clearTimeout(t); resolve({ err: "onerror: " + (e.message || "?") }); };
          w.postMessage(1);
        });
        return {
          offscreenCanvasMain: typeof OffscreenCanvas !== "undefined",
          cores: navigator.hardwareConcurrency ?? null,
          deviceMemory: (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? null,
          worker,
        };
      });

      // Relevé lisible dans les journaux de la CI, moteur par moteur.
      console.log(`\n[capacités ${browserName()}] ${JSON.stringify(caps, null, 2)}\n`);

      // La seule exigence dure aujourd'hui : le pipeline actuel (fil principal)
      // fonctionne partout. Le reste est un relevé, pas une régression.
      expect(caps.cores === null || caps.cores > 0).toBe(true);
    },
    60_000
  );
});
