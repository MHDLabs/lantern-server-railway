import {
  audit,
  createSession,
  deleteSession,
  getSession,
  isSetupComplete,
  listAudit,
  loginAllowed,
  setupAdmin,
  verifyAdminPassword,
} from "./store.js";
import { errorResponse, json } from "./security.js";

const COOKIE_NAME = "lantern_admin";
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

function secureEqual(left, right) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
}

function cookie(token, maxAge) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function readCookie(request) {
  const cookies = request.headers.get("Cookie") || "";
  for (const item of cookies.split(";")) {
    const [name, ...value] = item.trim().split("=");
    if (name === COOKIE_NAME) return value.join("=");
  }
  return "";
}

function originAllowed(request, url) {
  const origin = request.headers.get("Origin");
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  return (!origin || origin === url.origin) && (!fetchSite || fetchSite === "same-origin" || fetchSite === "none");
}

async function bodyJson(request, maxBytes = 4096) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > maxBytes) throw new Error("Request body is too large");
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) throw new Error("Content-Type must be application/json");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("Request body is too large");
  try {
    const data = JSON.parse(text);
    if (!data || Array.isArray(data) || typeof data !== "object") throw new Error();
    return data;
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

function positiveSetting(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

async function requireAdmin(request, env) {
  const token = readCookie(request);
  const session = await getSession(env.DB, token);
  return session ? { token, session } : null;
}

async function handleApi(request, env, url) {
  const { pathname } = url;
  if (request.method === "GET" && pathname === "/api/v1/health") {
    return json({ status: "ok", control_plane: "available", lantern_data_plane: "unavailable" });
  }
  if (request.method === "GET" && pathname === "/api/v1/setup/status") {
    return json({ setup_required: !(await isSetupComplete(env.DB)), bootstrap_secret_configured: Boolean(env.BOOTSTRAP_SECRET) });
  }
  if (request.method === "POST" && pathname === "/api/v1/setup") {
    if (!originAllowed(request, url)) return errorResponse("Cross-origin request rejected", 403);
    if (await isSetupComplete(env.DB)) return errorResponse("Initial setup has already been completed", 409);
    if (!env.BOOTSTRAP_SECRET || env.BOOTSTRAP_SECRET.length < 32) return errorResponse("Administrator setup is disabled: configure a random BOOTSTRAP_SECRET of at least 32 characters", 503);
    let data;
    try { data = await bodyJson(request); } catch (error) { return errorResponse(error.message, 400); }
    const submittedSecret = typeof data.bootstrap_secret === "string" ? data.bootstrap_secret : "";
    if (!secureEqual(submittedSecret, env.BOOTSTRAP_SECRET)) return errorResponse("Invalid bootstrap secret", 403);
    if (typeof data.password !== "string" || data.password.length < 14 || data.password.length > 256) return errorResponse("Password must be between 14 and 256 characters", 400);
    if (!(await setupAdmin(env.DB, data.password))) return errorResponse("Initial setup has already been completed", 409);
    const ttl = positiveSetting(env.SESSION_TTL_SECONDS, 43200, 604800);
    const token = await createSession(env.DB, ttl);
    return json({ status: "setup_complete" }, 201, { "Set-Cookie": cookie(token, ttl) });
  }
  if (request.method === "POST" && pathname === "/api/v1/auth/login") {
    if (!originAllowed(request, url)) return errorResponse("Cross-origin request rejected", 403);
    if (!(await isSetupComplete(env.DB))) return errorResponse("Complete initial setup first", 428);
    const maxAttempts = positiveSetting(env.LOGIN_MAX_ATTEMPTS, 10, 100);
    const windowSeconds = positiveSetting(env.LOGIN_WINDOW_SECONDS, 900, 86400);
    const address = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!(await loginAllowed(env.DB, address, maxAttempts, windowSeconds))) return errorResponse("Too many login attempts; try again later", 429);
    let data;
    try { data = await bodyJson(request); } catch (error) { return errorResponse(error.message, 400); }
    if (typeof data.password !== "string" || data.password.length > 256 || !(await verifyAdminPassword(env.DB, data.password))) {
      return errorResponse("Invalid credentials", 401);
    }
    const ttl = positiveSetting(env.SESSION_TTL_SECONDS, 43200, 604800);
    const token = await createSession(env.DB, ttl);
    await audit(env.DB, "auth.login", "admin");
    return json({ status: "authenticated", expires_in: ttl }, 200, { "Set-Cookie": cookie(token, ttl) });
  }
  if (request.method === "POST" && pathname === "/api/v1/auth/logout") {
    if (!originAllowed(request, url)) return errorResponse("Cross-origin request rejected", 403);
    const token = readCookie(request);
    await deleteSession(env.DB, token);
    return json({ status: "signed_out" }, 200, { "Set-Cookie": cookie("", 0) });
  }
  if (request.method === "GET" && pathname === "/api/v1/auth/session") {
    const admin = await requireAdmin(request, env);
    return admin ? json({ authenticated: true, expires_at: admin.session.expiresAt }) : errorResponse("Authentication required", 401);
  }
  if (request.method === "GET" && pathname === "/api/v1/admin/status") {
    if (!(await requireAdmin(request, env))) return errorResponse("Authentication required", 401);
    return json({ manager: "available", lantern_protocol_compatibility: "not_implemented", traffic_proxy: "not_available", explanation: "This deployment manages no Lantern-compatible data plane. Do not use its URLs as a Lantern VPN server." });
  }
  if (request.method === "GET" && pathname === "/api/v1/admin/audit") {
    if (!(await requireAdmin(request, env))) return errorResponse("Authentication required", 401);
    return json({ events: await listAudit(env.DB) });
  }
  if (pathname === "/api/v1/connect-config" || pathname.startsWith("/api/v1/share-link") || pathname.startsWith("/api/v1/revoke")) {
    return errorResponse("Unavailable: official Lantern client provisioning requires the lantern-box proxy engine and inbound TCP/UDP listeners, which Cloudflare Workers do not provide", 501);
  }
  return errorResponse("Not found", 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let response;
    try {
      if (url.pathname.startsWith("/api/")) {
        response = await handleApi(request, env, url);
      } else {
        response = await env.ASSETS.fetch(request);
      }
    } catch (error) {
      console.error("Request failed", error instanceof Error ? error.message : "unknown error");
      response = errorResponse("Internal server error", 500);
    }
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
    if (url.pathname.startsWith("/api/")) headers.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};
