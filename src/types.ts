export interface ChatRequest {
    message: string;
    conversationId?: string;
}

export interface ChatResponse {
    response: string;
    classification?: string;
    conversationId: string;
    error?: string;
}

export interface WorkflowInput {
    input_as_text: string;
}

export interface WorkflowOutput {
    output_text?: string;
    classification?: string;
    safe_text?: string;
    pii?: { failed: boolean; detected_counts: string[] };
    moderation?: { failed: boolean; flagged_categories: string[] };
    jailbreak?: { failed: boolean };
    [key: string]: unknown;
}
