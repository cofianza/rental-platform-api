/**
 * Motor de templates minimalista para los contratos.
 *
 * Soporta:
 *   {{var.path}}                  → reemplaza por el valor en context (anidado)
 *   {{#if cond.path}}…{{/if}}     → renderiza el bloque solo si cond es truthy
 *   {{#if cond}}…{{else}}…{{/if}} → bloque alternativo cuando cond es falsy
 *
 * No soporta loops (#each) — los contratos no los necesitan; si en el
 * futuro se requieren, mejor cambiar a Handlebars.
 *
 * Truthy: cualquier valor distinto de undefined, null, '', false y 0.
 * Las variables faltantes se renderizan como string vacío.
 *
 * Nota: HTML ya viene escapado en la plantilla (es contenido fijo). Los
 * valores que se inyectan se escapan para evitar inyección XSS si la
 * plantilla termina con datos provistos por usuarios (ej. nombre del
 * arrendatario con caracteres especiales). Las URLs (logo) se dejan sin
 * escapar — son admin-controlled.
 */

type Context = Record<string, unknown>;

function getValue(ctx: Context, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = ctx;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

function isTruthy(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Resuelve los bloques {{#if}}...{{/if}}/{{else}} primero (recursivamente),
 * luego reemplaza los placeholders {{var}}.
 */
export function renderTemplate(template: string, context: Context): string {
  // 1. Resolver bloques #if anidados (algoritmo no-greedy con stack).
  let html = resolveIfBlocks(template, context);

  // 2. Reemplazar placeholders simples {{var.path}}.
  html = html.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
    const v = getValue(context, path);
    if (v === undefined || v === null) return '';
    // No escapamos URLs (logo_url) — tienen caracteres como ?, &, =.
    if (path.endsWith('logo_url') || path.endsWith('_url')) return String(v);
    return escapeHtml(String(v));
  });

  return html;
}

function resolveIfBlocks(template: string, context: Context): string {
  // Encuentra {{#if X}} o {{else}} o {{/if}} con sus posiciones, los empareja
  // con un stack y reemplaza el bloque resultante. Repetimos hasta que no
  // queden #if (los #if anidados se resuelven de adentro hacia afuera porque
  // el stack toma el último #if abierto antes de cerrar).
  const tokenRe = /\{\{\s*(#if\s+([\w.]+)|else|\/if)\s*\}\}/g;

  // Estrategia: mientras haya pares #if/{/if}, encontrar el bloque más interno
  // (el #if más cercano al primer /if) y resolverlo. Repetir.
  for (let safety = 0; safety < 1000; safety += 1) {
    let openIdx = -1;
    let openCond = '';
    let elseIdx = -1;
    let closeIdx = -1;
    tokenRe.lastIndex = 0;
    let depth = 0;

    let match: RegExpExecArray | null = tokenRe.exec(template);
    while (match) {
      const kind = match[1];
      if (kind.startsWith('#if')) {
        if (depth === 0) {
          openIdx = match.index;
          openCond = match[2];
          elseIdx = -1;
        }
        depth += 1;
      } else if (kind === 'else' && depth === 1) {
        elseIdx = match.index;
      } else if (kind === '/if') {
        depth -= 1;
        if (depth === 0) {
          closeIdx = match.index + match[0].length;
          break;
        }
      }
      match = tokenRe.exec(template);
    }

    if (openIdx === -1 || closeIdx === -1) break; // no más bloques

    const openTagEnd = template.indexOf('}}', openIdx) + 2;
    const closeTagStart = template.lastIndexOf('{{', closeIdx);

    const ifBody = elseIdx >= 0
      ? template.slice(openTagEnd, elseIdx)
      : template.slice(openTagEnd, closeTagStart);
    const elseBody = elseIdx >= 0
      ? template.slice(template.indexOf('}}', elseIdx) + 2, closeTagStart)
      : '';

    const cond = getValue(context, openCond);
    const replacement = isTruthy(cond) ? ifBody : elseBody;

    template = template.slice(0, openIdx) + replacement + template.slice(closeIdx);
  }

  return template;
}
