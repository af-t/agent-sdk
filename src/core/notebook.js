const ANSI_RE = /\[[0-9;]*m/g;

function joinSource(source) {
  if (Array.isArray(source)) return source.join('');
  return source ?? '';
}

function stripAnsi(str) {
  return str.replace(ANSI_RE, '');
}

function renderOutput(output) {
  if (output.output_type === 'stream') {
    return joinSource(output.text);
  }
  if (output.output_type === 'execute_result' || output.output_type === 'display_data') {
    const data = output.data ?? {};
    if (data['text/plain'] != null) return joinSource(data['text/plain']);
    if (data['image/png'] != null || data['image/jpeg'] != null) return '[image output omitted]';
    return '';
  }
  if (output.output_type === 'error') {
    const head = `${output.ename}: ${output.evalue}`;
    const tb = (output.traceback ?? []).join('\n');
    const combined = tb ? `${head}\n${tb}` : head;
    return stripAnsi(combined);
  }
  return '';
}

function renderOutputSection(outputs) {
  if (!outputs || outputs.length === 0) return '';
  const pieces = outputs.map(renderOutput).filter((s) => s.length > 0);
  const rendered = pieces.join('\n').trim();
  if (!rendered) return '';
  return `\n--- output ---\n${rendered}`;
}

function renderCell(cell, index) {
  const n = index + 1;
  const source = joinSource(cell.source);
  const type = cell.cell_type ?? 'unknown';
  const header = `# Cell ${n} [${type}]`;
  const outputSection = type === 'code' ? renderOutputSection(cell.outputs) : '';
  return `${header}\n${source}${outputSection}`;
}

export function flattenNotebook(jsonText) {
  let nb;
  try {
    nb = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`Invalid .ipynb: ${err.message}`, { cause: err });
  }

  const meta = nb.metadata ?? {};
  const lang = meta.kernelspec?.language ?? meta.language_info?.name ?? 'unknown';

  const cells = nb.cells ?? [];
  const headerLine = `[notebook] ${cells.length} cells, language: ${lang}`;
  const body = cells.map(renderCell).join('\n\n');

  return `${headerLine}\n\n${body}`;
}
