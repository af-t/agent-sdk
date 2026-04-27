import Agent from '../../core/agent.js';

export const name = 'Delegate';
export const description = 'Delegate a specific task to a specialized sub-agent. Use this for complex research, repetitive operations, or tasks with high-volume output to keep the main session history clean.';
export const input_schema = {
  type: 'object',
  properties: {
    task: { type: 'string', description: 'Specific instructions for the subagent' },
    context_files: { type: 'array', items: { type: 'string' }, description: 'Paths to files the subagent should read first' }
  },
  required: ['task']
};

export const execute = async ({ task, context_files }, { agent }) => {
  try {
    const subagentPrompt = `You are a specialized subagent. Your goal is to fulfill the task assigned by the Main Agent.
Shared Resources: You have FULL ACCESS to the Terminal, File, and Web tools.
Finalization: You MUST end your work by calling the 'Report' tool with a summary and a list of artifacts (files changed).
Context: The Main Agent and you share the same working directory and terminal sessions.`;

    const subagent = new Agent({
      apiKey: agent.apiKey,
      model: agent.model,
      tools: agent.tools,
      systemPrompt: subagentPrompt,
      isSubagent: true,
      tManager: agent.terminalManager,
      maxTokens: agent.max_tokens
    });

    let fullTask = task;
    if (context_files?.length) {
      fullTask = `I need you to work on these files: ${context_files.join(', ')}\n\nTask: ${task}`;
    }

    console.log(`[DELEGATE] Spawning subagent for task: ${task.slice(0, 50)}...`);
    const report = await subagent.run(fullTask);

    return `Summary: ${report.summary}\nData:` + '```json\n' + JSON.stringify(JSON.parse(report.data), null, 2) + '\n```';
  } catch (error) {
    return `Delegation failed: ${error.message}`;
  }
};
