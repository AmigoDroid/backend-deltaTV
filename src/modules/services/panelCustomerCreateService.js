const DEFAULT_BASE_URL = "https://imperiotv.sbs";

async function createCustomer({
  cookies,
  baseUrl = DEFAULT_BASE_URL,
  customer,
  timeoutMs = 15000,
  token,
}) {
  if (!cookies) {
    throw new Error("Os cookies da sessão são obrigatórios.");
  }

  if (!customer || typeof customer !== "object") {
    throw new Error("Os dados do cliente são obrigatórios.");
  }

  const requiredFields = [
    "name",
    "username",
    "password",
    "server_id",
    "package_id",
  ];

  for (const field of requiredFields) {
    if (
      customer[field] === undefined ||
      customer[field] === null ||
      String(customer[field]).trim() === ""
    ) {
      throw new Error(`Campo obrigatório ausente: ${field}`);
    }
  }

  const url = new URL("/api/customers", baseUrl);

  if (
    url.protocol !== "https:" ||
    url.origin !== new URL(DEFAULT_BASE_URL).origin
  ) {
    throw new Error("URL do painel inválida.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "x-app-version": "3.94",
        locale: "pt",
        Origin: "https://imperiotv.sbs",
        Referer: "https://imperiotv.sbs/",
      },

      if(cookies) {
        headers.Cookie = cookies;
      },
      body: JSON.stringify({
        bouquets: customer.bouquets ?? "",
        connections: customer.connections ?? 1,
        name: customer.name,
        note: customer.note ?? "",
        package_id: customer.package_id,
        parent_can_edit_personal_data:
          customer.parent_can_edit_personal_data ?? "YES",
        password: customer.password,
        server_id: customer.server_id,
        trial_hours: customer.trial_hours ?? 1,
        username: customer.username,
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    let data;

    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { message: text };
    }

    if (!response.ok) {
      const error = new Error(
        data.message || `Falha ao criar cliente (HTTP ${response.status})`,
      );
      error.status = response.status;
      error.details = data.errors ?? null;
      throw error;
    }

    return {
      success: true,
      data,
      // O chamador pode usar esses cookies atualizados para
      // manter a sessão, se o servidor os devolver.
      setCookie: response.headers.getSetCookie?.() ?? [],
    };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { createCustomer };
