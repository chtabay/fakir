import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { Script } from 'node:vm';

// A deliberately small assembler for this project's named ESM declarations.
// Every source keeps its own scope; unsupported syntax fails the build.
const root = new URL('../', import.meta.url);
const modulePaths = [
  'js/learning.js',
  'js/calculator.js',
  'js/game-state.js',
  'js/network-view.js',
  'js/game.js',
];
const identifier = '[A-Za-z_$][\\w$]*';
const namedBinding = new RegExp(`^(${identifier})(?:\\s+as\\s+(${identifier}))?$`);
const declarations = new RegExp(`^([ \\t]*)export\\s+((?:async\\s+)?function|class|const)\\s+(${identifier})`, 'gm');

function assembleModule(source, file, available) {
  const exports = new Set();
  let code = source.replace(
    /^[ \t]*import\s*\{([^}]+)\}\s*from\s*(['"])([^'"\r\n]+)\2\s*;?[ \t]*(?:\r?\n|$)/gm,
    (_, bindings, quote, specifier) => {
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
        throw new Error(`${file} : import externe non pris en charge (${specifier}).`);
      }
      const dependency = posix.normalize(posix.join(posix.dirname(file), specifier));
      const provided = available.get(dependency);
      if (!provided) throw new Error(`${file} : module absent ou chargé trop tard (${dependency}).`);
      const names = bindings.split(',').map(value => value.trim()).filter(Boolean).map(binding => {
        const match = namedBinding.exec(binding);
        if (!match) throw new Error(`${file} : import nommé non pris en charge (${binding}).`);
        const [, imported, local = imported] = match;
        if (!provided.has(imported)) throw new Error(`${file} : export ${imported} absent de ${dependency}.`);
        return imported === local ? imported : `${imported}: ${local}`;
      });
      return `const { ${names.join(', ')} } = __fakirBundleModules[${JSON.stringify(dependency)}];\n`;
    },
  );
  code = code.replace(declarations, (_, indent, kind, name) => {
    exports.add(name);
    return `${indent}${kind} ${name}`;
  });
  if (/^\s*(?:import|export)\b/m.test(code) || /\bimport\s*(?:\(|\.)/.test(code)) {
    throw new Error(`${file} : seuls les imports nommés et exports class/const/function sont pris en charge.`);
  }
  available.set(file, exports);
  return `// ${file}\n__fakirBundleModules[${JSON.stringify(file)}] = (() => {\n${code}\nreturn Object.freeze({ ${[...exports].join(', ')} });\n})();`;
}

function replaceOnce(source, pattern, replacement, label) {
  let count = 0;
  const result = source.replace(pattern, () => { count++; return replacement; });
  if (count !== 1) throw new Error(`${label} : une occurrence attendue, ${count} trouvée(s).`);
  return result;
}

async function build() {
  const inputs = ['index.html', 'style.css', 'favicon.svg', ...modulePaths];
  const contents = await Promise.all(inputs.map(async file => {
    try { return await readFile(new URL(file, root), 'utf8'); }
    catch (error) { throw new Error(`Lecture impossible : ${file} (${error.code || error.message}).`); }
  }));
  let [html, css, favicon, ...sources] = contents;
  // Quoted font URLs contain semicolons: consume the entire URL before its
  // terminating declaration, then let the existing system font fallbacks work.
  css = css.replace(/@import\s+(?:url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)|"[^"]*"|'[^']*')[^;]*;/gi, '');
  if (/@import\b/i.test(css)) throw new Error('Import CSS non pris en charge dans la version autonome.');
  for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) {
    const target = (match[1] ?? match[2] ?? match[3]).trim();
    if (!target.startsWith('data:') && !target.startsWith('#')) {
      throw new Error(`Ressource CSS non intégrée : ${target}.`);
    }
  }

  const available = new Map();
  const modules = sources.map((source, index) => assembleModule(source, modulePaths[index], available));
  const bundle = `(() => {\n'use strict';\nconst __fakirBundleModules = Object.create(null);\n\n${modules.join('\n\n')}\n})();`;
  // Validate only. The build never evaluates the game or its DOM operations.
  new Script(bundle, { filename: 'fakir-bundle.js' });
  const inlineScript = bundle.replace(/<\/script/gi, match => `<\\/${match.slice(2)}`);
  new Script(inlineScript, { filename: 'fakir-inline.js' });
  const faviconURI = `data:image/svg+xml;base64,${Buffer.from(favicon).toString('base64')}`;
  html = replaceOnce(html, /<link\b[^>]*\bhref=['"]\.\/style\.css['"][^>]*>/gi,
    `<style>\n${css.replace(/<\/style/gi, match => `<\\/${match.slice(2)}`)}\n</style>`, 'Feuille de style');
  html = replaceOnce(html, /<script\b[^>]*\bsrc=['"]\.\/js\/game\.js['"][^>]*>\s*<\/script\s*>/gi,
    `<script>\n${inlineScript}\n</script>`, 'Script principal');
  html = html.replace(/\b(href|src)=(['"])\.\/favicon\.svg\2/g, (_, attribute, quote) => `${attribute}=${quote}${faviconURI}${quote}`);
  html = html.replace(/\bhref=(['"])\.\/\1/g, 'href="#"');

  if ((html.match(/<script\b/gi) || []).length !== 1) throw new Error('Un script unique est attendu dans le fichier autonome.');
  for (const match of html.matchAll(/<(?:script|link|img)\b[^>]*\b(?:src|href)=(['"])([^'"]+)\1[^>]*>/gi)) {
    if (!match[2].startsWith('data:')) throw new Error(`Ressource HTML non intégrée : ${match[2]}.`);
  }
  await mkdir(new URL('dist/', root), { recursive: true });
  await writeFile(new URL('dist/fakir.html', root), html, 'utf8');
  console.log(`Version autonome créée : dist/fakir.html (${Math.round(Buffer.byteLength(html) / 1024)} Kio).`);
}

build().catch(error => {
  console.error(`Construction Fakir impossible : ${error.message}`);
  process.exitCode = 1;
});
