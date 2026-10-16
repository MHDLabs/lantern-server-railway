const $ = (selector) => document.querySelector(selector);
const setupForm = $("#setup-form");
const loginForm = $("#login-form");
const adminView = $("#admin-view");
const message = $("#message");

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function showMessage(text = "") { message.textContent = text; }

function showAdmin() {
  setupForm.classList.add("hidden");
  loginForm.classList.add("hidden");
  adminView.classList.remove("hidden");
  $("#state-badge").textContent = "Signed in";
  $("#panel-title").textContent = "Operational status";
  $("#panel-copy").textContent = "The administrative control plane is active. It does not run a proxy or provision Lantern clients.";
}

async function refresh() {
  showMessage();
  const [status, session] = await Promise.all([
    api("/api/v1/setup/status"),
    api("/api/v1/auth/session").catch(() => null),
  ]);
  if (session) {
    showAdmin();
  } else if (status.setup_required) {
    $("#state-badge").textContent = "Setup required";
    if (status.bootstrap_secret_configured) setupForm.classList.remove("hidden");
    else {
      $("#panel-copy").textContent = "Administrator setup is disabled. Set a random BOOTSTRAP_SECRET (at least 32 characters) in Worker secrets, then reload.";
    }
  } else {
    $("#state-badge").textContent = "Sign in";
    $("#panel-title").textContent = "Administrator sign in";
    $("#panel-copy").textContent = "Sign in to inspect control-plane status and recent audit events.";
    loginForm.classList.remove("hidden");
  }
}

setupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(setupForm);
  try {
    await api("/api/v1/setup", { method: "POST", body: JSON.stringify({ bootstrap_secret: form.get("bootstrap_secret"), password: form.get("password") }) });
    setupForm.reset();
    await refresh();
  } catch (error) { showMessage(error.message); }
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/v1/auth/login", { method: "POST", body: JSON.stringify({ password: new FormData(loginForm).get("password") }) });
    loginForm.reset();
    await refresh();
  } catch (error) { showMessage(error.message); }
});

$("#logout-button").addEventListener("click", async () => {
  try { await api("/api/v1/auth/logout", { method: "POST" }); await refresh(); }
  catch (error) { showMessage(error.message); }
});

$("#audit-button").addEventListener("click", async () => {
  try {
    const { events } = await api("/api/v1/admin/audit");
    const output = $("#audit-output");
    output.textContent = events.length ? events.map(({ event, subject, created_at }) => `${new Date(created_at * 1000).toISOString()}  ${event}  ${subject}`).join("\n") : "No administrative events recorded.";
    output.classList.remove("hidden");
  } catch (error) { showMessage(error.message); }
});

refresh().catch((error) => showMessage(error.message));
