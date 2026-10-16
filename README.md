# Lantern Server Manager — Cloudflare Workers edition

> **This is an administration/control-plane rewrite, not a VPN server. It does not implement the official Lantern client protocol and cannot provide VPN access.** Cloudflare Workers currently has outbound TCP sockets and HTTP/WebSocket request handling, but no public inbound TCP/UDP listener for arbitrary client connections. The original server uses `lantern-box` as its Shadowsocks traffic engine. Accordingly, this rewrite explicitly disables client provisioning and does not claim compatibility.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/MHDLabs/lantern-server-railway)

## English

### What it does

- Serves a small Cloudflare Workers administrative page.
- Supports one-time admin bootstrap protected by a Cloudflare secret and strong password.
- Authenticates admins using opaque, revocable, expiring HttpOnly sessions stored as hashes in D1.
- Applies D1-backed login throttling, same-origin checks, security headers, and audit records.
- Reports health and the proxy/protocol status honestly.

It does **not** expose a VPN, issue Lantern links/configuration, provide subscriptions, operate a proxy/data plane, or manage keys/peers. Calls to the old connect-config, share-link, or revoke endpoints receive HTTP 501 with a reason. Do not add this endpoint to the Lantern client.

### Compatibility and feasibility

The original README describes `lantern://new-private-server?...`, `/api/v1/connect-config`, user-specific Shadowsocks provisioning and a sing-box client config. The source in `common/singbox.go` configures a `lantern-box` Shadowsocks inbound using `chacha20-ietf-poly1305`; `cmd/cmd_serve.go` starts that engine and provides the manager routes. `lantern-box` is a Go execution engine and the original code starts it as a native executable or systemd service.

| Requirement | Status | Evidence / result |
|---|---|---|
| Admin UI/API over HTTPS | IMPLEMENTABLE | Workers fetch handler, static assets and Web Crypto are available. |
| Durable admin/session/audit data | IMPLEMENTABLE | D1 bindings and SQL migrations are used. |
| Secure password hashing and random sessions | IMPLEMENTABLE | Web Crypto PBKDF2-SHA-256, random values and SHA-256; session bearer token stored only as a hash. |
| Outbound TCP connections | IMPLEMENTABLE WITH LIMITATIONS | Workers `connect()` supports outbound TCP, not a listener; socket policies/limits apply. |
| Inbound HTTP and WebSocket handling | IMPLEMENTABLE WITH LIMITATIONS | Works over Cloudflare request protocols only; a WebSocket upgrade does not itself implement Lantern. |
| Original Shadowsocks/Lantern proxy data plane | NOT IMPLEMENTABLE UNDER THE GIVEN CONSTRAINTS | Original config requires a `lantern-box` inbound listener and traffic engine. Workers provides outbound sockets; Cloudflare's TCP documentation says inbound TCP from external sources is not available (inbound service-binding handling is a distinct path). UDP listener/datagram proxy is absent. |
| Official Lantern client complete handshake and traffic | NOT IMPLEMENTABLE UNDER THE GIVEN CONSTRAINTS | Required endpoint must accept protocol traffic and forward TCP/UDP application flows; no compatible implementation or actual traffic bridge can run under these Worker constraints. No official-client test is claimed. |
| File-based config, firewall, ACME TLS, process/systemd management | NOT APPLICABLE / REMOVED | Workers configuration, Cloudflare TLS termination, D1, and managed execution replace host-specific behavior, except proxy engine functionality which has no replacement here. |

