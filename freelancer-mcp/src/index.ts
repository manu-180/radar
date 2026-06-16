/**
 * MCP server de Freelancer.com.
 *
 * Expone la API de Freelancer como tools de Claude Code. Filosofía de seguridad:
 *
 * - **Reads libres** (buscar proyectos, ver detalle, listar bids, leer inbox y
 *   mensajes): no tocan la plataforma, riesgo nulo.
 * - **Writes gateados** (postular bid, responder mensaje): la API oficial los
 *   permite, pero Freelancer banea el *patrón* de bot (muchos bids muy rápido,
 *   spam a desconocidos). Por eso:
 *     1. Las descripciones de las tools le exigen a Claude pedir aprobación
 *        explícita del usuario antes de cada write.
 *     2. Claude Code igual pide permiso por cada llamada MCP (human-in-the-loop).
 *     3. `place_bid` tiene un tope por sesión ({@link DAILY_BID_CAP}).
 *
 * La redacción de propuestas y respuestas la hace Claude con sus skills de
 * copywriting; este server sólo transporta el texto ya aprobado.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { FreelancerClient } from "./client.js";
import { DAILY_BID_CAP } from "./config.js";

const client = new FreelancerClient();

/** Contador de bids de esta sesión del proceso (barrera anti-bot). */
let bidsThisSession = 0;

/** Respuesta de texto exitosa. */
function ok(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  const text =
    typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text", text }] };
}

/** Respuesta de error (isError → Claude ve el motivo y puede reaccionar). */
function fail(err: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `ERROR: ${message}` }], isError: true };
}

const server = new McpServer({ name: "freelancer-mcp", version: "1.0.0" });

// --- Reads -------------------------------------------------------------------

