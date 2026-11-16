// Trusted local ESM extension. Register resources through api.effect and honor signals.
import { readdir } from 'node:fs/promises';

export function activate(api) {
  async function summary(pane, signal) {
    const names = await readdir(pane.cwd); signal.throwIfAborted();
    return { project: pane.cwd, model: pane.modelId, notes: names.filter(name => /\.(md|txt)$/i.test(name)).slice(0, 100) };
  }
  api.command('summary', async (_args, pane, signal) => JSON.stringify(await summary(pane, signal), null, 2));
  api.panel('summary', async (pane, signal) => JSON.stringify(await summary(pane, signal), null, 2));
  api.tool('list_notes', 'List Markdown/text filenames in the calling pane project.', {}, (_args, pane, signal) => summary(pane, signal));
}
