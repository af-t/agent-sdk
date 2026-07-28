import { editFile } from './files/edit-file.js';
import { findFiles } from './files/find-files.js';
import { listFiles } from './files/list-files.js';
import { readFile } from './files/read-file.js';
import { writeFile } from './files/write-file.js';
import { recallMemory } from './tasks/recall-memory.js';
import { manageTodos } from './tasks/manage-todos.js';
import { runShell } from './system/run-shell.js';
import { delegateTask } from './system/delegate-task.js';
import { manageJobs } from './system/manage-jobs.js';
import { loadSkill } from './system/load-skill.js';
import { scheduleWakeup } from './system/schedule-wakeup.js';
import { fetchUrl } from './web/fetch-url.js';
import { searchWeb } from './web/search-web.js';

export const builtInTools = [readFile, writeFile, editFile, findFiles, listFiles];

const otherStaticTools = [
  manageTodos,
  recallMemory,
  fetchUrl,
  searchWeb,
  runShell,
  delegateTask,
  manageJobs,
  loadSkill,
  scheduleWakeup,
];

export function createBuiltinTools() {
  return [...builtInTools, ...otherStaticTools];
}
