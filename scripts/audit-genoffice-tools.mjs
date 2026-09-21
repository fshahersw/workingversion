import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

// Source inventory, not a claim that every declared tool is enabled. Runtime
// composition, mode policy and deployment prerequisites are audited separately.
const upstream = resolve(process.argv[2] || '../references/genoffice');
const platform = resolve(process.cwd());
function files(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const child = resolve(path, entry.name);
    return entry.isDirectory() ? files(child) : /\.tsx?$/.test(entry.name) ? [child] : [];
  });
}
function inventory(root, paths) {
  const records = [];
  for (const path of paths.flatMap(path => /\.tsx?$/.test(path) ? [resolve(root, path)] : files(resolve(root, path)))) {
    const source = readFileSync(path, 'utf8');
    const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'map' && ts.isArrayLiteralExpression(node.expression.expression)
        && node.arguments[0]?.getText(tree).includes('inputSchema:')) {
        for (const name of node.expression.expression.elements) if (ts.isStringLiteral(name))
          records.push({ name: name.text, file: relative(root, path).replaceAll('\\', '/'), line: tree.getLineAndCharacterOfPosition(name.getStart(tree)).line + 1 });
      }
      if (ts.isObjectLiteralExpression(node)) {
        const properties = new Map(node.properties.filter(ts.isPropertyAssignment).map(p => [p.name.getText(tree).replace(/^['"]|['"]$/g, ''), p.initializer]));
        const name = properties.get('name');
        if (name && (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) && properties.has('description') && (properties.has('inputSchema') || properties.has('parameters') || properties.has('command'))) {
          records.push({ name: name.text, file: relative(root, path).replaceAll('\\', '/'), line: tree.getLineAndCharacterOfPosition(name.getStart(tree)).line + 1 });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
  return records.sort((a,b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file));
}
const result = {
  upstreamCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8' }).trim(),
  platformCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: platform, encoding: 'utf8' }).trim(),
  upstream: Object.fromEntries(['docs','sheets','slides','pdf'].map(app => [app, inventory(upstream, [`apps/${app}/src/renderer/ai`])])),
  upstreamCliMcp: inventory(upstream, ['packages/cli/src/mcp/tools.ts']),
  upstreamDesktopMcp: inventory(upstream, ['apps/shell/src/main/mcp/tools']),
  platform: {
    docs: inventory(platform, ['src/writer/renderer/ai']),
    sheets: inventory(platform, ['src/office/sheets/src/renderer/ai']),
    slides: inventory(platform, ['src/office/slides/src/renderer/ai']),
    pdf: inventory(platform, ['src/office/pdf']),
    shared: inventory(platform, ['src/office/shared/platform-skill.ts']),
  },
};
result.platformExposedByWritePolicy = {};
for (const [app, policyPath] of Object.entries({ docs: 'src/writer/shared/sw-policy.ts', sheets: 'src/office/sheets/src/shared/sw-policy.ts', slides: 'src/office/slides/src/shared/sw-policy.ts' })) {
  const source = readFileSync(resolve(platform, policyPath), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const policy = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  const declared = new Set([...result.platform[app], ...result.platform.shared].map(tool => tool.name));
  result.platformExposedByWritePolicy[app] = policy.allowedTools('write').filter(name => declared.has(name)).sort();
}
console.log(JSON.stringify(result, null, 2));
