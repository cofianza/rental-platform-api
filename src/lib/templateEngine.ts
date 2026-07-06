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

/**
 * Igual que renderTemplate pero envuelve CADA valor insertado en
 * <span class="hp-var"> para poder resaltarlo. Es la "vista de verificación"
 * (tarea 4.1d): permite a la inmobiliaria identificar de un vistazo qué datos
 * se incorporaron automáticamente al contrato y confirmar que se generó bien.
 *
 * IMPORTANTE: NO se usa para el PDF legal — solo para un preview HTML de
 * verificación. Las URLs (_url, p.ej. logo en un src="…") NO se envuelven para
 * no romper el atributo, igual que en renderTemplate.
 */
export function renderTemplateHighlighted(template: string, context: Context): string {
  let html = resolveIfBlocks(template, context);

  html = html.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
    const v = getValue(context, path);
    if (v === undefined || v === null) return '';
    if (path.endsWith('logo_url') || path.endsWith('_url')) return String(v);
    const safe = escapeHtml(String(v));
    // Valor vacío tras resolver: no resaltamos (no hay dato que verificar).
    if (safe.trim() === '') return safe;
    return `<span class="hp-var">${safe}</span>`;
  });

  return html;
}

function resolveIfBlocks(template: string, context: Context): string {
  // Encuentra {{#if X}} o {{else}} o {{/if}} con sus posiciones, los empareja
  // con un stack y reemplaza el bloque resultante. Repetimos hasta que no
  // queden #if. Guardamos las posiciones EXACTAS de cada token (start y
  // end) porque calcular `lastIndexOf('{{')` falla con bloques consecutivos
  // tipo `{{#if X}}…{{/if}}{{#if Y}}…` — el `{{` siguiente se confunde
  // con el del `{{/if}}` que cerró el bloque actual.
  const tokenRe = /\{\{\s*(#if\s+([\w.]+)|else|\/if)\s*\}\}/g;

  // Estrategia: mientras haya pares #if/{/if}, encontrar el bloque más interno
  // (el #if más cercano al primer /if) y resolverlo. Repetir.
  for (let safety = 0; safety < 1000; safety += 1) {
    let openStart = -1;        // posición del `{{#if`
    let openEnd = -1;          // posición DESPUÉS del `}}` del `{{#if X}}`
    let openCond = '';
    let elseStart = -1;        // posición del `{{else`
    let elseEnd = -1;          // posición DESPUÉS del `}}` del `{{else}}`
    let closeStart = -1;       // posición del `{{/if`
    let closeEnd = -1;         // posición DESPUÉS del `}}` del `{{/if}}`
    tokenRe.lastIndex = 0;
    let depth = 0;

    let match: RegExpExecArray | null = tokenRe.exec(template);
    while (match) {
      const kind = match[1];
      const tokStart = match.index;
      const tokEnd = match.index + match[0].length;

      if (kind.startsWith('#if')) {
        if (depth === 0) {
          openStart = tokStart;
          openEnd = tokEnd;
          openCond = match[2];
          elseStart = -1;
          elseEnd = -1;
        }
        depth += 1;
      } else if (kind === 'else' && depth === 1) {
        elseStart = tokStart;
        elseEnd = tokEnd;
      } else if (kind === '/if') {
        depth -= 1;
        if (depth === 0) {
          closeStart = tokStart;
          closeEnd = tokEnd;
          break;
        }
      }
      match = tokenRe.exec(template);
    }

    if (openStart === -1 || closeStart === -1) break; // no más bloques

    const ifBody = elseStart >= 0
      ? template.slice(openEnd, elseStart)
      : template.slice(openEnd, closeStart);
    const elseBody = elseStart >= 0
      ? template.slice(elseEnd, closeStart)
      : '';

    const cond = getValue(context, openCond);
    const replacement = isTruthy(cond) ? ifBody : elseBody;

    template = template.slice(0, openStart) + replacement + template.slice(closeEnd);
  }

  return template;
}
