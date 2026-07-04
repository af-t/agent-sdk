import * as editTool from './file/edit.js';
import * as findTool from './file/find.js';
import * as listTool from './file/list.js';
import * as readTool from './file/read.js';
import * as writeTool from './file/write.js';
import * as recallMemoryTool from './general/recall-memory.js';
import * as todoTool from './general/todo.js';
import * as bashTool from './system/bash.js';
import * as delegateTool from './system/delegate.js';
import * as jobsTool from './system/jobs.js';
import * as skillTool from './system/skill.js';
import * as wakeupTool from './system/wakeup.js';
import * as fetchTool from './web/fetch.js';
import * as searchTool from './web/search.js';

export const builtinTools = [
  editTool,
  findTool,
  listTool,
  readTool,
  writeTool,
  recallMemoryTool,
  todoTool,
  bashTool,
  delegateTool,
  jobsTool,
  skillTool,
  wakeupTool,
  fetchTool,
  searchTool,
].map((mod) => ({
  name: mod.name || mod.default?.name,
  description: mod.description || mod.default?.description,
  input_schema: mod.input_schema || mod.default?.input_schema,
  execute: mod.execute || mod.default?.execute,
}));