Cloudflare references (current platform docs): [TCP Sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) (explicitly outbound `connect()`; external inbound TCP is not available), [WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/), [D1](https://developers.cloudflare.com/d1/). The protocol limitation is architectural, not a missing route or a failed status code.

### Architecture

- `src/index.js`: API routing, secure session cookies, request checks and security response headers.
- `src/store.js`: D1 persistence, admin password hash, session lifecycle, login throttling and audit.
- `src/security.js`: cryptographic helpers.
- `public/`: static admin UI.
- `migrations/`: D1 schema.
- `test/`: Node.js integration tests using the built-in test runner and an in-memory SQLite adapter for D1 SQL.

D1 is required for deployed persistence; a database and Cloudflare account are not needed for local tests, which use Node.js SQLite. D1 is available on Workers Free and Paid; usage quotas/pricing vary by plan. No third-party application backend is required. Local Wrangler requires Cloudflare's `workerd` native binary; this host's CPU lacks an instruction required by the available binary, so `wrangler dev` and local D1 commands failed here with `Illegal instruction` / `EPIPE`. This does not affect bundle validation or Node-based tests.

### Prerequisites and local development

```sh
npm ci
npm run db:migrate:local
npm run dev
```

Open the URL Wrangler prints. To initialize, configure `BOOTSTRAP_SECRET` locally in `.dev.vars` (never commit it) with a random secret of at least 32 characters, restart the dev server and reload. Then choose a password of 14–256 characters. The UI will not offer first-run setup if the secret is absent.

Run tests and bundle validation:

```sh
npm test
npm run build
npm audit
```

### Cloudflare deployment

1. Create a Cloudflare account and install dependencies with `npm ci`.
2. Create a D1 database named `lantern-manager` in the Cloudflare dashboard or with Wrangler. Copy its generated database ID into `database_id` in `wrangler.toml` (replace the explanatory placeholder).
3. Apply the schema: `npm run db:migrate:remote`.
4. Set a unique, random bootstrap secret (at least 32 characters) as a Worker secret: `npx wrangler secret put BOOTSTRAP_SECRET`. Never put this in `[vars]`, source code, or the browser.
5. Deploy with `npm run deploy`. Wrangler serves the Worker and `public/` assets; no separate host or Docker is involved.
6. Open the deployed site and complete one-time setup. Remove/rotate the bootstrap secret in Cloudflare after initialization; setup has already been permanently locked after the first admin row is created. For recovery, manually manage D1 access rather than exposing a reset endpoint.

`wrangler.toml` declares the `ASSETS` binding and D1 binding, with migrations in `migrations/`. HTTPS is provided at Cloudflare edge. A custom domain is optional. Deployment was not performed from this workspace.

### Security notes

- No default admin password. Setup requires a private Worker secret and locks after successful initialization.
- PBKDF2-SHA-256 (310,000 iterations) with random per-admin salt; opaque 256-bit sessions have expiry and are hashed at rest.
- HttpOnly, Secure, SameSite=Strict cookies; mutating requests reject cross-origin `Origin` values.
- Login attempts are throttled by client IP in D1; additional Cloudflare rate-limiting/WAF rules are recommended because D1 counters are not a substitute for edge abuse controls.
- CSP and common security headers; API responses are non-cacheable. The static UI uses only local assets and has no third-party font dependency.
- Audit log stores event, subject ID, and time; it does not include credentials.
- Admin passwords cannot be recovered from their hashes. Protect D1 and Worker secrets; use Cloudflare account MFA and least-privilege tokens.
- No TLS certificate private key is managed in application code; Cloudflare terminates browser HTTPS.

### License and attribution

This is a derivative rewrite of the existing repository, whose supplied `LICENSE` is GNU GPL version 3. The GPL-3.0 license is retained; original Go implementation material has been removed, but this JavaScript rewrite preserves the project's product and API concepts. No `lantern-box` source or protocol implementation has been copied into this project. Tool dependencies retain their own licenses in npm package metadata; no dependency code is bundled into the source repository. See `LICENSE`.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/MHDLabs/lantern-server-railway)

## فارسی

### معرفی

> **این نسخه فقط پنل مدیریتی است و سرور VPN نیست. پروتکل کلاینت رسمی Lantern را پیاده‌سازی نمی‌کند و اتصال VPN ارائه نمی‌دهد.** Cloudflare Workers سوکت TCP خروجی را پشتیبانی می‌کند، اما شنونده عمومی TCP/UDP برای اتصال دلخواه کلاینت‌ها ندارد. سرور اصلی برای عبور ترافیک به موتور `lantern-box` نیاز دارد؛ بنابراین سازگاری با Lantern ادعا نمی‌شود و ساخت پیکربندی جعلی نیز انجام نمی‌گیرد.

### قابلیت‌های موجود

- پنل مدیریتی مبتنی بر Cloudflare Workers و فایل‌های استاتیک.
- راه‌اندازی اولیه یک‌باره با راز محرمانه Cloudflare و گذرواژه قوی مدیر.
- نشست‌های تصادفی، زمان‌دار و قابل ابطال؛ مقدار نشست به‌شکل هش در D1 ذخیره می‌شود.
- محدودسازی تلاش ورود مبتنی بر D1، کنترل مبدأ درخواست، سرآیندهای امنیتی و ثبت رویدادهای مدیریتی.
- نمایش صریح وضعیت واقعی صفحه مدیریت و نبود موتور پراکسی.

این پروژه VPN، پیوند یا پیکربندی Lantern، اشتراک، موتور انتقال ترافیک یا مدیریت peer ارائه نمی‌کند. مسیرهای قدیمی `connect-config`، `share-link` و `revoke` با خطای HTTP 501 و توضیح روشن پاسخ می‌دهند. این سرویس را در کلاینت Lantern وارد نکنید.

### سازگاری و امکان‌پذیری

در پیاده‌سازی اصلی، مسیر `/api/v1/connect-config` پیکربندی Shadowsocks با رمز `chacha20-ietf-poly1305` می‌سازد و فرایند اجرایی `lantern-box` ترافیک را دریافت می‌کند. مستندات قدیمی `lantern://new-private-server` و اشتراک دسترسی را شرح می‌دادند. در Workers، API سوکت TCP برای اتصال خروجی است؛ شنونده ورودی عمومی و شنونده UDP لازم برای دریافت ترافیک پراکسی فراهم نیست. WebSocket روی HTTP جایگزین همان پروتکل نیست.

| نیاز | وضعیت | توضیح |
|---|---|---|
| پنل و API مدیریتی HTTPS | قابل پیاده‌سازی | با درخواست‌های Worker و فایل‌های استاتیک. |
| ذخیره نشست‌ها، مدیر و رویدادها | قابل پیاده‌سازی | با D1 و مهاجرت SQL. |
| هش گذرواژه و توکن تصادفی امن | قابل پیاده‌سازی | با Web Crypto. |
| اتصال TCP خروجی | قابل پیاده‌سازی با محدودیت | API خروجی است و شنونده عمومی نیست. |
| پراکسی Lantern/Shadowsocks اصلی | با محدودیت‌های تعیین‌شده قابل پیاده‌سازی نیست | موتور `lantern-box` و شنونده TCP/UDP ورودی لازم است که Workers ارائه نمی‌کند. |
| handshake و انتقال واقعی کلاینت رسمی Lantern | با محدودیت‌های تعیین‌شده قابل پیاده‌سازی نیست | هیچ آزمون موفقی با کلاینت رسمی ادعا نشده است. |
| systemd، firewall، فایل پیکربندی و ACME روی میزبان | حذف شده/کاربرد ندارد | وظایف محیط سرور مستقل با قابلیت‌های مدیریت‌شده Cloudflare جایگزین شده‌اند، به‌جز موتور پراکسی که جایگزین ندارد. |

مراجع Cloudflare: [TCP Sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)، [WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/)، [محدودیت‌های Workers](https://developers.cloudflare.com/workers/platform/limits/)، [Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)، [D1](https://developers.cloudflare.com/d1/).

### ساختار و پیش‌نیازها

- `src/index.js`: مسیریابی API، نشست‌ها و سرآیندهای امنیتی.
- `src/store.js`: ذخیره‌سازی D1، مدیر، نشست‌ها، محدودیت ورود و audit.
- `src/security.js`: توابع رمزنگاری.
- `public/`: رابط مدیریتی.
- `migrations/`: ساختار پایگاه داده D1.
- `test/`: آزمون‌های یکپارچه با آزمون‌گر داخلی Node.js و SQLite حافظه‌ای برای SQL سازگار با D1.

نیازمندی محلی: Node.js نسخه 22.12 یا بالاتر و npm. برای توسعه، آزمون و build:

```sh
npm ci
npm run db:migrate:local
npm run dev
npm test
npm run build
npm audit
```

برای راه‌اندازی محلی، راز `BOOTSTRAP_SECRET` را در فایل محلی `.dev.vars` قرار دهید؛ این فایل را commit نکنید. راز باید دست‌کم ۳۲ نویسه تصادفی داشته باشد. سپس از پنل گذرواژه ۱۴ تا ۲۵۶ نویسه‌ای تعیین کنید.

### استقرار روی Cloudflare

1. حساب Cloudflare بسازید و `npm ci` را اجرا کنید.
2. پایگاه D1 با نام `lantern-manager` بسازید و شناسه تولیدشده را در `database_id` فایل `wrangler.toml` جایگزین متن راهنما کنید.
3. ساختار پایگاه را اجرا کنید: `npm run db:migrate:remote`.
4. با `npx wrangler secret put BOOTSTRAP_SECRET` یک راز تصادفی و محرمانه (حداقل ۳۲ نویسه) ثبت کنید؛ راز را در متغیر عمومی، کد یا مرورگر نگذارید.
5. با `npm run deploy` مستقر کنید. Worker و `public/` منتشر می‌شوند؛ میزبان جداگانه یا Docker نیاز نیست.
6. سایت را باز کرده، مدیر را یک‌بار بسازید و پس از راه‌اندازی، راز bootstrap را از Cloudflare حذف یا تعویض کنید. پس از ایجاد مدیر، مسیر عمومی راه‌اندازی قفل می‌شود.

D1 برای ماندگاری داده الزامی است. سهمیه رایگان و قیمت Cloudflare بر اساس طرح حساب و مصرف تغییر می‌کند؛ محدودیت‌های جاری را پیش از استفاده تولیدی بررسی کنید. استقرار واقعی در این نشست انجام نشده است.

### امنیت و مجوز

گذرواژه پیش‌فرض وجود ندارد. هش گذرواژه با PBKDF2-SHA-256 و salt یکتا ساخته می‌شود؛ نشست‌های تصادفی ۲۵۶ بیتی مدت‌دار هستند و فقط هش آن‌ها ذخیره می‌شود. کوکی‌ها HttpOnly، Secure و SameSite=Strict هستند. درخواست‌های تغییردهنده از مبدأ دیگر رد می‌شوند. برای محافظت بیشتر، محدودیت نرخ در Cloudflare WAF/Rate Limiting نیز تنظیم کنید. پایگاه D1 و رازهای Worker را محرمانه نگه دارید و MFA حساب Cloudflare را فعال کنید. رابط وب فقط از فایل‌های محلی استفاده می‌کند و فونت یا اسکریپت شخص ثالث بارگذاری نمی‌کند.

مجوز اصلی موجود در مخزن GNU GPL نسخه ۳ است و حفظ شده است. این بازنویسی مشتق از مخزن موجود است؛ کد `lantern-box` یا پیاده‌سازی پروتکل از آن کپی نشده است. به مجوز `LICENSE` مراجعه کنید. مجوز ابزارهای npm در فراداده بسته‌های مربوطه است.
