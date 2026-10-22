const DEFAULT_CUSTOMERS_PATH = "/api/customers";

const ALLOWED_FILTERS = [
  "page",
  "username",
  "serverId",
  "packageId",
  "expiryFrom",
  "expiryTo",
  "createdFrom",
  "createdTo",
  "status",
  "isTrial",
  "connections",
  "perPage",
];

async function listCustomers({
  baseUrl,
  token,
  cookies,
  filters = {},
  timeoutMs = 15000,
  customersPath = DEFAULT_CUSTOMERS_PATH,
}) {
  if (!baseUrl) {
    throw new Error("Informe a URL base do painel.");
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

  const path = customersPath.startsWith("/")
    ? customersPath
    : `/${customersPath}`;

  const url = new URL(path, base.origin);

  if (url.origin !== base.origin) {
    throw new Error("O endpoint deve pertencer ao painel configurado.");
  }

  // Valores padrão equivalentes à consulta do navegador.
  const query = {
    page: 1,
    username: "",
    serverId: "",
    packageId: "",
    expiryFrom: "",
    expiryTo: "",
    createdFrom: "",
    createdTo: "",
    status: "",
    isTrial: "",
    connections: "",
    perPage: 20,
    ...filters,
  };

  for (const key of Object.keys(query)) {
    if (!ALLOWED_FILTERS.includes(key)) {
      throw new Error(`Filtro não permitido: ${key}`);
    }

    const value = query[key];

    if (
      value !== null &&
      value !== undefined &&
      !["string", "number", "boolean"].includes(typeof value)
    ) {
      throw new Error(`Valor inválido para o filtro ${key}`);
    }

    if (value !== null && value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = {
    Accept: "application/json",
  };

  // Use o token recebido no login, se disponível.
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  // Opcional: cookies de uma sessão legítima já autenticada.
  if (cookies) {
    headers.Cookie = cookies;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
      redirect: "error",
    });

    const contentType = response.headers.get("content-type") || "";

    if (!contentType.includes("application/json")) {
      const error = new Error("O painel não retornou JSON ao listar clientes.");

      error.code = "PANEL_INVALID_RESPONSE";
      error.status = response.status;
      throw error;
    }

    const result = await response.json();

    if (!response.ok) {
      const error = new Error(
        result?.message || "Não foi possível listar os clientes.",
      );

      error.code =
        response.status === 401 || response.status === 403
          ? "PANEL_AUTH_FAILED"
          : "PANEL_CUSTOMERS_FAILED";

      error.status = response.status;
      error.errors = result?.errors ?? null;

      throw error;
    }

    if (!Array.isArray(result?.data)) {
      const error = new Error("Formato de resposta de clientes inesperado.");

      error.code = "PANEL_INVALID_RESPONSE";
      throw error;
    }

    return {
      success: true,
      customers: result.data,
      pagination: {
        currentPage: result.meta?.current_page ?? null,
        perPage: result.meta?.per_page ?? null,
        total: result.meta?.total ?? result.data.length,
        lastPage: result.meta?.last_page ?? null,
        from: result.meta?.from ?? null,
        to: result.meta?.to ?? null,
        links: result.links ?? null,
      },
    };
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error(
        "Tempo limite excedido ao listar clientes.",
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
  listCustomers,
};
