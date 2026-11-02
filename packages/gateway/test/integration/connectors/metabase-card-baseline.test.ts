// Throwaway baseline for nimbus-agent/Nimbus#975. Do not commit this as part of the fix.
// It records what main does today, so every assertion passes BEFORE the fix. After the fix,
// the first three tests should fail and the id test should still pass: that is the
// before/after evidence.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import pino from "pino";
import { createMetabaseSyncable } from "../../../src/connectors/metabase-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../../../src/sync/sync-capabilities.ts";
import { createMockVault } from "../../../src/vault/mock.ts";

const DASHBOARD_7 = {
  id: 7,
  name: "Revenue dashboard",
  description: "Monthly revenue",
  collection_id: 3,
  creator_id: 1,
  archived: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-02-01T00:00:00Z",
  dashcards: [{ id: 1 }],
};

// Same numeric id as DASHBOARD_7 on purpose: Metabase numbers the two separately.
const CARD_7 = {
  id: 7,
  name: "Revenue by month",
  description: "Which months brought in the most revenue?",
  collection_id: 3,
  creator_id: 1,
  archived: false,
  query_type: "native",
  dataset_query: { type: "native", native: { query: "SELECT month, SUM(total) FROM orders" } },
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-02-01T00:00:00Z",
};

type Item = { id: string; type: string; external_id: string; title: string };

async function runSync(cardsStatus = 200) {
  const paths: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      paths.push(path);
      if (path === "/api/collection") return Response.json([{ id: 3, name: "Finance" }]);
      if (path === "/api/dashboard") return Response.json([DASHBOARD_7]);
      if (path === "/api/card") {
        return cardsStatus === 200
          ? Response.json([CARD_7])
          : new Response("error", { status: cardsStatus });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  await vault.set("metabase.url", `http://${server.hostname}:${server.port}`);
  await vault.set("metabase.api_key", "baseline-key");
  const ctx = {
    ...buildSyncCapabilities({ vault, db, depth: "full" }, "metabase"),
    logger: pino({ level: "silent" }),
    rateLimiter: new ProviderRateLimiter({
      metabase: { requestsPerMinute: 600_000, burstSize: 10_000 },
    }),
  };
  const result = await createMetabaseSyncable({
    ensureMetabaseMcpRunning: async () => {},
  }).sync(ctx, null);
  const items = db
    .query<Item, []>(
      "SELECT id, type, external_id, title FROM item WHERE service = 'metabase' ORDER BY id",
    )
    .all();
  cleanup = () => {
    server.stop(true);
    db.close();
  };
  return { paths, result, items };
}

let cleanup: (() => void) | undefined;

describe("Nimbus #975 baseline: main indexes dashboards but not cards", () => {
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  test("the sync never requests /api/card, even though the fake server offers a card", async () => {
    const { paths } = await runSync();
    console.log("[baseline] requested paths:", JSON.stringify(paths));
    expect(paths).toEqual(["/api/collection", "/api/dashboard"]);
  });

  test("the dashboard is indexed and no metabase:card item exists", async () => {
    const { result, items } = await runSync();
    console.log("[baseline] itemsUpserted:", result.itemsUpserted);
    console.log("[baseline] items:", JSON.stringify(items));
    expect(result.itemsUpserted).toBe(1);
    expect(items).toEqual([
      { id: "metabase:7", type: "dashboard", external_id: "7", title: "Revenue dashboard" },
    ]);
    expect(items.filter((item) => item.type === "card")).toHaveLength(0);
  });

  test("a failing /api/card cannot affect anything today, because it is never called", async () => {
    const { paths, items } = await runSync(500);
    expect(paths).not.toContain("/api/card");
    expect(items.map((item) => item.id)).toEqual(["metabase:7"]);
  });

  test("why card/<id>: externalId 7 overwrites dashboard 7, card/7 does not", () => {
    const db = new Database(":memory:");
    cleanup = () => db.close();
    LocalIndex.ensureSchema(db);
    const ctx = buildSyncCapabilities({ vault: createMockVault(), db, depth: "full" }, "metabase");
    const row = (type: string, externalId: string, title: string) => ({
      service: "metabase",
      type,
      externalId,
      title,
      bodyPreview: title,
      url: "http://mb.test/x",
      canonicalUrl: "http://mb.test/x",
      modifiedAt: 1,
      metadata: {},
      syncedAt: 1,
    });
    const read = () =>
      db
        .query<Item, []>(
          "SELECT id, type, external_id, title FROM item WHERE service = 'metabase' ORDER BY id",
        )
        .all();

    ctx.upsertItem(row("dashboard", "7", "Revenue dashboard"));
    ctx.upsertItem(row("card", "7", "Revenue by month"));
    const bareId = read();
    console.log("[baseline] bare id 7:", JSON.stringify(bareId));
    expect(bareId).toEqual([
      { id: "metabase:7", type: "card", external_id: "7", title: "Revenue by month" },
    ]);

    ctx.upsertItem(row("dashboard", "7", "Revenue dashboard"));
    ctx.upsertItem(row("card", "card/7", "Revenue by month"));
    const namespaced = read();
    console.log("[baseline] namespaced id:", JSON.stringify(namespaced));
    expect(namespaced.map((item) => item.id)).toEqual(["metabase:7", "metabase:card/7"]);
  });
});
