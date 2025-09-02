import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export type Config = {
    compilerPath?: string;
    includePaths?: string[];
    triple?: string;
    entryPoint: string;
    output: string;
    debug?: boolean;
    metaInfo?: boolean;
};

export type Context = {workspaceRoot: string; extCfg: vscode.WorkspaceConfiguration}

export function parseConfig(json: string): Config {
  return JSON.parse(json) as Config;
}

function getDefaultCompilerPath(extCfg: vscode.WorkspaceConfiguration): string {
  return extCfg.get<string>('compilerPath', 'mplc')!;
}
function getDefaultIncludePaths(extCfg: vscode.WorkspaceConfiguration): string[] {
  return extCfg.get<string[]>('includePath', []);
}

export function findNearestProjectContextForFile(filePath: string): Context | null {
  let dir = path.dirname(filePath);
  for (let i = 0; i < 10; ++i) {
    const cfgPath = path.join(dir, 'mpl.json');
    if (fs.existsSync(cfgPath)) {
      const extCfg = vscode.workspace.getConfiguration('compiler', vscode.Uri.file(dir));
      return { workspaceRoot: dir, extCfg };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
      `Failed to find project config for ${filePath}`
  );
}

export function readProjectConfig(ctx: Context): Config {
  const configPath = path.join(ctx.workspaceRoot, 'mpl.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    return parseConfig(raw);
  } catch (err) {
    throw new Error(`Failed to parse project config for ${ctx.workspaceRoot}`)
  }
}

function makeRelativeTo(base: string, target: string): string {
  const absoluteTarget = path.isAbsolute(target) ? target : path.resolve(base, target);
  const rel = path.relative(base, absoluteTarget);
  return rel === '' ? '.' : rel;
}

export function buildCompilerArgs(cfg: Config, ctx: Context): string[] {
  const {workspaceRoot, extCfg} = ctx;
  const compilerPath = cfg.compilerPath ?? getDefaultCompilerPath(extCfg);
  const includePaths = cfg.includePaths ?? getDefaultIncludePaths(extCfg);
  const metaInfo = cfg.metaInfo ?? false;
  const debug = cfg.debug ?? false;
  const triple = cfg.triple;
  const entryPoint = cfg.entryPoint;
  const output = cfg.output;

  const includePathsRel = includePaths.map(p => makeRelativeTo(workspaceRoot, p));
  const entryPointRel = makeRelativeTo(workspaceRoot, entryPoint);

  const args: string[] = [];
  args.push(compilerPath);

  if (!debug) {
    args.push('-ndebug');
  }

  if (metaInfo) {
    args.push('-meta-info');
  }

  for (const inc of includePathsRel) {
    args.push('-I', inc);
  }

  if (triple) {
    args.push('-triple', triple);
  }

  args.push('-o', output);
  args.push(entryPointRel);

  return args;
}