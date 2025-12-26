# CEA Querétaro Agent Server

An Express.js server that hosts the CEA Querétaro customer service AI agent, designed for integration with n8n via webhook.

## 🚀 Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env and add your OPENAI_API_KEY
```

### 3. Run Development Server

```bash
npm run dev
```

### 4. Test the API

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hola, quiero pagar mi recibo"}'
```

## 📡 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| POST | `/api/chat` | Main chat endpoint |
| POST | `/webhook` | Alias for `/api/chat` |

### Request Format

```json
{
  "message": "Quiero consultar mi adeudo",
  "conversationId": "optional-session-id"
}
```

### Response Format

```json
{
  "response": "Agent response text...",
  "classification": "pagos",
  "conversationId": "session-id"
}
```

## 🔗 n8n Integration

### Using HTTP Request Node

1. Add an **HTTP Request** node in n8n
2. Configure:
   - **Method**: `POST`
   - **URL**: `https://your-domain.com/api/chat`
   - **Body Content Type**: `JSON`
   - **Body Parameters**:
     ```json
     {
       "message": "{{ $json.message }}"
     }
     ```

### Example Workflow

```
Webhook → HTTP Request (Agent) → Respond
```

## 🐳 Docker Deployment (Easypanel)

### Build and Run

```bash
docker build -t cea-agent .
docker run -p 3000:3000 -e OPENAI_API_KEY=sk-xxx cea-agent
```

### Easypanel Configuration

1. Create a new **App** in Easypanel
2. Choose **Dockerfile** as the source
3. Point to your Git repository
4. Add environment variables:
   - `OPENAI_API_KEY`: Your OpenAI API key
5. Set the port to `3000`
6. Deploy!

## 🤖 Agent Capabilities

The agent routes queries to specialized sub-agents:

| Classification | Agent | Purpose |
|----------------|-------|---------|
| `fuga` | Fugas Agent | Water leaks and emergencies |
| `pagos` | Pagos Agent | Payment inquiries |
| `consumos` | Consumos Agent | Usage/consumption data |
| `contrato` | Contratos Agent | Contract management |
| `tickets` | Ticket Agent | Ticket updates |
| `informacion` | Information Agent | General queries |
| `hablar_asesor` | - | Human handoff |

## 📝 License

Private - CEA Querétaro
