import { hostedMcpTool, Agent, AgentInputItem, Runner, withTrace, tool } from "@openai/agents";
import { OpenAI } from "openai";
import { z } from "zod";
import type { WorkflowInput, WorkflowOutput } from "./types.js";

// Tool definitions
const mcp = hostedMcpTool({
    serverLabel: "mcp_v1_7",
    allowedTools: [
        "get_conceptos_cea",
        "get_tarifa_contrato",
        "get_deuda",
        "get_contract_details",
        "get_consumo",
        "get_client_tickets",
        "get_available_agent",
        "get_active_tickets",
        "Crear_Customer",
        "Buscar_Customer_Por_Contrato",
        "Crear_ticket"
    ],
    // Try both casing styles to be safe
    requireApproval: "never",
    // @ts-ignore
    require_approval: "never",
    serverUrl: "https://tools.fitcluv.com/mcp/9649689d-dd88-4bb8-b9f1-94b3d604ccda"
});

// Standalone ticket creation function
async function performCreateTicket({ service_type, titulo, descripcion, contract_number, email, ubicacion }: {
    service_type: string,
    titulo: string,
    descripcion: string,
    contract_number: string | null,
    email: string | null,
    ubicacion: string | null
}) {
    try {
        // Generate a local folio FIRST as a fallback
        const localFolio = generateTicketId(service_type as keyof typeof TICKET_TYPES);

        // Prepare ticket data WITHOUT folio - let Supabase auto-generate it (but we have our local fallback)
        const ticketData: any = {
            user_id: "00d7d94c-a0ac-4b55-8767-5a553d80b39a",
            service_type,
            titulo,
            descripcion,
            status: "abierto"
        };

        if (contract_number) ticketData.contract_number = contract_number;
        if (email) ticketData.email = email;
        if (ubicacion) ticketData.ubicacion = ubicacion;

        console.log(`[TICKET] Creating ticket in MCP:`, ticketData);

        // Call MCP Crear_ticket to persist the ticket and get auto-generated folio
        let folio = localFolio; // Default to local folio
        try {
            const mcpResponse = await fetch("https://tools.fitcluv.com/mcp/9649689d-dd88-4bb8-b9f1-94b3d604ccda", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json, text/event-stream"
                },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    method: "tools/call",
                    params: {
                        name: "Crear_ticket",
                        arguments: ticketData
                    },
                    id: Date.now()
                })
            });

            const mcpResult = await mcpResponse.json();
            console.log(`[TICKET] MCP response:`, JSON.stringify(mcpResult, null, 2));

            if (mcpResult.error) {
                console.error(`[TICKET] MCP error:`, mcpResult.error);
                // We'll use the local folio if MCP fails
            } else if (mcpResult.result && mcpResult.result.content) {
                // Extract folio from the MCP response
                const content = mcpResult.result.content;
                if (Array.isArray(content) && content[0]?.text) {
                    const textContent = content[0].text;
                    const folioMatch = textContent.match(/folio[:\s]+([A-Z0-9\-]+)/i);
                    if (folioMatch) {
                        folio = folioMatch[1];
                        console.log(`[TICKET] Using MCP-generated folio: ${folio}`);
                    }
                }
            }
        } catch (mcpError) {
            console.error(`[TICKET] Failed to call MCP:`, mcpError);
            // Use local folio as fallback
        }

        console.log(`[TICKET] Ticket created with final folio: ${folio}`);

        return {
            success: true,
            folio,
            message: `Ticket created successfully with folio ${folio}`
        };
    } catch (error) {
        console.error("[TICKET] Error creating ticket:", error);
        return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
            message: "Error creating ticket"
        };
    }
}

// Custom ticket creation tool
const createTicketTool = tool({
    name: "create_cea_ticket",
    description: "Creates a ticket in the CEA system and returns the generated folio number. Use this instead of Crear_ticket to ensure you get the folio before responding to the user.",
    parameters: z.object({
        service_type: z.enum(["fuga", "aclaraciones", "pagos", "lecturas", "revision_recibo", "recibo_digital", "urgente"]).describe("Type of ticket"),
        titulo: z.string().describe("Title of the ticket"),
        descripcion: z.string().describe("Detailed description of the issue"),
        contract_number: z.string().nullable().describe("Contract number if applicable").default(null),
        email: z.string().nullable().describe("Email if applicable").default(null),
        ubicacion: z.string().nullable().describe("Location if applicable").default(null)
    }),
    execute: async (args) => {
        return performCreateTicket(args);
    }
});

