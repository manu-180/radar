/**
 * Cliente de la API oficial de Freelancer.com.
 *
 * Envuelve los endpoints REST que el MCP necesita. La auth va en el header
 * `freelancer-oauth-v1` (igual que el adaptador de fuente del radar). Cada
 * método devuelve `result` ya desempaquetado, o lanza un Error con el status y
 * el mensaje de la API para que el motivo del fallo llegue claro a Claude.
 */

import { BASE_URL, OAUTH_TOKEN, USER_AGENT } from "./config.js";

/** Par clave/valor para querystring; los arrays se expanden con sufijo `[]`. */
type Query = Record<string, string | number | boolean | string[] | undefined>;

export interface ProjectSummary {
  id: number | null;
  title: string;
  url: string;
  type: string | null;
  budget: string | null;
  currency: string | null;
  bids: { count: number | null; avg: number | null };
  submitted: string | null;
  skills: string[];
  preview: string;
}

export interface SearchOptions {
  query: string;
  limit?: number;
  minBudget?: number;
  maxBudget?: number;
  projectTypes?: string[];
  languages?: string[];
}

export interface PlaceBidInput {
  projectId: number;
  amount: number;
  periodDays: number;
  proposal: string;
  milestonePercentage?: number;
}

/** Error de configuración: falta el token. Mensaje accionable para el usuario. */
class MissingTokenError extends Error {
  constructor() {
    super(
      "Falta FREELANCER_OAUTH_TOKEN. Generalo en " +
        "https://accounts.freelancer.com/settings/develop y cargalo en la " +
        "config del MCP (~/.claude.json) o en un .env de freelancer-mcp.",
    );
    this.name = "MissingTokenError";
  }
}

export class FreelancerClient {
  /** id de la cuenta autenticada; se cachea tras el primer `whoami`. */
  private selfId: number | null = null;

  private get token(): string {
    if (!OAUTH_TOKEN) throw new MissingTokenError();
    return OAUTH_TOKEN;
  }

  /** Construye la URL con querystring, expandiendo arrays como `key[]=v`. */
  private buildUrl(path: string, query?: Query): URL {
    const url = new URL(path, BASE_URL);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const v of value) url.searchParams.append(`${key}[]`, v);
        } else {
          url.searchParams.append(key, String(value));
        }
      }
    }
    return url;
  }

  /** Request genérico. Desempaqueta `result` o lanza con status + mensaje. */
  private async request<T>(
    method: "GET" | "POST",
    path: string,
    opts: { query?: Query; form?: Record<string, string | number> } = {},
  ): Promise<T> {
    const url = this.buildUrl(path, opts.query);
    const headers: Record<string, string> = {
      "freelancer-oauth-v1": this.token,
      "user-agent": USER_AGENT,
      accept: "application/json",
    };

    let body: string | undefined;
    if (opts.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.form)) params.append(k, String(v));
      body = params.toString();
    }

    let res: Response;
    try {
      res = await fetch(url, { method, headers, body });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`No se pudo contactar la API de Freelancer.com: ${reason}`);
    }

    const json = (await res.json().catch(() => null)) as
      | { status?: string; result?: T; message?: string; error_code?: string }
      | null;

    if (!res.ok) {
      const detail = json?.message ?? json?.error_code ?? res.statusText;
      throw new Error(`Freelancer API ${res.status}: ${detail}`);
    }
    // La API responde 200 con un `status` propio: si no es "success", es fallo.
    if (json?.status && json.status !== "success") {
      const detail = json.message ?? json.error_code ?? json.status;
      throw new Error(`Freelancer API status "${json.status}": ${detail}`);
    }
    return (json?.result ?? null) as T;
  }

  /** Cuenta autenticada (id, usuario). Cachea el id para los bids. */
  async whoami(): Promise<{ id: number; username: string | null }> {
    const result = await this.request<{ id: number; username?: string | null }>(
      "GET",
      "/api/users/0.1/self/",
    );
    this.selfId = result.id;
    return { id: result.id, username: result.username ?? null };
  }

  /** id de la cuenta, pidiéndolo si todavía no se cacheó. */
  private async getSelfId(): Promise<number> {
    if (this.selfId != null) return this.selfId;
    const { id } = await this.whoami();
    return id;
  }

  /** Busca proyectos ACTIVOS que matchean `query`. Read-only. */
  async searchProjects(opts: SearchOptions): Promise<ProjectSummary[]> {
    const result = await this.request<{ projects?: RawProject[] }>(
      "GET",
      "/api/projects/0.1/projects/active/",
      {
        query: {
          query: opts.query,
          limit: opts.limit ?? 20,
          full_description: true,
          job_details: true,
          min_avg_price: opts.minBudget,
          max_avg_price: opts.maxBudget,
          project_types: opts.projectTypes,
          languages: opts.languages,
          sort_field: "time_updated",
        },
      },
    );
    return (result.projects ?? []).map(toSummary);
  }

  /** Detalle completo de un proyecto. Read-only. */
  async getProject(id: number): Promise<RawProject> {
    return this.request<RawProject>("GET", `/api/projects/0.1/projects/${id}/`, {
      query: { full_description: true, job_details: true, user_details: true },
    });
  }

  /** Bids ya postulados por la cuenta. Read-only (para no duplicar y trackear). */
  async listMyBids(limit = 30): Promise<RawBid[]> {
    const me = await this.getSelfId();
    const result = await this.request<{ bids?: RawBid[] }>(
      "GET",
      "/api/projects/0.1/bids/",
      { query: { bidders: [String(me)], limit } },
    );
    return result.bids ?? [];
  }

  /** Postula un bid. WRITE — el gateo de aprobación vive en la capa de tools. */
  async placeBid(input: PlaceBidInput): Promise<{ id: number | null }> {
    const me = await this.getSelfId();
    const result = await this.request<{ id?: number }>(
      "POST",
      "/api/projects/0.1/bids/",
      {
        form: {
          project_id: input.projectId,
          bidder_id: me,
          amount: input.amount,
          period: input.periodDays,
          milestone_percentage: input.milestonePercentage ?? 50,
          description: input.proposal,
        },
      },
    );
    return { id: result?.id ?? null };
  }

  /** Lista los threads de mensajes (inbox), con el último mensaje inline. */
  async listThreads(limit = 20): Promise<RawThread[]> {
    const result = await this.request<{ threads?: RawThread[] }>(
      "GET",
      "/api/messages/0.1/threads/",
      { query: { limit, last_message: true } },
    );
    return result.threads ?? [];
  }

  /** Lee los mensajes de un thread. Read-only. */
  async getMessages(threadId: number, limit = 30): Promise<RawMessage[]> {
    const result = await this.request<{ messages?: RawMessage[] }>(
      "GET",
      "/api/messages/0.1/messages/",
      { query: { threads: [String(threadId)], limit } },
    );
    return result.messages ?? [];
  }

  /** Responde en un thread existente. WRITE — gateado en la capa de tools. */
  async sendMessage(threadId: number, message: string): Promise<void> {
    await this.request("POST", `/api/messages/0.1/threads/${threadId}/messages/`, {
      form: { message },
    });
  }
}

