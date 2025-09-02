import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Context, readProjectConfig, findNearestProjectContextForFile, buildCompilerArgs } from './config';
import { spawn } from 'child_process';

function computePrimaryMetaPath(workspaceRoot: string, cfgOutput: string | undefined, entryBase: string): string {
  const out = (cfgOutput ?? '').trim();
  if (out === '') {
    return path.join(workspaceRoot, entryBase + '.meta.json');
  }
  const ext = path.extname(out);
  if (path.isAbsolute(out)) {
    return out + '.meta.json';
  }
  return path.join(workspaceRoot, out + '.meta.json');
}

async function loadMetaForProject(ctx: Context): Promise<any | null> {
  let cfg;
  try {
    cfg = readProjectConfig(ctx);
  } catch (err) {
    return null;
  }
  const entryBase = path.basename(cfg.entryPoint, path.extname(cfg.entryPoint));
  const primary = computePrimaryMetaPath(ctx.workspaceRoot, cfg.output, entryBase);
  try {
    if (fs.existsSync(primary)) {
      const raw = await fs.promises.readFile(primary, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed;
    }
    return null;
  } catch (err) {
    return null;
  }
}

async function resolveMetaOccurrenceFile(ctx: Context, occFile: string): Promise<vscode.Uri | null> {
  if (!occFile) return null;
  const normalized = occFile.replace(/\//g, path.sep).replace(/^(\.\/|\/|\\)+/, '');
  const absCandidate = path.resolve(ctx.workspaceRoot, normalized);
  if (fs.existsSync(absCandidate)) return vscode.Uri.file(absCandidate);
  let cfgOut = '';
  try {
    const cfg = readProjectConfig(ctx);
    cfgOut = cfg.output ?? '';
  } catch {
    cfgOut = '';
  }
  let outDir = cfgOut;
  if (outDir && path.extname(outDir) !== '') outDir = path.dirname(outDir);
  if (outDir) {
    const candidate = path.resolve(ctx.workspaceRoot, outDir, normalized);
    if (fs.existsSync(candidate)) return vscode.Uri.file(candidate);
  }
  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  for (const wf of workspaceFolders) {
    try {
      const base = wf.uri.fsPath;
      const cand = path.resolve(base, normalized);
      if (fs.existsSync(cand)) return vscode.Uri.file(cand);
      if (outDir) {
        const cand2 = path.resolve(base, outDir, normalized);
        if (fs.existsSync(cand2)) return vscode.Uri.file(cand2);
      }
    } catch {}
  }
  const name = path.basename(normalized);
  const matchesBase = await vscode.workspace.findFiles('**/' + name, null, 10);
  if (matchesBase.length > 0) {
    return matchesBase[0];
  }
  const globPath = normalized.split(path.sep).join('/');
  const matchesFull = await vscode.workspace.findFiles('**/' + globPath, null, 10);
  if (matchesFull.length > 0) {
    return matchesFull[0];
  }
  return null;
}

export async function activate(context: vscode.ExtensionContext) {

  context.subscriptions.push(
    vscode.commands.registerCommand('mpl.buildProject', async () => {
      try {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          throw new Error("No editor")
        }
        const ctx = findNearestProjectContextForFile(editor.document.uri.fsPath);
        if (!ctx) {
          throw new Error("No config file")
        }
        const args = buildCompilerArgs(readProjectConfig(ctx), ctx);
        
        if (!Array.isArray(args) || args.length === 0) {
          throw new Error('No command specified in args');
        }

        const bin = args[0];
        const binArgs = args.slice(1);

        const out = vscode.window.createOutputChannel('MPL Build');
        out.show(true);
        out.appendLine(`Running: ${[bin, ...binArgs].map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);

        await new Promise<void>((resolve, reject) => {
          const child = spawn(bin, binArgs, {
            cwd: ctx.workspaceRoot,
            env: { ...process.env },
            windowsHide: true
          });

          child.stdout.on('data', d => out.append(d.toString()));
          child.stderr.on('data', d => out.append(d.toString()));

          child.on('error', err => {
            out.appendLine(`Failed to start process: ${err.message}`);
            reject(err);
          });

          child.on('close', code => {
            if (code === 0) {
              out.appendLine(`Process finished with exit code ${code}`);
              vscode.window.showInformationMessage('Build succeeded');
              resolve();
            } else {
              const msg = `Process exited with code ${code}`;
              out.appendLine(msg);
              vscode.window.showErrorMessage(msg);
              reject(new Error(msg));
            }
          });
        });
      
      } catch (err) {
        const msg = 'Failed to run command: ' + (err instanceof Error ? err.message : String(err));
        vscode.window.showInformationMessage(msg);
      }
    })
  );

  const provider: vscode.DefinitionProvider = {
    async provideDefinition(document: vscode.TextDocument, position: vscode.Position) {
      const wordRange = document.getWordRangeAtPosition(position, /\w+/);
      if (!wordRange) {
        return null;
      }
      const name = document.getText(wordRange);
      const ctx = findNearestProjectContextForFile(document.uri.fsPath);
      if (!ctx) {
        return null;
      }
      const meta = await loadMetaForProject(ctx);
      if (!meta) {
        return null;
      }
      const globals = meta.globals;
      if (!globals) {
        return null;
      }
      const occurrences = globals[name];
      if (!occurrences || occurrences.length === 0) {
        return null;
      }
      const locations: vscode.Location[] = [];
      for (const occ of occurrences) {
        const uri = await resolveMetaOccurrenceFile(ctx, occ.file || '');
        if (!uri) continue;
        const line = Math.max(0, (occ.line || 1) - 1);
        const column = Math.max(0, (occ.column || 1) - 1);
        locations.push(new vscode.Location(uri, new vscode.Position(line, column)));
      }
      return locations.length > 0 ? locations : null;
    }
  };

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider({ scheme: 'file', pattern: '**/*.mpl' }, provider)
  );
}