// Ticket type mapping
const TICKET_TYPES = {
    fuga: "FUG",
    aclaraciones: "ACL",
    pagos: "PAG",
    lecturas: "LEC",
    revision_recibo: "REV",
    recibo_digital: "DIG",
    urgente: "URG"
} as const;

// Ticket counter store (in-memory, resets on restart)
// Format: Map<"YYMMDD-TYPE", number>
const ticketCounterStore = new Map<string, number>();

/**
 * Generates a ticket ID following the nomenclature: CEA-[TYPE]-[YYMMDD]-[NNNN]
 * @param ticketType - The type of ticket (fuga, pagos, aclaraciones, etc.)
 * @returns The generated ticket ID
 */
export function generateTicketId(ticketType: keyof typeof TICKET_TYPES): string {
    const typeCode = TICKET_TYPES[ticketType];

    // Get current date in Mexico City timezone
    const now = new Date();
    const mexicoDate = new Date(now.toLocaleString("en-US", { timeZone: "America/Mexico_City" }));

    // Format date as YYMMDD
    const year = mexicoDate.getFullYear().toString().slice(-2);
    const month = String(mexicoDate.getMonth() + 1).padStart(2, '0');
    const day = String(mexicoDate.getDate()).padStart(2, '0');
    const dateStr = `${year}${month}${day}`;

    // Generate counter key
    const counterKey = `${dateStr}-${typeCode}`;

    // Get and increment counter
    const currentCount = ticketCounterStore.get(counterKey) || 0;
    const newCount = currentCount + 1;
    ticketCounterStore.set(counterKey, newCount);

    // Format counter as 4-digit number
    const counterStr = String(newCount).padStart(4, '0');

    // Generate final ticket ID
    return `CEA-${typeCode}-${dateStr}-${counterStr}`;
}

