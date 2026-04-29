# OpenRouter Agent

A minimal yet powerful AI agent SDK designed to interact with the OpenRouter API using OpenAI-compatible payloads. This agent is built for CLI efficiency, featuring broad multimodal input support, a rich set of instructional tools, and native support for the Model Context Protocol (MCP).

## Key Features

- **OpenAI Compatible:** Uses the standard `/chat/completions` payload, making it compatible with the widest range of models and modalities.
- **Multimodal Input:** Supports text, images (`image_url`), and other OpenAI-supported modalities.
- **Smart Caching:** Built-in support for OpenRouter's Prompt Caching (`cache_control`). System instructions and the latest user messages are automatically cached to reduce latency and costs.
- **Persistent Terminal:** Maintains stateful shell sessions across multiple turns.
- **Model Context Protocol (MCP):** Connect to external MCP servers to extend agent capabilities with custom tools and resources.
- **Native Implementation:** Lightweight and efficient; MCP client is implemented natively without external SDK dependencies.
- **Instructional Toolset:** Tools are designed with imperative guidance to ensure the LLM uses them effectively and safely.

## Installation

```bash
npm install
```

## Configuration

Create a `.env` file or export environment variables:

```bash
OPENROUTER_API_KEY=your_api_key
OPENROUTER_MODEL=google/gemini-3-flash-preview # or any other OpenRouter model
OPENROUTER_MAX_TOKENS=4096 # Optional: limit output tokens
```

## Usage

### Basic Text Prompt
```javascript
import createAgent from './src/index.js';

const agent = await createAgent();
await agent.run("Summarize the files in the current directory.");
```

### Using MCP Servers
Extend your agent's capabilities by connecting to external MCP servers:

```javascript
import createAgent from './src/index.js';

const agent = await createAgent();

// Connect to an MCP server (e.g., SQLite)
await agent.tools.connectMcpServer({
  name: "sqlite",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-sqlite", "--db", "./data.db"]
});

await agent.run("What are the tables in my database?");
```

### Multimodal (Image) Prompt
The SDK uses the standard OpenAI content part format.
```javascript
import createAgent from './src/index.js';

const agent = await createAgent();
await agent.run([
  { type: 'text', text: 'Describe this image:' },
  { 
    type: 'image_url', 
    image_url: { 
      url: 'https://example.com/image.png' 
    } 
  }
]);
```

## Prompt Caching (OpenRouter)

The agent automatically manages `cache_control` for you:
- **System Prompt:** Automatically marked with `cache_control: { type: 'ephemeral' }`.
- **Context:** The last user message in each turn is automatically cached to optimize multi-turn conversations.

## Tool Reference

### File Tools
- **Find:** Search for files by name or content. Respects `.gitignore`.
- **List:** Explore project structure and discover available files.
- **Read:** Read file contents with pagination and line numbers.
- **Edit:** Surgically update a file by replacing a specific text block.
- **Write:** Create or completely overwrite a file.

### Terminal Tools
- **TerminalSpawn:** Start a new persistent shell session.
- **TerminalRead:** Retrieve current output from a session.
- **TerminalWrite:** Send commands to an active terminal.
- **TerminalWait:** Wait for specific patterns or idle timeout.
- **TerminalDestroy:** Clean up active shell sessions.

### Web & System
- **WebFetch:** Fetch and clean HTML content from any URL.
- **Delegate:** Spawn sub-agents for specialized or high-volume tasks.
- **Report:** Return final summary and data to the requester.

### Store Tools (Context Management)
- **StoreSet/Get/List/Rm:** Manage short-term key-value context for subagent operations.

## License

MIT