server.registerTool(
  "freelancer_whoami",
  {
    title: "Cuenta autenticada",
    description:
      "Devuelve la cuenta de Freelancer.com autenticada (id y usuario). " +
      "Llamala primero para confirmar que el token funciona. Read-only.",
    inputSchema: {},
  },
  async () => {
    try {
      return ok(await client.whoami());
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "freelancer_search_projects",
  {
    title: "Buscar proyectos",
    description:
      "Busca proyectos ACTIVOS en Freelancer.com que matchean una query. " +
      "Read-only, riesgo nulo. Úsalo para encontrar proyectos donde postular. " +
      "Devuelve id, título, presupuesto, stats de bids, skills y un preview de " +
      "cada proyecto. Filtros opcionales: presupuesto, tipo (fixed/hourly) e " +
      "idioma (ej. 'es', 'en').",
    inputSchema: {
      query: z.string().min(1).describe("Términos a buscar, ej. 'página web' o 'flutter app'"),
      limit: z.number().int().min(1).max(50).optional().describe("Máximo de resultados (default 20)"),
      minBudget: z.number().positive().optional().describe("Presupuesto promedio mínimo"),
      maxBudget: z.number().positive().optional().describe("Presupuesto promedio máximo"),
      projectTypes: z
        .array(z.enum(["fixed", "hourly"]))
        .optional()
        .describe("Tipos de proyecto a incluir"),
      languages: z
        .array(z.string())
        .optional()
        .describe("Códigos de idioma del proyecto, ej. ['es'] o ['es','en']"),
    },
  },
  async (args) => {
    try {
      const projects = await client.searchProjects(args);
      return ok({ count: projects.length, projects });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "freelancer_get_project",
  {
    title: "Detalle de proyecto",
    description:
      "Trae el detalle COMPLETO de un proyecto por id (descripción entera, " +
      "presupuesto, cantidad de bids). Read-only. Úsalo antes de redactar una " +
      "propuesta para entender bien qué pide el cliente.",
    inputSchema: {
      projectId: z.number().int().positive().describe("id del proyecto"),
    },
  },
  async ({ projectId }) => {
    try {
      return ok(await client.getProject(projectId));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "freelancer_list_my_bids",
  {
    title: "Mis bids",
    description:
      "Lista los bids que ya postaste (para no postular dos veces al mismo " +
      "proyecto y para seguir su estado). Read-only.",
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional().describe("Máximo (default 30)"),
    },
  },
  async ({ limit }) => {
    try {
      return ok(await client.listMyBids(limit));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "freelancer_list_threads",
  {
    title: "Inbox (threads)",
    description:
      "Lista tus conversaciones (inbox), con el último mensaje de cada una. " +
      "Read-only. Úsalo para ver quién te escribió y qué falta responder.",
    inputSchema: {
      limit: z.number().int().min(1).max(50).optional().describe("Máximo (default 20)"),
    },
  },
  async ({ limit }) => {
    try {
      return ok(await client.listThreads(limit));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "freelancer_get_messages",
  {
    title: "Leer mensajes",
    description:
      "Lee los mensajes de una conversación (thread) por su id. Read-only.",
    inputSchema: {
      threadId: z.number().int().positive().describe("id del thread"),
      limit: z.number().int().min(1).max(100).optional().describe("Máximo (default 30)"),
    },
  },
  async ({ threadId, limit }) => {
    try {
      return ok(await client.getMessages(threadId, limit));
    } catch (err) {
      return fail(err);
    }
  },
);

// --- Writes (gateados) -------------------------------------------------------

server.registerTool(
  "freelancer_place_bid",
  {
    title: "Postular bid",
    description:
      "Postula un bid (propuesta) en un proyecto. ACCIÓN DE ESCRITURA. REGLAS:\n" +
      "1) Llamala SOLO después de que el usuario aprobó explícitamente en el " +
      "chat tanto el monto como el texto de la propuesta.\n" +
      "2) Nunca postules en masa: ritmo humano, pocos por día. Hay un tope por " +
      "sesión que rechaza el exceso.\n" +
      "3) La propuesta debe estar redactada con cuidado (skills de copywriting), " +
      "personalizada al proyecto, NUNCA genérica ni robótica.",
    inputSchema: {
      projectId: z.number().int().positive().describe("id del proyecto"),
      amount: z.number().positive().describe("Monto del bid (en la moneda del proyecto)"),
      periodDays: z.number().int().positive().describe("Plazo de entrega en días"),
      proposal: z
        .string()
        .min(40)
        .describe("Texto de la propuesta, ya aprobado por el usuario y bien redactado"),
      milestonePercentage: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("% del primer milestone (default 50)"),
    },
  },
  async (args) => {
    try {
      if (bidsThisSession >= DAILY_BID_CAP) {
        return fail(
          `Tope de bids alcanzado (${DAILY_BID_CAP} esta sesión). Es una ` +
            "barrera anti-ban: postular más de a poco parece comportamiento de " +
            "bot. Si realmente querés postular más, hacelo a mano o subí " +
            "FREELANCER_DAILY_BID_CAP.",
        );
      }
      const result = await client.placeBid(args);
      bidsThisSession += 1;
      return ok({
        placed: true,
        bidId: result.id,
        bidsThisSession,
        dailyCap: DAILY_BID_CAP,
        url: `https://www.freelancer.com/projects/${args.projectId}`,
      });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "freelancer_send_message",
  {
    title: "Responder mensaje",
    description:
      "Envía una respuesta en un thread EXISTENTE. ACCIÓN DE ESCRITURA. REGLAS:\n" +
      "1) Llamala SOLO después de que el usuario aprobó el texto de la respuesta.\n" +
      "2) Respondé únicamente en threads donde un cliente ya te escribió; nunca " +
      "mandes mensajes en frío a desconocidos.\n" +
      "3) Escribí natural, con skills de copywriting, NUNCA robótico.",
    inputSchema: {
      threadId: z.number().int().positive().describe("id del thread a responder"),
      message: z.string().min(1).describe("Texto de la respuesta, ya aprobado por el usuario"),
    },
  },
  async ({ threadId, message }) => {
    try {
      await client.sendMessage(threadId, message);
      return ok({ sent: true, threadId });
    } catch (err) {
      return fail(err);
    }
  },
);

// --- Bootstrap ---------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // No imprimir a stdout: en stdio, stdout es el canal del protocolo MCP.
  process.stderr.write("freelancer-mcp listo (stdio)\n");
}

main().catch((err) => {
  process.stderr.write(`freelancer-mcp falló al arrancar: ${String(err)}\n`);
  process.exit(1);
});