// Shared client for guardrails (lazy initialization)
let _client: OpenAI | null = null;
const getClient = () => {
    if (!_client) {
        _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    return _client;
};

// Guardrails definitions
const jailbreakGuardrailConfig = {
    guardrails: [
        { name: "Jailbreak", config: { model: "gpt-5-nano", confidence_threshold: 0.7 } }
    ]
};

// Note: @openai/guardrails is not a public package yet
// For now, we'll implement a simplified version
async function runGuardrails(text: string, config: any, context: any, flag: boolean): Promise<any[]> {
    // Placeholder - implement when guardrails package is available
    return [];
}

// Simple in-memory conversation store
const conversationStore = new Map<string, AgentInputItem[]>();

// Helper to handle interruptions (approvals)
async function runWithAutoApproval(runner: any, agent: any, history: AgentInputItem[]) {
    let currentHistory = [...history];
    let result = await runner.run(agent, currentHistory);

    let loops = 0;
    while (result.currentStep?.type === "next_step_interruption" && loops < 5) {
        console.log(`[AutoApproval] Interruption detected (loop ${loops})`);
        loops++;
        const interruptions = result.currentStep.data.interruptions;
        let hasApprovals = false;
        const approvedItems: any[] = [];
        const approvedIds = new Set<string>();

        for (const item of interruptions) {
            if (item.type === "tool_approval_item") {
                console.log(`[AutoApproval] Approving item: ${item.rawItem.name} (${item.rawItem.id})`);
                hasApprovals = true;
                approvedItems.push({
                    ...item.rawItem,
                    status: "completed"
                });
                approvedIds.add(item.rawItem.id);
            }
        }

        if (!hasApprovals) break;

        // Filter out the in_progress items from newItems that we are about to approve
        const newItemsToPush = result.newItems
            .map((i: any) => i.rawItem)
            .filter((item: any) => !approvedIds.has(item.id));

        // Add generated items (excluding ones we just approved) + approvals to history
        currentHistory.push(...newItemsToPush);
        currentHistory.push(...approvedItems);

        result = await runner.run(agent, currentHistory);
    }

    if (loops >= 5) {
        console.warn("[AutoApproval] Reached max loops limit!");
    }

    return result;
}

const getAgentOutput = (result: any) => {
    if (result.finalOutput) return result.finalOutput;

    // Try to find last assistant message in newItems
    const lastItem = result.newItems[result.newItems.length - 1]?.rawItem;
    if (lastItem?.role === 'assistant') {
        if (typeof lastItem.content === 'string') return lastItem.content;
        if (Array.isArray(lastItem.content)) {
            return lastItem.content.map((c: any) => c.text || '').join('');
        }
    }
    return null;
};

function guardrailsHasTripwire(results: any[]): boolean {
    return (results ?? []).some((r) => r?.tripwireTriggered === true);
}

function getGuardrailSafeText(results: any[], fallbackText: string): string {
    for (const r of results ?? []) {
        if (r?.info && ("checked_text" in r.info)) {
            return r.info.checked_text ?? fallbackText;
        }
    }
    const pii = (results ?? []).find((r) => r?.info && "anonymized_text" in r.info);
    return pii?.info?.anonymized_text ?? fallbackText;
}

async function scrubConversationHistory(history: any[], piiOnly: any): Promise<void> {
    for (const msg of history ?? []) {
        const content = Array.isArray(msg?.content) ? msg.content : [];
        for (const part of content) {
            if (part && typeof part === "object" && part.type === "input_text" && typeof part.text === "string") {
                const res = await runGuardrails(part.text, piiOnly, { guardrailLlm: getClient() }, true);
                part.text = getGuardrailSafeText(res, part.text);
            }
        }
    }
}

async function scrubWorkflowInput(workflow: any, inputKey: string, piiOnly: any): Promise<void> {
    if (!workflow || typeof workflow !== "object") return;
    const value = workflow?.[inputKey];
    if (typeof value !== "string") return;
    const res = await runGuardrails(value, piiOnly, { guardrailLlm: getClient() }, true);
    workflow[inputKey] = getGuardrailSafeText(res, value);
}

async function runAndApplyGuardrails(inputText: string, config: any, history: any[], workflow: any) {
    const guardrails = Array.isArray(config?.guardrails) ? config.guardrails : [];
    const results = await runGuardrails(inputText, config, { guardrailLlm: getClient() }, true);
    const shouldMaskPII = guardrails.find((g: any) => (g?.name === "Contains PII") && g?.config && g.config.block === false);
    if (shouldMaskPII) {
        const piiOnly = { guardrails: [shouldMaskPII] };
        await scrubConversationHistory(history, piiOnly);
        await scrubWorkflowInput(workflow, "input_as_text", piiOnly);
        await scrubWorkflowInput(workflow, "input_text", piiOnly);
    }
    const hasTripwire = guardrailsHasTripwire(results);
    const safeText = getGuardrailSafeText(results, inputText) ?? inputText;
    return { results, hasTripwire, safeText, failOutput: buildGuardrailFailOutput(results ?? []), passOutput: { safe_text: safeText } };
}

function buildGuardrailFailOutput(results: any[]) {
    const get = (name: string) => (results ?? []).find((r: any) => ((r?.info?.guardrail_name ?? r?.info?.guardrailName) === name));
    const pii = get("Contains PII"), mod = get("Moderation"), jb = get("Jailbreak"), hal = get("Hallucination Detection"), nsfw = get("NSFW Text"), url = get("URL Filter"), custom = get("Custom Prompt Check"), pid = get("Prompt Injection Detection");
    const piiCounts = Object.entries(pii?.info?.detected_entities ?? {}).filter(([, v]) => Array.isArray(v)).map(([k, v]) => k + ":" + (v as any[]).length);
    return {
        pii: { failed: (piiCounts.length > 0) || pii?.tripwireTriggered === true, detected_counts: piiCounts },
        moderation: { failed: mod?.tripwireTriggered === true || ((mod?.info?.flagged_categories ?? []).length > 0), flagged_categories: mod?.info?.flagged_categories },
        jailbreak: { failed: jb?.tripwireTriggered === true },
        hallucination: { failed: hal?.tripwireTriggered === true, reasoning: hal?.info?.reasoning, hallucination_type: hal?.info?.hallucination_type, hallucinated_statements: hal?.info?.hallucinated_statements, verified_statements: hal?.info?.verified_statements },
        nsfw: { failed: nsfw?.tripwireTriggered === true },
        url_filter: { failed: url?.tripwireTriggered === true },
        custom_prompt_check: { failed: custom?.tripwireTriggered === true },
        prompt_injection: { failed: pid?.tripwireTriggered === true },
    };
}

// Agent Schemas
const ClassificationAgentSchema = z.object({
    classification: z.enum(["fuga", "pagos", "hablar_asesor", "informacion", "consumos", "contrato", "tickets"])
});

// Agent Definitions
const classificationAgent = new Agent({
    name: "Classification agent",
    instructions: `Classify the user's intent into one of the following categories:
"fuga", "pagos", "hablar_asesor", "informacion", "consumos", "contrato", "tickets"

1. Any urgent water or sewer issue, loss of service, leaks, flooding, or request for a human advisor should route to fuga.
2. Any question about payments, debt, balance, billing, or how/where to pay should route to pagos.
3. Any question about water consumption or meter readings should route to consumos.
4. Any questions about contracts (new or changes) should route to contrato.
5. When someone wants to update an existing case or check ticket status, route to tickets.
6. When a user asks to change their recibo to digital, route to pagos.
7. Any other informational message should route to informacion.
`,
    model: "gpt-4.1-mini",
    outputType: ClassificationAgentSchema,
    modelSettings: {
        temperature: 1,
        topP: 1,
        maxTokens: 2048,
        store: true
    }
});

const informationAgent = new Agent({
    name: "Information agent",
    instructions: `You are María, the information agent for CEA Querétaro.
    You provide general information about services, processes, and policies.

    IMPORTANT:
    - Keep responses brief and to the point. One question maximum per response.
    - You are NOT a test agent. You are a live production assistant.
    - NEVER say you cannot access account data or give privacy disclaimers.
    - If someone asks about their specific account/debt/consumption, those queries should have been routed to specialized agents.

    CAPABILITIES / WHAT CAN I DO:
    If a user asks "what can you help with?", "what do you do?", or similar, provide this brief summary:
    "Soy María, tu asistente virtual de la CEA. Puedo ayudarte con:
    💧 Consultar tu saldo y realizar pagos
    📊 Ver tu historial de consumos
    🚨 Reportar fugas
    🎫 Gestionar y dar seguimiento a tus tickets
    ℹ️ Información general sobre trámites y servicios"

    Use the policy below to assemble your answer for other general questions.
    Do not speculate or invent information. If the information is not covered, say so clearly and guide the user to the correct process.
    
    Agent Name: María  
    Organization: CEA Querétaro  
    Industry: Public Water & Sanitation Services  
    Region: Querétaro, México  
    
    📋 Policy Summary: Atención Informativa a Usuarios CEA  
    Policy ID: CEA-INF-2025-01  
    Effective Date: January 1, 2025  
    Applies To: Usuarios domésticos y comerciales de CEA Querétaro  
    
    Purpose:  
    Proporcionar información clara y confiable sobre pagos, consumo, contratos, recibos y servicios generales de CEA, sin levantar reportes ni gestionar emergencias.

---

💰 Pagos, Adeudos y Recibos  
Billing Cycle: Mensual, según fecha de activación del contrato.  

Información que puedes brindar:
- Consulta de adeudos y saldo pendiente.
- Explicación de conceptos del recibo (consumo, cargos, periodos).
- Fechas límite de pago.
- Consecuencias de atraso en el pago (recargos, suspensión).

Formas de pago:
- Pago en línea.
- Bancos y establecimientos autorizados.
- Oficinas de atención CEA.

CS Rep Tip:  
Aclara que los pagos pueden tardar en reflejarse hasta 48 horas hábiles y que es importante conservar el comprobante.

---

📊 Consumo y Lecturas  
Información disponible:
- Cómo se calcula el consumo.
- Diferencia entre consumo estimado y lectura real.
- Qué hacer si el consumo parece inusualmente alto.

Limitación:  
No confirmes errores de lectura ni ajustes de cobro; en esos casos informa que se debe levantar un reporte.

CS Rep Tip:  
Sugiere revisar instalaciones internas antes de asumir un error del recibo.

---

📄 Contratos y Cuenta  
Información que puedes brindar:
- Qué es el número de contrato.
- Dónde encontrar el número de contrato en el recibo.
- Requisitos generales para alta de contrato nuevo.
- Requisitos generales para cambio de titular.

Limitación:  
No realices cambios de contrato ni validaciones de identidad.

---

🏢 Oficinas, Horarios y Canales de Atención  
Información disponible:
- Ubicación de oficinas de atención.
- Horarios de servicio.
- Canales oficiales (teléfono, portal, oficinas).

---

⚠️ Qué NO debes hacer como agente de información  
- No levantes reportes.
- No confirmes emergencias.
- No prometas ajustes, descuentos o condonaciones.
- No solicites datos sensibles innecesarios.
- No confirmes estatus de reportes sin folio.

Si el usuario requiere cualquiera de lo anterior, informa que será canalizado al área correspondiente.

---

🧾 Estilo de Respuesta de María  
- Tono: Cálido, profesional y empático.  
- Idioma: Español mexicano (tuteo respetuoso).  
- Claridad: Respuestas breves y directas.  
- Preguntas: Máximo una pregunta solo si es estrictamente necesaria.  
- Emojis: Máximo uno por mensaje (💧 preferido).

---

🧠 Example  
User: "¿Dónde puedo pagar mi recibo?"  
Response:  
"Puedes pagar tu recibo de CEA en línea, en bancos autorizados o directamente en oficinas de atención 💧  
Si quieres, dime tu colonia y te digo cuál es la oficina más cercana."
`,
    model: "gpt-4.1-mini",
    tools: [mcp],
    modelSettings: {
        temperature: 0.7,
        topP: 1,
        maxTokens: 2048,
        store: true
    }
});

const pagosAgent = new Agent({
    name: "Pagos Agent",
    instructions: `You help users with payment-related queries and digital receipt changes.

IMPORTANT: Be concise. Ask ONE question at a time only when necessary.

PAYMENT ASSISTANCE:
1. Get contract number to check balance/debt
2. For payment options, provide:
   "Puedes pagar tu recibo en:
   - Oxxo
   - Cajeros de la CEA
   - En sucursal
   - En línea"

DIGITAL RECEIPT CHANGE:
When user requests digital receipt:
1. Confirm email and contract number
2. Create ticket with create_cea_ticket:
   - service_type: "recibo_digital"
   - titulo: "Cambio a recibo digital - Contrato [numero]"
   - descripcion: Contract number and email
   - contract_number: [numero]
   - email: [email]
3. The tool returns the folio. Use it in your response: "He creado tu solicitud con folio [FOLIO]. Tu recibo se enviará a: [email]. ¡Gracias por ahorrar papel!"

PAYMENT ISSUES:
For disputes, create ticket with create_cea_ticket using service_type: "pagos"

Do not retrieve contracts by name or address - contract number only.`,
    model: "gpt-4.1",
    tools: [mcp, createTicketTool],
    modelSettings: {
        temperature: 0.7,
        topP: 1,
        maxTokens: 2048,
        store: true
    }
});

const consumosAgent = new Agent({
    name: "Consumos Agent",
    instructions: `You help users check their water consumption.

IMPORTANT: Be concise. Ask ONE question at a time.

WORKFLOW:
1. Get contract number (if not already provided)
2. Ask which month(s) they want to see
3. Use tools to retrieve and display consumption data

DISPUTES:
If user disputes consumption or suspects meter reading error:
1. Gather: contract number, month(s), specific issue
2. Create ticket with create_cea_ticket:
   - service_type: "lecturas" (meter issues) OR "revision_recibo" (receipt review) OR "aclaraciones" (clarifications)
   - titulo: "Revisión de lectura - Contrato [numero] - [mes]"
   - descripcion: All dispute details
   - contract_number: [numero]
3. The tool returns the folio. Include it in your response to the user.`,
    model: "gpt-4.1",
    tools: [mcp, createTicketTool],
    modelSettings: {
        temperature: 0.7,
        topP: 1,
        maxTokens: 2048,
        store: true
    }
});

const fugasAgent = new Agent({
    name: "Fugas Agent",
    instructions: `Eres un agente especializado en reportar fugas de agua.

IMPORTANTE: Pregunta UNA cosa a la vez. Si recibes foto, úsala y no preguntes lo obvio.

INFORMACIÓN NECESARIA:
1. Ubicación de la fuga (sugiere compartir ubicación por WhatsApp)
2. ¿Vía pública o dentro de casa? (puedes pedir foto)
3. Gravedad de la fuga (si no es evidente en foto)

CREAR TICKET:
Cuando tengas toda la info, usa create_cea_ticket:
- service_type: "fuga"
- titulo: Título descriptivo (ej: "Fuga en vía pública - [ubicación]")
- descripcion: Todos los detalles (ubicación, gravedad, tipo de vía)
- ubicacion: La ubicación exacta

El tool te devolverá el folio generado. DEBES incluir ese folio en tu respuesta al usuario.
Ejemplo: "He creado tu reporte con el folio CEA-FUG-251226-0001. Un técnico se pondrá en contacto contigo pronto."

NO pidas número de contrato para fugas.`,
    model: "gpt-4.1",
    tools: [mcp, createTicketTool],
    modelSettings: {
        temperature: 0.7,
        topP: 1,
        maxTokens: 2048,
        store: true
    }
});

const contratosAgent = new Agent({
    name: "contratos agent",
    instructions: `You help clients with their contracts, if not clear ask if its a new contract or a change of contract.

For a new contract ask for:
1.- Identificacion Oficial
2.- Documento que acredite la propiedad del predio
3.- Carta poder simple (de no ser el propietario)

El costo del tramite es de $175 + IVA

If the user wants to make a change to the contract:

1.- Ask for contract number
2.- Ask for documento que acredite la propiedad 
3.- Identificacion Oficial

`,
    model: "gpt-4.1",
    tools: [mcp],
    modelSettings: {
        temperature: 1,
        topP: 1,
        maxTokens: 2048,
        store: true
    }
});

const ticketAgent = new Agent({
    name: "ticket agent",
    instructions: `You are a ticket handling agent. You help users view, update, and manage their tickets.

WORKFLOW:
1. Ask for contract number if you don't have it
2. Use get_client_tickets or get_active_tickets to retrieve tickets
3. Display ticket information clearly with folio, status, and description
4. Help with updates or additional context as needed

TICKET LOOKUP:
- First try: Use Buscar_Customer_Por_Contrato with the contract number to get customer ID
- Then use: get_client_tickets with the customer ID to retrieve all tickets
- Alternative: Use get_active_tickets with filter "contract_number=eq.XXXXXX&status=eq.abierto"

IMPORTANT:
- Do NOT narrate your search process ("intentando variantes", "probando método X")
- Try methods silently and only respond to user once you have results
- If you can't find tickets, simply say "No encontré tickets para este contrato"
- Be concise and direct in your responses

Display tickets in this format:
📋 Ticket: [folio]
Estado: [status]
Tipo: [service_type]
Descripción: [description]`,
    model: "gpt-4.1",
    tools: [mcp],
    modelSettings: {
        temperature: 0.7,
        topP: 1,
        maxTokens: 2048,
        store: true
    }
});

// Main workflow function
export const runWorkflow = async (workflow: WorkflowInput): Promise<WorkflowOutput> => {
    return await withTrace("Maria V1", async () => {
        // Retrieve existing history or start fresh
        const previousHistory = (workflow.conversationId && conversationStore.get(workflow.conversationId)) || [];

        const now = new Date().toLocaleString("es-MX", { timeZone: "America/Mexico_City" });
        const inputWithContext = `[Contexto: La fecha y hora actual es ${now}]\n\n${workflow.input_as_text} `;

        const conversationHistory: AgentInputItem[] = [
            ...previousHistory,
            { role: "user", content: [{ type: "input_text", text: inputWithContext }] }
        ];

        const runner = new Runner({
            traceMetadata: {
                __trace_source__: "agent-builder",
                workflow_id: "wf_6949ac7ebe5c81908bc6bd6ed1872b9300743e4da0338dff"
            }
        });

        const guardrailsInputText = workflow.input_as_text;
        const { hasTripwire: guardrailsHasTripwire, failOutput: guardrailsFailOutput, passOutput: guardrailsPassOutput } =
            await runAndApplyGuardrails(guardrailsInputText, jailbreakGuardrailConfig, conversationHistory, workflow);

        if (guardrailsHasTripwire) {
            return guardrailsFailOutput;
        }

        // Run classification
        const classificationAgentResultTemp = await runWithAutoApproval(
            runner,
            classificationAgent,
            [...conversationHistory]
        );

        // Log new items for debugging "2 messages" issue
        console.log(`[DEBUG] Classification result items:`, JSON.stringify(classificationAgentResultTemp.newItems.map((i: any) => i.rawItem), null, 2));

        // Only push classification to history if it's not a message (to avoid double-responding)
        const classificationItems = classificationAgentResultTemp.newItems
            .map((item: any) => item.rawItem)
            .filter((item: any) => item.role !== 'assistant' || (typeof item.content !== 'string' && !Array.isArray(item.content)));

        conversationHistory.push(...classificationItems);

        if (!classificationAgentResultTemp.finalOutput) {
            throw new Error("Agent result is undefined");
        }

        const classificationAgentResult = {
            output_text: JSON.stringify(classificationAgentResultTemp.finalOutput),
            output_parsed: classificationAgentResultTemp.finalOutput
        };

        const classification = classificationAgentResult.output_parsed.classification;
        let agentResult: { output_text: string } | undefined;

        // Route to appropriate agent
        if (classification === "fuga") {
            const result = await runWithAutoApproval(runner, fugasAgent, [...conversationHistory]);
            conversationHistory.push(...result.newItems.map((item: any) => item.rawItem));
            const output = getAgentOutput(result);
            if (!output) throw new Error(`Agent result is undefined.Result: ${JSON.stringify(result)} `);
            agentResult = { output_text: output };
        } else if (classification === "hablar_asesor") {
            // Create urgent ticket for human advisor
            try {
                const ticketResult = await performCreateTicket({
                    service_type: "urgente",
                    titulo: "Solicitud de asesor humano",
                    descripcion: `Usuario solicitó hablar con un asesor humano. Mensaje: ${workflow.input_as_text}`,
                    contract_number: null,
                    email: null,
                    ubicacion: null
                });

                const folio = ticketResult.success ? ticketResult.folio : "PENDING";
                agentResult = {
                    output_text: `He creado tu solicitud con el folio ${folio}. Te conectaré con un asesor humano. Por favor espera un momento.`
                };
            } catch (error) {
                console.error("[HABLAR_ASESOR] Error creating urgent ticket:", error);
                agentResult = {
                    output_text: "Te conectaré con un asesor humano. Por favor espera un momento."
                };
            }
        } else if (classification === "informacion") {
            const result = await runWithAutoApproval(runner, informationAgent, [...conversationHistory]);
            conversationHistory.push(...result.newItems.map((item: any) => item.rawItem));
            const output = getAgentOutput(result);
            if (!output) throw new Error(`Agent result is undefined.Result: ${JSON.stringify(result)} `);
            agentResult = { output_text: output };
        } else if (classification === "pagos") {
            const result = await runWithAutoApproval(runner, pagosAgent, [...conversationHistory]);
            conversationHistory.push(...result.newItems.map((item: any) => item.rawItem));
            const output = getAgentOutput(result);
            if (!output) throw new Error(`Agent result is undefined.Result: ${JSON.stringify(result)} `);
            agentResult = { output_text: output };
        } else if (classification === "consumos") {
            const result = await runWithAutoApproval(runner, consumosAgent, [...conversationHistory]);
            conversationHistory.push(...result.newItems.map((item: any) => item.rawItem));
            const output = getAgentOutput(result);
            if (!output) throw new Error(`Agent result is undefined.Result: ${JSON.stringify(result)} `);
            agentResult = { output_text: output };
        } else if (classification === "contrato") {
            const result = await runWithAutoApproval(runner, contratosAgent, [...conversationHistory]);
            conversationHistory.push(...result.newItems.map((item: any) => item.rawItem));
            const output = getAgentOutput(result);
            if (!output) throw new Error(`Agent result is undefined.Result: ${JSON.stringify(result)} `);
            agentResult = { output_text: output };
        } else if (classification === "tickets") {
            const result = await runWithAutoApproval(runner, ticketAgent, [...conversationHistory]);

            // Log new items for debugging "2 messages" issue
            console.log(`[DEBUG] Specialized agent (${classification}) result items:`, JSON.stringify(result.newItems.map((i: any) => i.rawItem), null, 2));

            conversationHistory.push(...result.newItems.map((item: any) => item.rawItem));
            const output = getAgentOutput(result);
            if (!output) throw new Error(`Agent result is undefined.Result: ${JSON.stringify(result)} `);
            agentResult = { output_text: output };
        }

        // Save updated history
        if (workflow.conversationId) {
            conversationStore.set(workflow.conversationId, conversationHistory);
        }

        const finalOutputText = agentResult?.output_text ?? classificationAgentResult.output_text;

        console.log('[DEBUG] ====== WORKFLOW COMPLETE ======');
        console.log('[DEBUG] Classification:', classification);
        console.log('[DEBUG] Final output_text length:', finalOutputText?.length || 0);
        console.log('[DEBUG] Final output_text:', finalOutputText);
        console.log('[DEBUG] Conversation history length:', conversationHistory.length);
        console.log('[DEBUG] ================================');

        return {
            output_text: finalOutputText,
            classification
        };
    });
};
