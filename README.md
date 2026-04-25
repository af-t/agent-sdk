# OpenRouter Agent

A minimal yet powerful AI agent SDK designed to interact with the OpenRouter API. This agent is built for CLI efficiency, featuring multimodal input support and a rich set of instructional tools for file management, terminal interaction, and web research.

## Key Features

- **Multimodal Input:** Supports both text and image-based prompts.
- **Persistent Terminal:** Maintains stateful shell sessions across multiple turns.
- **Instructional Toolset:** Tools are designed with imperative guidance to ensure the LLM uses them effectively and safely.
- **Comprehensive Capabilities:**
  - **File:** Find, List, Read, Edit, and Write files.
  - **Terminal:** Spawn, Read, Write, and Wait for shell processes.
  - **Web:** Fetch and clean content from URLs.
  - **System:** Delegate tasks to sub-agents.

## Installation

```bash
npm install
```

## Configuration

Create a `.env` file or export environment variables:

```bash
OPENROUTER_API_KEY=your_api_key
OPENROUTER_MODEL=google/gemini-3-flash-preview # or any other OpenRouter model
```

## Usage

### Basic Text Prompt
```javascript
import createAgent from './src/index.js';

const agent = await createAgent();
await agent.run("Summarize the files in the current directory.");
```

### Multimodal (Image) Prompt
```javascript
import createAgent from './src/index.js';

const agent = await createAgent();
await agent.run([
  { type: 'text', text: 'Describe this image:' },
  { type: 'image_url', image_url: { url: 'https://example.com/image.png' } }
]);
```

## Tool Reference

### File Tools
- **Find:** Search for files by name or content within a directory, respecting .gitignore rules. Use this to locate specific files or code snippets when the exact path is unknown.
- **List:** List files and directories at a specified path, respecting .gitignore rules. Use this to explore the project structure and discover available files and folders.
- **Read:** Read the contents of a file with pagination and line numbers. Use pagination (start_line/end_line) for large files to avoid context overflow and ensure efficient reading.
- **Edit:** Surgically update a file by replacing a specific text block or line range. Provide exact context to ensure the replacement is targeted, safe, and avoids unintended matches.
- **Write:** Create a new file or completely overwrite an existing one with full content. This tool will automatically create any missing parent directories.

### Terminal Tools
- **TerminalSpawn:** Start a new persistent shell session. Use this for tasks that require interactive shell access or persistent state across multiple turns.
- **TerminalRead:** Retrieve the current accumulated output from a terminal session. Use this to check the result of long-running commands or to inspect the current state of the terminal.
- **TerminalWrite:** Send input strings or commands to an active terminal session. Use this to interact with shell processes or CLI tools running in the terminal.
- **TerminalWait:** Register a background observer to watch for a specific pattern or idle timeout in a terminal session. Use this to synchronize with asynchronous processes.
- **TerminalDestroy:** Terminate an active shell session. Use this to clean up resources once a terminal-based task is finished or the session is no longer needed.

### Web & System
- **WebFetch:** Fetch and analyze content from a URL. Use this to retrieve documentation, research technical topics, or read raw code from the web. It automatically cleans HTML for readability.
- **Delegate:** Delegate a specific task to a specialized sub-agent. Use this for complex research, repetitive operations, or tasks with high-volume output to keep the main session history clean.
- **FinishTask:** Signal the completion of an assigned task. Call this tool to return a final summary and a list of artifacts (files created or modified) to the requester.

## License

MIT
