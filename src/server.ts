import express from "express";
import { config } from "dotenv";
import { runWorkflow } from "./agent.js";
import type { ChatRequest, ChatResponse } from "./types.js";

// Load environment variables
config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Health check endpoint
app.get("/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Main chat endpoint for n8n
app.post("/api/chat", async (req, res) => {
    try {
        const { message, conversationId } = req.body as ChatRequest;

        if (!message) {
            return res.status(400).json({
                error: "Missing required field: message",
                response: "",
                conversationId: conversationId || crypto.randomUUID()
            } as ChatResponse);
        }

        console.log(`[${new Date().toISOString()}] Processing message: ${message.substring(0, 50)}...`);

        // Run the agent workflow
        const result = await runWorkflow({ input_as_text: message });

        const response: ChatResponse = {
            response: result.output_text || JSON.stringify(result),
            classification: result.classification,
            conversationId: conversationId || crypto.randomUUID()
        };

        console.log(`[${new Date().toISOString()}] Response classification: ${response.classification}`);

        return res.json(response);
    } catch (error) {
        console.error("Error processing chat request:", error);
        return res.status(500).json({
            error: error instanceof Error ? error.message : "Internal server error",
            response: "Lo siento, hubo un error procesando tu mensaje. Por favor intenta de nuevo.",
            conversationId: crypto.randomUUID()
        } as ChatResponse);
    }
});

// Webhook endpoint (alias for n8n compatibility)
app.post("/webhook", async (req, res) => {
    // Redirect to main chat endpoint
    req.url = "/api/chat";
    return app._router.handle(req, res, () => { });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 CEA Agent Server running on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/health`);
    console.log(`💬 Chat endpoint: http://localhost:${PORT}/api/chat`);
    console.log(`🔗 Webhook endpoint: http://localhost:${PORT}/webhook`);
});