// --- Formas parciales de la API (sólo los campos que usamos) -----------------

interface RawProject {
  id?: number | null;
  title?: string | null;
  seo_url?: string | null;
  type?: string | null;
  description?: string | null;
  preview_description?: string | null;
  submitdate?: number | null;
  currency?: { code?: string | null; sign?: string | null } | null;
  budget?: { minimum?: number | null; maximum?: number | null } | null;
  bid_stats?: { bid_count?: number | null; bid_avg?: number | null } | null;
  jobs?: Array<{ name?: string | null }> | null;
}

interface RawBid {
  id?: number;
  project_id?: number;
  amount?: number;
  period?: number;
  award_status?: string | null;
}

interface RawThread {
  id?: number;
  thread_type?: string | null;
  message?: { message?: string | null; from_user?: number | null } | null;
  context?: { type?: string | null; id?: number | null } | null;
}

interface RawMessage {
  id?: number;
  from_user?: number | null;
  message?: string | null;
  time_created?: number | null;
}

export type { RawProject, RawBid, RawThread, RawMessage };

/** Mapea un proyecto crudo a la forma compacta que consume Claude. */
function toSummary(p: RawProject): ProjectSummary {
  const min = p.budget?.minimum ?? null;
  const max = p.budget?.maximum ?? null;
  const budget =
    min != null && max != null
      ? `${min}–${max}`
      : min != null
        ? `${min}+`
        : max != null
          ? `≤${max}`
          : null;
  const url = p.seo_url
    ? `https://www.freelancer.com/projects/${p.seo_url}`
    : p.id != null
      ? `https://www.freelancer.com/projects/${p.id}`
      : "";
  const preview = (p.preview_description ?? p.description ?? "").trim();
  return {
    id: p.id ?? null,
    title: (p.title ?? "").trim(),
    url,
    type: p.type ?? null,
    budget,
    currency: p.currency?.code ?? p.currency?.sign ?? null,
    bids: { count: p.bid_stats?.bid_count ?? null, avg: p.bid_stats?.bid_avg ?? null },
    submitted:
      typeof p.submitdate === "number"
        ? new Date(p.submitdate * 1000).toISOString()
        : null,
    skills: (p.jobs ?? []).map((j) => j.name ?? "").filter(Boolean),
    preview: preview.length > 600 ? `${preview.slice(0, 600)}…` : preview,
  };
}
