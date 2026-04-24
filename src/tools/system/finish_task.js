export const name = 'FinishTask';
export const description = 'Signal the completion of an assigned task. Call this tool to return a final summary and a list of artifacts (files created or modified) to the requester.';
export const input_schema = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Executive summary of work performed' },
    artifacts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          status: { type: 'string', enum: ['created', 'modified', 'deleted'] }
        }
      },
      description: 'List of files created or modified'
    }
  },
  required: ['summary', 'artifacts']
};

export const execute = async (args) => {
  return "SUCCESS: Reporting back to Main Agent.";
};
