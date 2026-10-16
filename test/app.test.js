import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createD1 } from "./d1.js";

const BOOTSTRAP_SECRET = "test-only-bootstrap-secret-that-is-long-enough";
let db;
let env;
let cookie = "";

function call(path, init = {}) {
  return worker.fetch(new Request(`https://manager.test${path}`, init), env, {});
}

function post(path, body, headers = {}) {
  return call(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}

before(() => {
  db = createD1();
  env = {
    DB: db,
    BOOTSTRAP_SECRET,
    SESSION_TTL_SECONDS: "43200",
    LOGIN_WINDOW_SECONDS: "900",
    LOGIN_MAX_ATTEMPTS: "10",
    ASSETS: { fetch: async () => new Response("ui") },
  };
});

after(() => db.close());

beforeEach(async () => {
  await db.exec("DELETE FROM audit_log; DELETE FROM sessions; DELETE FROM admins; DELETE FROM settings;");
  cookie = "";
});

async function setup() {
  const response = await post("/api/v1/setup", { bootstrap_secret: BOOTSTRAP_SECRET, password: "a secure test password!" });
  const setCookie = response.headers.get("Set-Cookie");
  cookie = setCookie.split(";")[0];
  return response;
}

await test("Workers control plane", async (suite) => {
  await suite.test("health reports data plane unavailable", async () => {
    const response = await call("/api/v1/health");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok", control_plane: "available", lantern_data_plane: "unavailable" });
  });

  await suite.test("setup requires bootstrap secret, validates password, and is one-time", async () => {
    assert.equal((await post("/api/v1/setup", { bootstrap_secret: "wrong", password: "a secure test password!" })).status, 403);
    assert.equal((await post("/api/v1/setup", { bootstrap_secret: BOOTSTRAP_SECRET, password: "short" })).status, 400);
    assert.equal((await setup()).status, 201);
    assert.equal((await post("/api/v1/setup", { bootstrap_secret: BOOTSTRAP_SECRET, password: "another secure password!" })).status, 409);
  });

  await suite.test("validates content type, malformed body, size, and origin", async () => {
    assert.equal((await call("/api/v1/setup", { method: "POST", body: "{}" })).status, 400);
    assert.equal((await post("/api/v1/setup", { bootstrap_secret: BOOTSTRAP_SECRET, password: "a secure test password!" }, { Origin: "https://attacker.test" })).status, 403);
    assert.equal((await call("/api/v1/setup", { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "5000" }, body: "{}" })).status, 400);
  });

  await suite.test("login, protected admin routes, logout, session expiry boundaries", async () => {
    assert.equal((await call("/api/v1/admin/status")).status, 401);
    await setup();
    await post("/api/v1/auth/logout", {}, { Cookie: cookie });
    assert.equal((await call("/api/v1/admin/status", { headers: { Cookie: cookie } })).status, 401);
    assert.equal((await post("/api/v1/auth/login", { password: "bad password" })).status, 401);
    const login = await post("/api/v1/auth/login", { password: "a secure test password!" });
    assert.equal(login.status, 200);
    cookie = login.headers.get("Set-Cookie").split(";")[0];
    assert.equal((await call("/api/v1/admin/status", { headers: { Cookie: cookie } })).status, 200);
    const logout = await post("/api/v1/auth/logout", {}, { Cookie: cookie });
    assert.equal(logout.status, 200);
    cookie = logout.headers.get("Set-Cookie").split(";")[0];
    assert.equal((await call("/api/v1/auth/session", { headers: { Cookie: cookie } })).status, 401);
  });

  await suite.test("login attempts are throttled", async () => {
    await setup();
    for (let i = 0; i < 10; i += 1) assert.equal((await post("/api/v1/auth/login", { password: "not the password" }, { "CF-Connecting-IP": "192.0.2.1" })).status, 401);
    const limited = await post("/api/v1/auth/login", { password: "a secure test password!" }, { "CF-Connecting-IP": "192.0.2.1" });
    assert.equal(limited.status, 429);
  });

  await suite.test("unavailable Lantern flows fail explicitly", async () => {
    assert.equal((await call("/api/v1/connect-config")).status, 501);
    assert.match((await (await call("/api/v1/connect-config")).json()).error, /inbound TCP\/UDP listeners/);
    assert.equal((await call("/api/v1/share-link/alice")).status, 501);
    assert.equal((await call("/api/v1/revoke/alice", { method: "POST" })).status, 501);
  });

  await suite.test("response security headers, cookie properties, and no-store", async () => {
    const response = await setup();
    assert.match(response.headers.get("Set-Cookie"), /HttpOnly; Secure; SameSite=Strict/);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.match(response.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  });

  await suite.test("audit events persist and static requests pass through", async () => {
    await setup();
    const response = await call("/api/v1/admin/audit", { headers: { Cookie: cookie } });
    assert.equal((await response.json()).events[0].event, "setup.completed");
    assert.equal(await (await call("/")).text(), "ui");
  });

  await suite.test("unknown API routes return 404", async () => {
    const response = await call("/api/v1/not-real");
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, "Not found");
  });
});
