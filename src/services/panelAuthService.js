const DEFAULT_LOGIN_PATH = "/api/auth/login";

function normalizeLoginResponse(data) {
  const user = data?.user ?? data?.data ?? data;

  if (!user || typeof user !== "object") {
    throw new Error(data?.message || "Resposta inválida do painel.");
  }

  if (!user.id || !user.username) {
    const error = new Error(
      data?.message || "Não foi possível confirmar o login.",
    );

    error.code = "PANEL_LOGIN_FAILED";
    error.errors = data?.errors ?? null;

    throw error;
  }

  return {
    success: true,

    user: {
      id: user.id ?? null,
      username: user.username ?? null,
      status: user.status ?? null,
      role: user.role ?? null,
      locale: user.locale ?? null,

      credits: user.credits ?? null,

      permissions: Array.isArray(user.permissions) ? user.permissions : [],

      servers: Array.isArray(user.servers) ? user.servers : [],

      membership: {
        active: user.membership_active ?? null,
        type: user.membership_type ?? null,
        planType: user.membership_plan_type ?? null,
        expiryDate: user.membership_expiry_date ?? null,
        expiryAt: user.membership_expiry_at ?? null,
        secondsRemaining: user.membership_seconds_remaining ?? null,
      },

      twoFactorEnabled: user.two_factor_enabled ?? false,
      twoFactor: user.twofactor ?? null,

      lastLoginAt: user.last_login_at ?? null,

      needResetPassword: user.need_reset_password ?? null,

      subscriptionUrls: {
        customer: user.customer_subscribe_url ?? null,
        reseller: user.reseller_subscribe_url ?? null,
      },
    },

    // O token é separado dos dados públicos do usuário.
    token: data?.token ?? data?.data?.token ?? user?.token ?? null,
  };
}

async function login({
  baseUrl,
  loginPath = DEFAULT_LOGIN_PATH,
  username,
  password,
  twofactor_code = "",
  twofactor_recovery_code = "",
  twofactor_trusted_device_id = "",
  timeoutMs = 15000,
}) {
  if (!baseUrl || !username || !password) {
    throw new Error("Informe baseUrl, username e password.");
  }

  const base = new URL(baseUrl);

  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error("URL base do painel inválida.");
  }

  const path = loginPath.startsWith("/") ? loginPath : `/${loginPath}`;

  const url = new URL(path, base.origin);

  if (url.origin !== base.origin) {
    throw new Error(
      "O endpoint de login deve pertencer ao painel configurado.",
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        username,
        password,
        twofactor_code,
        twofactor_recovery_code,
        twofactor_trusted_device_id,
      }),
      signal: controller.signal,
      redirect: "error",
    });

    const contentType = response.headers.get("content-type") || "";

    if (!contentType.includes("application/json")) {
      const error = new Error("O painel não retornou uma resposta JSON.");

      error.code = "PANEL_INVALID_RESPONSE";
      error.status = response.status;
      throw error;
    }

    const data = await response.json();

    if (!response.ok) {
      const error = new Error(data?.message || "Falha no login do painel.");

      error.code = "PANEL_LOGIN_FAILED";
      error.status = response.status;
      error.errors = data?.errors ?? null;

      throw error;
    }

    return normalizeLoginResponse(data);
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error(
        "Tempo limite excedido ao conectar ao painel.",
      );

      timeoutError.code = "PANEL_TIMEOUT";
      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  login,
  normalizeLoginResponse,
};
