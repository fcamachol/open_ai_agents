import { hostedMcpTool, Agent, AgentInputItem, Runner, withTrace } from "@openai/agents";
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
    requireApproval: "never",
    serverUrl: "https://tools.fitcluv.com/mcp/9649689d-dd88-4bb8-b9f1-94b3d604ccda"
});

const mcp1 = hostedMcpTool({
    serverLabel: "mcp_v6",
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
    requireApproval: "always",
    serverUrl: "https://tools.fitcluv.com/mcp/9649689d-dd88-4bb8-b9f1-94b3d604ccda"
});

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
"fuga", "pagos", "hablar con asesor", "información", "consumos", "contrato", "tickets"

1. Any urgent water or sewer issue, loss of service, leaks, flooding, or request for a human advisor should route to fuga.
2. Any question about payments, debt, balance, consumption, billing, or how/where to pay should route to query.
3. Any other message should route to información.
4.- Any questions about contract should direct to the contract agent
5.- when someone wants to update an existing case send to tickets
6.- When a user asks to change their recibo to digital route to payments
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
    instructions: `You are an information agent for answering informational queries related to CEA Querétaro. 
Your aim is to provide clear, concise, and accurate responses to user questions. 
Use the policy below to assemble your answer. 
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
        temperature: 1,
        topP: 1,
        maxTokens: 2048,
        store: true
    }
});

const pagosAgent = new Agent({
    name: "Pagos Agent",
    instructions: `When a user has dudas about their contract ask for their contract number to get them.

when the user asks to pay a recibo:

1.- Get the recibo number (if you dont have it)
2.- Ask them if they want to pay online, or pay in a module.

If they ask to pay in a module give them the following information:

"Puedes pagar tu recibo en:
    - Oxxo 
    - Cajeros de la cea
    - En sucursal

When a user asks to change their recibo to digital, just confirm their email adress and say:

"Voy a cambiar tu recibo a digital ("recibo numero") y se enviará al correo: (correo) gracias por ayudarnos a ahorrar papel!"

#Do not get contracts by name, adress or any other data.
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

const consumosAgent = new Agent({
    name: "Consumos Agent",
    instructions: `You help people with their consumos, you need a contract number to get them if you already have it dont ask for it again.

Also ask for which month(s) they want to see`,
    model: "gpt-4.1",
    tools: [mcp],
    modelSettings: {
        temperature: 1,
        topP: 1,
        maxTokens: 2048,
        store: true
    }
});

const fugasAgent = new Agent({
    name: "Fugas Agent",
    instructions: `Eres un agente de la cea especializado en fugas, necesitas estos datos para poder ayudar a la persona. Pregunta una por una, si te da la foto no preguntes lo que ya sabes. Si en la foto se ve la gravedad de la fuga no la preguntes.

1.- Donde esta la fuga? (sugiere enviar su localizacion por whatsapp)
2.- 
(para los proximos dos puedes pedir una foto, si la foto te da lo que necesitas no lo preguntes nuevamente).
2.1- Me puedes decir si esta en via publica o en una cada? 
2.2- Que tan grave es la fuga?

Cuando tengas todo esto crea un ticket y dale el numero de ticket al usuario.

user_id: 00d7d94c-a0ac-4b55-8767-5a553d80b39a
folio: CEA-FUG-251226-0003
service_type: reportar_lectura
titulo: generalo tu`,
    model: "gpt-4.1",
    tools: [mcp],
    modelSettings: {
        temperature: 1,
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
    instructions: `You are a ticket handling agent you help users update tickets, give aditional context to existing tickets and close tickets.

to get active tickets use get_active_tickets`,
    model: "gpt-4.1",
    tools: [mcp1],
    modelSettings: {
        temperature: 1,
        topP: 1,
        maxTokens: 2048,
        store: true
    }
});

// Main workflow function
export const runWorkflow = async (workflow: WorkflowInput): Promise<WorkflowOutput> => {
    return await withTrace("Maria V1", async () => {
        const conversationHistory: AgentInputItem[] = [
            { role: "user", content: [{ type: "input_text", text: workflow.input_as_text }] }
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
        const classificationAgentResultTemp = await runner.run(
            classificationAgent,
            [...conversationHistory]
        );
        conversationHistory.push(...classificationAgentResultTemp.newItems.map((item) => item.rawItem));

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
            const result = await runner.run(fugasAgent, [...conversationHistory]);
            conversationHistory.push(...result.newItems.map((item) => item.rawItem));
            if (!result.finalOutput) throw new Error("Agent result is undefined");
            agentResult = { output_text: result.finalOutput ?? "" };
        } else if (classification === "hablar_asesor") {
            agentResult = { output_text: "Te conectaré con un asesor humano. Por favor espera un momento." };
        } else if (classification === "informacion") {
            const result = await runner.run(informationAgent, [...conversationHistory]);
            conversationHistory.push(...result.newItems.map((item) => item.rawItem));
            if (!result.finalOutput) throw new Error("Agent result is undefined");
            agentResult = { output_text: result.finalOutput ?? "" };
        } else if (classification === "pagos") {
            const result = await runner.run(pagosAgent, [...conversationHistory]);
            conversationHistory.push(...result.newItems.map((item) => item.rawItem));
            if (!result.finalOutput) throw new Error("Agent result is undefined");
            agentResult = { output_text: result.finalOutput ?? "" };
        } else if (classification === "consumos") {
            const result = await runner.run(consumosAgent, [...conversationHistory]);
            conversationHistory.push(...result.newItems.map((item) => item.rawItem));
            if (!result.finalOutput) throw new Error("Agent result is undefined");
            agentResult = { output_text: result.finalOutput ?? "" };
        } else if (classification === "contrato") {
            const result = await runner.run(contratosAgent, [...conversationHistory]);
            conversationHistory.push(...result.newItems.map((item) => item.rawItem));
            if (!result.finalOutput) throw new Error("Agent result is undefined");
            agentResult = { output_text: result.finalOutput ?? "" };
        } else if (classification === "tickets") {
            const result = await runner.run(ticketAgent, [...conversationHistory]);
            conversationHistory.push(...result.newItems.map((item) => item.rawItem));
            if (!result.finalOutput) throw new Error("Agent result is undefined");
            agentResult = { output_text: result.finalOutput ?? "" };
        }

        return {
            output_text: agentResult?.output_text ?? classificationAgentResult.output_text,
            classification
        };
    });
};
