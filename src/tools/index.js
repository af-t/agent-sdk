import { editFile } from './files/edit-file.js';
import { findFiles } from './files/find-files.js';
import { listFiles } from './files/list-files.js';
import { readFile } from './files/read-file.js';
import { writeFile } from './files/write-file.js';
import * as recallMemoryTool from './general/recall-memory.js';
import * as todoTool from './general/todo.js';
import * as bashTool from './system/bash.js';
import * as delegateTool from './system/delegate.js';
import * as jobsTool from './system/jobs.js';
import * as skillTool from './system/skill.js';
import * as wakeupTool from './system/wakeup.js';
import * as fetchTool from './web/fetch.js';
import * as searchTool from './web/search.js';

export const builtInTools = [readFile, writeFile, editFile, findFiles, listFiles];

const otherStaticTools = [
  recallMemoryTool,
  todoTool,
  bashTool,
  delegateTool,
  jobsTool,
  wakeupTool,
  fetchTool,
  searchTool,
].map((mod) => ({
  name: mod.name || mod.default?.name,
  description: mod.description || mod.default?.description,
  inputSchema: mod.inputSchema || mod.default?.inputSchema,
  execute: mod.execute || mod.default?.execute,
}));

export function createBuiltinTools(skillRegistry) {
  return [...builtInTools, ...otherStaticTools, skillTool.createSkillTool(skillRegistry)];
}
