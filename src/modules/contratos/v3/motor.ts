/**
 * Contratos V3 — motor de plantillas (Entrega 2, diseño §3–§4).
 *
 * Una línea de plantilla = un párrafo del Word. El motor, puro y determinista:
 *   1. parsea los archivos de la plantilla (parsearPlantilla) y rechaza con
 *      PLANTILLA_INVALIDA (archivo:línea) todo lo que se salga del formato §3;
 *   2. resuelve condiciones, @cada y alternativas [[c: texto Word | alternativa]];
 *   3. numera cláusulas, parágrafos, numerales, literales y secciones (nunca hay
 *      ordinales literales: una referencia no puede quedar desactualizada);
 *   4. emite HTML con las clases k-* que estiliza documento.ts;
 *   5. saca el texto de todas las verificaciones DE ESE HTML (htmlATexto): se
 *      verifica exactamente lo que se imprime.
 *
 * Origen de cada línea (prueba de fidelidad): cada elemento k-* lleva
 * data-o="archivo:línea" de la plantilla, y Resultado.origenes es paralelo a
 * Resultado.lineas ("adicional:N" en las cláusulas adicionales). Así cada
 * conversor compara solo su rango de párrafos del Word.
 *
 * La contabilidad del resumen también sale del HTML: cada cifra impresa va en
 * un span data-campo/data-fmt/data-zona[/data-tabla/data-total] y
 * asientosDeHtml la relee, así que alterar el HTML rompe verificarCoherencia.
 *
 * [[c: A | B]]: A y B se recortan; los espacios van fuera de los corchetes
 * ("Ver X [[c: y el Y | ]] de…"): si B queda vacía, el espacio doble se
 * colapsa al leer el texto (y el navegador lo colapsa al imprimir).
 *
 * Contexto de @cada: cada elemento de ctx.roles[rol] trae sus valores y
 * condiciones con la clave completa ('parte.nombre', 'parte.cc') o sin el
 * prefijo ('nombre', 'cc'); las dos sirven.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { AppError } from '@/lib/errors';
import { FORMATOS, mayus, ordinal, titulo } from './formato';

// Misma profundidad desde src/…/v3 (ts-node, vitest) y dist/…/v3 (build).
const RECURSOS = path.resolve(__dirname, '../../../../recursos/contratos');
const MARCA = '▢';

// ── Tipos públicos (diseño §4.1) ──

export type Modo = 'fidelidad' | 'revision' | 'final';

export interface DefPlantilla {
  codigo: string;
  partes: string[];
  campos: Record<string, 'texto' | 'numero' | 'fecha'>;
  cifras: readonly string[];
  condiciones: readonly string[];
  roles: readonly string[];
}

export interface Plantilla {
  def: DefPlantilla;
  version: string; // sha256 de las partes unidas
  pie: string;
  nodos: Nodo[];
  borradores: { id: string; sha256: string; word: string; texto: string }[];
}

type Valores = Record<string, string | number>;
type Condiciones = Record<string, boolean>;

export interface Contexto {
  condiciones: Condiciones;
  valores: Valores;
  roles: Record<string, { condiciones: Condiciones; valores: Valores }[]>;
}

export interface Linea {
  kind: string;
  texto: string;
}

export interface Asiento {
  campo: string;
  fmt: string;
  zona: 'cuadro' | 'resumen' | 'clausula';
  tabla?: number;
  total?: boolean;
  texto: string;
}

export interface Pendiente {
  id: string;
  tipo: 'texto' | 'borrador';
}

export interface Resultado {
  html: string;
  lineas: Linea[];
  origenes: string[]; // paralelo a lineas: "archivo:línea" de la plantilla
  asientos: Asiento[];
  refs: { origen: string; destino: string; texto: string }[];
  pendientes: Pendiente[];
}

export interface Adicional {
  titulo: string;
  texto: string;
}

// ── Árbol de la plantilla ──

export interface Origen {
  parte: string;
  linea: number;
}
export interface Cond {
  c: string;
  neg: boolean;
}
export type Alternativa =
  | { t: 'vacia' }
  | { t: 'pendiente'; id: string }
  | { t: 'borrador'; id: string; sha256: string; toks: Tok[] };
export type Tok =
  | { t: 'txt'; v: string }
  | { t: 'neg' }
  | { t: 'cur' }
  | { t: 'campo'; campo: string; fmt: string | null }
  | { t: 'linea' }
  | { t: 'casilla'; c: string; neg: boolean }
  | { t: 'N' }
  | { t: 'S' }
  | { t: 'P'; id: string }
  | { t: 'ref'; cl: string; p: string | null; corta: boolean }
  | { t: 'alt'; c: string; word: Tok[]; fuente: string; alt: Alternativa };

interface Base {
  o: Origen;
  conds: Cond[];
  fuente: string; // la línea tal como está en el archivo, sin sus condiciones
}
export interface NodoLinea extends Base {
  n: 'linea';
  kind: string;
  prefijo: string;
  toks: Tok[];
  inicio: boolean; // cabecera de cláusula
  soloFidelidad: boolean; // @nota-editorial
}
export interface NodoFila extends Base {
  n: 'fila';
  celdas: [Tok[], Tok[]];
  total: boolean; // última fila de un @dinero
}
export interface NodoCaja extends Base {
  n: 'caja';
  tipo: 'cuadro' | 'dinero' | 'recuadro' | 'datos' | 'firma' | 'cada';
  rol: string;
  tabla: number; // índice del @dinero; -1 en los demás
  hijos: Nodo[];
}
export interface NodoAmbito extends Base {
  n: 'ambito';
  tipo: 'bloque' | 'seccion' | 'clausula' | 'adicionales';
  id: string;
  hijos: Nodo[];
}
export type Nodo = NodoLinea | NodoFila | NodoCaja | NodoAmbito;

// ── Parser (diseño §3.1–§3.2) ──

const KIND_PREFIJO: Record<string, string> = {
  '': 'p',
  '>': 'sangria',
  '>>': 'sangria2',
  '+': 'item',
  '+a': 'literal',
  '-': 'vineta',
};
const ENCABEZADOS: Record<string, [kind: string, formato: 'neg' | 'cur']> = {
  titulo: ['titulo', 'neg'],
  nota: ['nota', 'cur'],
  'nota-editorial': ['nota', 'cur'],
  subtitulo: ['subtitulo', 'neg'],
  bloque: ['bloque', 'neg'],
  seccion: ['seccion', 'neg'],
  adicionales: ['centrado', 'neg'],
};
const CAJAS = ['cuadro', 'dinero', 'recuadro', 'datos', 'firma', 'cada'] as const;
const AMBITOS = ['bloque', 'seccion', 'clausula', 'adicionales'] as const;

// Ordinales escritos a mano: la numeración siempre es simbólica ({N}, {P:}, {ref:}).
const ORDINAL_LITERAL =
  /\b(cl[áa]usulas?|par[áa]grafo)\s+(primer|segund|tercer|cuart|quint|sext|s[ée]ptim|octav|noven|d[ée]cim|vig[ée]sim|trig[ée]sim)/i;
const CABECERA_LITERAL =
  /^\*\*(PRIMERA|SEGUNDA|TERCERA|CUARTA|QUINTA|SEXTA|SÉPTIMA|OCTAVA|NOVENA|DÉCIMA|VIGÉSIMA|TRIGÉSIMA)\b/;
const PARAGRAFO_LITERAL = /PAR[ÁA]GRAFO/;

const sha256 = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

const invalida = (o: Origen, msg: string) =>
  new AppError(500, 'PLANTILLA_INVALIDA', `${o.parte}:${o.linea}: ${msg}`, o);

/** Parte "celda1 | celda2" sin cortar dentro de [[ … ]]. */
function partirFila(s: string): string[] {
  const out: string[] = [];
  let [hondo, desde] = [0, 0];
  for (let k = 0; k < s.length; k++) {
    if (s.startsWith('[[', k) || s.startsWith(']]', k)) hondo += s[k++] === '[' ? 1 : -1;
    else if (s[k] === '|' && !hondo) {
      out.push(s.slice(desde, k).trim());
      desde = k + 1;
    }
  }
  out.push(s.slice(desde).trim());
  return out;
}

/**
 * Lee y valida la plantilla. `fuentes` (nombre de parte → texto) evita leer
 * disco; sin él, cada parte se lee de recursos/contratos/<codigo>/<parte>.
 */
export function parsearPlantilla(def: DefPlantilla, fuentes?: Record<string, string>): Plantilla {
  const raiz: Nodo[] = [];
  const borradores: Plantilla['borradores'] = [];
  const parrafos = new Map<string, Set<string>>(); // cláusula → sus {P:}
  const refs: { o: Origen; cl: string; p: string | null }[] = [];
  const crudos: string[] = [];
  let pie: string | null = null;
  let ambito: NodoAmbito | null = null;
  let cabecera = false; // la última directiva fue @clausula: esta línea es su cabecera {N}
  let tablas = 0;
  let cajas: NodoCaja[] = [];
  let o: Origen = { parte: '', linea: 0 };

  const mal = (msg: string) => invalida(o, msg);
  const enCada = () => cajas.some((c) => c.tipo === 'cada');
  const clausula = () => (ambito?.tipo === 'clausula' ? ambito.id : null);
  const destino = () => cajas.at(-1)?.hijos ?? ambito?.hijos ?? raiz;

  function condicion(c: string): string {
    if (!def.condiciones.includes(c)) throw mal(`condición desconocida: ${c}`);
    if (c.startsWith('parte.') && !enCada()) throw mal(`${c} solo va dentro de @cada`);
    return c;
  }

  function campo(nombre: string, fmt: string | null): Tok {
    const tipo = Object.hasOwn(def.campos, nombre) ? def.campos[nombre] : undefined;
    if (!tipo) throw mal(`campo desconocido: {${nombre}}`);
    if (nombre.startsWith('parte.') && !enCada()) throw mal(`{${nombre}} solo va dentro de @cada`);
    if (fmt === null) {
      if (tipo !== 'texto') throw mal(`{${nombre}} es ${tipo}: necesita formato ({fmt:${nombre}})`);
    } else {
      const f = FORMATOS[fmt];
      if (!f) throw mal(`formato desconocido: {${fmt}:${nombre}}`);
      if (f.tipo !== tipo)
        throw mal(`el formato ${fmt} es para ${f.tipo}, no para ${tipo}: {${fmt}:${nombre}}`);
    }
    return { t: 'campo', campo: nombre, fmt };
  }

  function llave(x: string): Tok {
    if (x === 'N') return { t: 'N' };
    if (x === 'S') return { t: 'S' };
    if (x === 'linea') return { t: 'linea' };
    let m = /^P:([\w-]+)$/.exec(x);
    if (m) return { t: 'P', id: m[1] };
    m = /^ref:([\w-]*)(?:\/([\w-]+))?$/.exec(x);
    if (m) {
      if (!m[1] && !m[2]) throw mal('{ref:} sin destino');
      return { t: 'ref', cl: m[1], p: m[2] ?? null, corta: !m[1] };
    }
    m = /^casilla:(!?)([\w.]+)$/.exec(x);
    if (m) return { t: 'casilla', c: condicion(m[2]), neg: !!m[1] };
    m = /^(?:(\w+):)?([\w.]+)$/.exec(x);
    if (m) return campo(m[2], m[1] ?? null);
    throw mal(`marcador desconocido: {${x}}`);
  }

  function alternativa(src: string, word: string): Alternativa {
    const s = src.trim();
    if (!s) return { t: 'vacia' };
    const pend = /^PENDIENTE\(([\w-]+)\)$/.exec(s);
    if (pend) return { t: 'pendiente', id: pend[1] };
    const b = /^#([\w-]+):\s*([\s\S]+)$/.exec(s);
    if (!b) throw mal(`la alternativa debe ser vacía, PENDIENTE(x) o "#id: borrador": ${s}`);
    if (borradores.some((x) => x.id === b[1])) throw mal(`borrador duplicado: #${b[1]}`);
    const texto = b[2].trim();
    const hash = sha256(texto);
    borradores.push({ id: b[1], sha256: hash, word, texto });
    return { t: 'borrador', id: b[1], sha256: hash, toks: tokenizar(texto, true) };
  }

  function tokenizar(s: string, enAlt = false): Tok[] {
    const toks: Tok[] = [];
    let txt = '';
    const soltar = () => {
      if (txt) toks.push({ t: 'txt', v: txt });
      txt = '';
    };
    for (let k = 0; k < s.length; ) {
      if (s.startsWith('[[', k)) {
        const fin = s.indexOf(']]', k);
        const cuerpo = fin < 0 ? '' : s.slice(k + 2, fin);
        if (enAlt || cuerpo.includes('[[')) throw mal('[[ anidado');
        const m = /^\s*([\w.]+)\s*:([\s\S]*)$/.exec(cuerpo);
        const ramas = m ? m[2].split('|') : [];
        if (!m || ramas.length !== 2)
          throw mal(`se espera [[condición: texto Word | alternativa]]: ${s.slice(k, k + 60)}`);
        const word = ramas[0].trim();
        soltar();
        toks.push({
          t: 'alt',
          c: condicion(m[1]),
          word: tokenizar(word, true),
          fuente: word,
          alt: alternativa(ramas[1], word),
        });
        k = fin + 2;
      } else if (s.startsWith(']]', k)) throw mal(']] sin [[');
      else if (s[k] === '{') {
        const fin = s.indexOf('}', k);
        if (fin < 0 || s.slice(k + 1, fin).includes('{')) throw mal('{ sin cerrar');
        soltar();
        toks.push(llave(s.slice(k + 1, fin)));
        k = fin + 1;
      } else if (s[k] === '}') throw mal('} sin {');
      else if (s.startsWith('**', k)) {
        soltar();
        toks.push({ t: 'neg' });
        k += 2;
      } else if (s[k] === '*') {
        soltar();
        toks.push({ t: 'cur' });
        k++;
      } else txt += s[k++];
    }
    soltar();
    return toks;
  }

  function validar(toks: Tok[], permite: { N?: boolean; S?: boolean }, anidado = false): void {
    let neg = 0;
    let cur = 0;
    for (const t of toks) {
      if (t.t === 'neg') neg++;
      else if (t.t === 'cur') cur++;
      else if (t.t === 'N' && (!permite.N || anidado))
        throw mal('{N} solo va en la línea de cabecera de una cláusula');
      else if (t.t === 'S' && !permite.S) throw mal('{S} solo va en @seccion');
      else if (t.t === 'P') {
        const cl = clausula();
        if (!cl || enCada()) throw mal('{P:} solo va dentro de una cláusula, fuera de @cada');
        if (parrafos.get(cl)!.has(t.id)) throw mal(`parágrafo duplicado: {P:${t.id}}`);
        parrafos.get(cl)!.add(t.id);
      } else if (t.t === 'ref') {
        if (t.corta) t.cl = clausula() ?? '';
        if (!t.cl) throw mal('{ref:/p} fuera de una cláusula');
        refs.push({ o, cl: t.cl, p: t.p });
      } else if (t.t === 'alt') {
        validar(t.word, permite, true);
        if (t.alt.t === 'borrador') validar(t.alt.toks, permite, true);
      }
    }
    if (neg % 2 || cur % 2) throw mal('** o * sin cerrar');
  }

  const contenido = (src: string, permite: { N?: boolean; S?: boolean } = {}) => {
    const toks = tokenizar(src);
    validar(toks, permite);
    return toks;
  };

  function encabezado(nombre: string, arg: string, conds: Cond[]): NodoLinea {
    const [kind, formato] = ENCABEZADOS[nombre];
    const marca: Tok = formato === 'neg' ? { t: 'neg' } : { t: 'cur' };
    const toks = contenido(arg, { S: nombre === 'seccion' });
    return {
      n: 'linea',
      o,
      conds,
      fuente: `@${nombre} ${arg}`,
      kind,
      prefijo: '',
      toks: [marca, ...toks, marca],
      inicio: false,
      soloFidelidad: nombre === 'nota-editorial',
    };
  }

  for (const parte of def.partes) {
    const archivo = path.basename(parte);
    const crudo = fuentes
      ? fuentes[parte]
      : fs.readFileSync(path.resolve(RECURSOS, def.codigo, parte), 'utf8');
    o = { parte: archivo, linea: 0 };
    if (crudo === undefined) throw mal('parte sin texto');
    crudos.push(crudo);
    cajas = [];
    const lineas = crudo
      .replace(/^\uFEFF/, '')
      .normalize('NFC')
      .split(/\r?\n/);

    for (const [k, bruta] of lineas.entries()) {
      o = { parte: archivo, linea: k + 1 };
      const linea = bruta.trim();
      if (!linea || linea.startsWith('#')) continue;
      const m = /^((?:\?!?[\w.]+\s+)*)([\s\S]*)$/.exec(linea)!;
      const conds = m[1]
        .split(/\s+/)
        .filter(Boolean)
        .map((s) => ({ c: condicion(s.replace(/^\?!?/, '')), neg: s.startsWith('?!') }));
      const resto = m[2];
      const negadas = conds.filter((c) => c.neg);
      const dir = /^@([\w-]+)(?:\s+([\s\S]*))?$/.exec(resto);
      if (
        dir?.[1] !== 'nota-editorial' &&
        (ORDINAL_LITERAL.test(resto) || PARAGRAFO_LITERAL.test(resto))
      )
        throw mal('ordinal escrito a mano: use {N}, {P:id} o {ref:…}');

      if (dir) {
        const [, nombre, arg = ''] = dir;
        const sinTexto =
          nombre === 'fin' || ((CAJAS as readonly string[]).includes(nombre) && nombre !== 'cada');
        if (negadas.length) throw mal('?! solo va en líneas PENDIENTE(x) o #id: texto');
        if (cabecera) throw mal('después de @clausula va su línea de cabecera con {N}');
        if (
          !Object.hasOwn(ENCABEZADOS, nombre) &&
          !['pie', 'clausula', ...CAJAS, 'fin'].includes(nombre)
        )
          throw mal(`directiva desconocida: @${nombre}`);
        if (sinTexto === !!arg.trim())
          throw mal(sinTexto ? `@${nombre} no lleva texto` : `@${nombre} sin texto`);

        if (nombre === 'pie') {
          if (conds.length || cajas.length || pie !== null)
            throw mal('@pie va una sola vez, sin condición y fuera de bloques');
          pie = arg;
        } else if ((AMBITOS as readonly string[]).includes(nombre)) {
          if (cajas.length) throw mal(`@${nombre} no va dentro de un bloque`);
          ambito = {
            n: 'ambito',
            o,
            conds,
            fuente: resto,
            tipo: nombre as NodoAmbito['tipo'],
            id: '',
            hijos: [],
          };
          raiz.push(ambito);
          if (nombre === 'clausula') {
            if (!/^[a-z0-9-]+$/.test(arg)) throw mal('@clausula lleva un id [a-z0-9-]');
            if (parrafos.has(arg)) throw mal(`cláusula duplicada: ${arg}`);
            parrafos.set(arg, new Set());
            ambito.id = arg;
            cabecera = true;
          } else ambito.hijos.push(encabezado(nombre, arg, []));
        } else if (nombre === 'fin') {
          const caja = cajas.pop();
          if (!caja || conds.length) throw mal('@fin sin bloque abierto');
          const filas = caja.hijos.filter((h): h is NodoFila => h.n === 'fila');
          if (caja.tipo === 'dinero') {
            if (filas.length < 2) throw mal('@dinero lleva al menos encabezado y total');
            filas[filas.length - 1].total = true;
          }
        } else if ((CAJAS as readonly string[]).includes(nombre)) {
          if (nombre === 'cada' ? enCada() : cajas.some((c) => c.tipo !== 'cada'))
            throw mal(`@${nombre} anidado`);
          if (nombre === 'cada' && !def.roles.includes(arg)) throw mal(`rol desconocido: ${arg}`);
          const caja: NodoCaja = {
            n: 'caja',
            o,
            conds,
            fuente: resto,
            tipo: nombre as NodoCaja['tipo'],
            rol: nombre === 'cada' ? arg : '',
            tabla: nombre === 'dinero' ? tablas++ : -1,
            hijos: [],
          };
          destino().push(caja);
          cajas.push(caja);
        } else {
          if (cajas.some((c) => c.tipo !== 'cada'))
            throw mal(`@${nombre} no va dentro de un bloque`);
          destino().push(encabezado(nombre, arg, conds));
        }
        continue;
      }

      const caja = cajas.filter((c) => c.tipo !== 'cada').at(-1)?.tipo;
      if (caja === 'cuadro' || caja === 'dinero') {
        const celdas = partirFila(resto);
        if (negadas.length) throw mal('?! no va en una fila de tabla');
        if (celdas.length !== 2) throw mal('una fila lleva dos celdas: celda1 | celda2');
        destino().push({
          n: 'fila',
          o,
          conds,
          fuente: resto,
          celdas: [contenido(celdas[0]), contenido(celdas[1])],
          total: false,
        });
        continue;
      }

      let [prefijo, cuerpo] = ['', resto];
      if (/^[>+-]/.test(resto)) {
        const pm = /^(\S+)\s+([\s\S]*)$/.exec(resto);
        if (!pm || !Object.hasOwn(KIND_PREFIJO, pm[1]))
          throw mal(`prefijo desconocido: ${resto.split(/\s/)[0]}`);
        [prefijo, cuerpo] = [pm[1], pm[2]];
      }
      if (caja && !(prefijo === '' || (caja === 'recuadro' && prefijo === '-')))
        throw mal(`el prefijo ${prefijo} no va dentro de @${caja}`);
      if (CABECERA_LITERAL.test(cuerpo)) throw mal('ordinal escrito a mano: la cabecera usa {N}');

      let toks: Tok[];
      if (negadas.length) {
        // ?!c: la línea no está en el Word; solo existe cuando c es falsa
        if (negadas.length > 1) throw mal('una sola condición ?! por línea');
        toks = [{ t: 'alt', c: negadas[0].c, word: [], fuente: '', alt: alternativa(cuerpo, '') }];
        validar(toks, {});
      } else toks = contenido(cuerpo, { N: cabecera });
      if (cabecera && !toks.some((t) => t.t === 'N'))
        throw mal('la línea que sigue a @clausula es su cabecera y lleva {N}');
      if (prefijo === '-') {
        // la viñeta va con el formato de su primer tramo, como en el Word ("**•  Si no avisa…**")
        const k = toks.findIndex((t) => t.t !== 'neg' && t.t !== 'cur');
        toks.splice(k < 0 ? toks.length : k, 0, { t: 'txt', v: '•  ' });
      }
      const kind =
        caja === 'recuadro'
          ? 'recuadro'
          : caja === 'datos'
            ? 'dato'
            : caja === 'firma'
              ? 'firma'
              : KIND_PREFIJO[prefijo];
      destino().push({
        n: 'linea',
        o,
        conds,
        fuente: resto,
        kind,
        prefijo,
        toks,
        inicio: cabecera,
        soloFidelidad: false,
      });
      cabecera = false;
    }
    if (cajas.length) {
      o = cajas[cajas.length - 1].o;
      throw mal(`@${cajas[cajas.length - 1].tipo} sin @fin`);
    }
  }
  if (cabecera) throw mal('@clausula sin su línea de cabecera');
  for (const r of refs) {
    o = r.o;
    if (!parrafos.has(r.cl)) throw mal(`referencia a una cláusula que no existe: ${r.cl}`);
    if (r.p && !parrafos.get(r.cl)!.has(r.p))
      throw mal(`referencia a un parágrafo que no existe: ${r.cl}/${r.p}`);
  }
  return { def, version: sha256(crudos.join('\n')), pie: pie ?? '', nodos: raiz, borradores };
}

// ── Render (diseño §4.2) ──

type R =
  | { t: 'txt'; v: string }
  | { t: 'neg' }
  | { t: 'cur' }
  | { t: 'pend'; on: boolean }
  | { t: 'html'; v: string }
  | { t: 'P'; cl: string; id: string }
  | { t: 'ref'; cl: string; p: string | null; corta: boolean; origen: string };

type El =
  | { e: 'p'; kind: string; o: string; inicio: boolean; r: R[] }
  | { e: 'fila'; o: string; celdas: R[][] }
  | { e: 'tabla'; clase: string; filas: El[] }
  | { e: 'recuadro'; hijos: El[] }
  | { e: 'firma'; o: string; lineas: R[][] };

interface Paso {
  p: Plantilla;
  modo: Modo;
  ctx: Contexto | null;
  aprobados: Record<string, { sha256: string }>;
  adicionales: Adicional[];
  adicionalesPuestas: boolean;
  pendientes: Map<string, Pendiente>;
  numero: Map<string, number>; // cláusula → n
  parrafos: Map<string, string[]>; // cláusula → {P:} impresos, en orden
  n: { clausula: number; seccion: number; item: number; letra: number };
  clausula: string | null;
  cuadro: boolean;
  tabla: number;
  total: boolean;
  parte: { condiciones: Condiciones; valores: Valores } | null;
  refs: Resultado['refs'];
}

const NEG: R = { t: 'neg' };
const VACIO: R = { t: 'txt', v: MARCA };
const PEND_ON: R = { t: 'pend', on: true };
const PEND_OFF: R = { t: 'pend', on: false };

const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const faltante = (msg: string, details: Record<string, unknown>) =>
  new AppError(400, 'PLANTILLA_DATO_FALTANTE', msg, details);

/** Busca en el @cada con la clave completa ('parte.x') o sin el prefijo ('x'). */
function dato<T>(nombre: string, x: Paso, de: 'condiciones' | 'valores'): T | undefined {
  if (!nombre.startsWith('parte.')) return x.ctx?.[de][nombre] as T | undefined;
  const m = x.parte?.[de];
  return (m?.[nombre] ?? m?.[nombre.slice(6)]) as T | undefined;
}

function condicion(c: string, x: Paso): boolean {
  if (x.modo === 'fidelidad') return true;
  const v = dato<boolean>(c, x, 'condiciones');
  if (typeof v !== 'boolean')
    throw faltante(`Falta la condición ${c} del contrato`, { condicion: c });
  return v;
}

function campo(t: Extract<Tok, { t: 'campo' }>, x: Paso): R {
  if (x.modo === 'fidelidad') return VACIO;
  const v = dato<string | number>(t.campo, x, 'valores');
  if (
    v === undefined ||
    v === null ||
    (typeof v === 'number' && !Number.isFinite(v)) ||
    !String(v).trim()
  )
    throw faltante(`Falta el dato {${t.campo}} del contrato`, { campo: t.campo });
  let s: string;
  try {
    s = t.fmt ? (FORMATOS[t.fmt].fn as (v: unknown) => string)(v) : String(v);
  } catch (e) {
    throw faltante(`Dato inválido en {${t.campo}}: ${(e as Error).message}`, {
      campo: t.campo,
      valor: v,
    });
  }
  if (!x.p.def.cifras.includes(t.campo)) return { t: 'txt', v: s };
  const zona = x.cuadro ? 'cuadro' : x.clausula ? 'clausula' : 'resumen';
  const tabla = x.tabla >= 0 ? ` data-tabla="${x.tabla}"${x.total ? ' data-total="1"' : ''}` : '';
  return {
    t: 'html',
    v: `<span data-campo="${esc(t.campo)}" data-fmt="${esc(t.fmt!)}" data-zona="${zona}"${tabla}>${esc(s)}</span>`,
  };
}

function pendiente(x: Paso, id: string, tipo: Pendiente['tipo']) {
  x.pendientes.set(`${tipo}:${id}`, { id, tipo });
}

function resolverToks(toks: Tok[], x: Paso): R[] {
  const r: R[] = [];
  for (const t of toks) {
    if (t.t === 'txt' || t.t === 'neg' || t.t === 'cur') r.push(t);
    else if (t.t === 'N') r.push({ t: 'txt', v: mayus(ordinal(x.n.clausula)) });
    else if (t.t === 'S') r.push({ t: 'txt', v: String(++x.n.seccion) });
    else if (t.t === 'campo') r.push(campo(t, x));
    else if (t.t === 'linea')
      r.push(x.modo === 'fidelidad' ? VACIO : { t: 'html', v: '<span class="linea"></span>' });
    else if (t.t === 'casilla')
      r.push(
        x.modo === 'fidelidad'
          ? VACIO
          : {
              t: 'html',
              v: `<span class="casilla">${condicion(t.c, x) !== t.neg ? 'X' : ''}</span>`,
            },
      );
    else if (t.t === 'P') {
      x.parrafos.get(x.clausula!)!.push(t.id);
      r.push({ t: 'P', cl: x.clausula!, id: t.id });
    } else if (t.t === 'ref') r.push({ ...t, origen: x.clausula ?? '' });
    else if (condicion(t.c, x)) r.push(...resolverToks(t.word, x));
    else if (t.alt.t === 'pendiente') {
      pendiente(x, t.alt.id, 'texto');
      r.push(PEND_ON, { t: 'txt', v: `⟦PENDIENTE: ${t.alt.id}⟧` }, PEND_OFF);
    } else if (t.alt.t === 'borrador') {
      const aprobado = x.aprobados[t.alt.id]?.sha256 === t.alt.sha256;
      if (!aprobado) pendiente(x, t.alt.id, 'borrador');
      const cuerpo = resolverToks(t.alt.toks, x);
      r.push(...(aprobado ? cuerpo : [PEND_ON, ...cuerpo, PEND_OFF]));
    }
  }
  return r;
}

function resolverLinea(nd: NodoLinea, x: Paso): R[] {
  const r: R[] = [];
  if (nd.prefijo === '+') r.push(NEG, { t: 'txt', v: `${++x.n.item}.` }, NEG, { t: 'txt', v: ' ' });
  if (nd.prefijo === '+a')
    r.push(NEG, { t: 'txt', v: `${String.fromCharCode(96 + ++x.n.letra)})` }, NEG, {
      t: 'txt',
      v: ' ',
    });
  r.push(...resolverToks(nd.toks, x));
  if (r.some((t) => t.t === 'P')) x.n.item = x.n.letra = 0;
  return r;
}

function adicionales(x: Paso): El[] {
  if (x.modo === 'fidelidad') return [];
  x.adicionalesPuestas = true;
  return x.adicionales.map((a, k): El => {
    if (!a.titulo?.trim() || !a.texto?.trim())
      throw faltante(`La cláusula adicional ${k + 1} no tiene título o texto`, {
        campo: `adicionales[${k}]`,
      });
    const cabecera = `${mayus(ordinal(++x.n.clausula))}: ${mayus(a.titulo.trim()).replace(/\.*$/, '.')}`;
    return {
      e: 'p',
      kind: 'p',
      o: `adicional:${k + 1}`,
      inicio: true,
      r: [NEG, { t: 'txt', v: cabecera }, NEG, { t: 'txt', v: ` ${a.texto.trim()}` }],
    };
  });
}

function resolver(nodos: Nodo[], x: Paso): El[] {
  const out: El[] = [];
  for (const nd of nodos) {
    if (!nd.conds.every((c) => condicion(c.c, x) !== c.neg)) continue;
    const o = `${nd.o.parte}:${nd.o.linea}`;
    if (nd.n === 'ambito') {
      x.clausula = nd.tipo === 'clausula' ? nd.id : null;
      x.n.item = x.n.letra = 0;
      if (nd.tipo === 'clausula') {
        x.numero.set(nd.id, ++x.n.clausula);
        x.parrafos.set(nd.id, []);
      }
      // el título de las adicionales solo sale si hay adicionales (o en fidelidad, como el Word)
      if (nd.tipo === 'adicionales' && x.modo !== 'fidelidad' && !x.adicionales.length) continue;
      out.push(...resolver(nd.hijos, x));
      if (nd.tipo === 'adicionales') out.push(...adicionales(x));
    } else if (nd.n === 'linea') {
      if (nd.soloFidelidad && x.modo !== 'fidelidad') continue;
      out.push({ e: 'p', kind: nd.kind, o, inicio: nd.inicio, r: resolverLinea(nd, x) });
    } else if (nd.n === 'fila') {
      x.total = nd.total;
      out.push({ e: 'fila', o, celdas: nd.celdas.map((c) => resolverToks(c, x)) });
      x.total = false;
    } else if (nd.tipo === 'cada') {
      const items = x.modo === 'fidelidad' ? [null] : x.ctx?.roles[nd.rol];
      if (!Array.isArray(items))
        throw faltante(`Falta la lista de ${nd.rol} del contrato`, { rol: nd.rol });
      for (const item of items) {
        x.parte = item;
        out.push(...resolver(nd.hijos, x));
      }
      x.parte = null;
    } else {
      [x.cuadro, x.tabla] = [nd.tipo === 'cuadro', nd.tabla];
      const hijos = resolver(nd.hijos, x);
      [x.cuadro, x.tabla] = [false, -1];
      if (!hijos.length) continue;
      if (nd.tipo === 'cuadro' || nd.tipo === 'dinero')
        out.push({ e: 'tabla', clase: nd.tipo, filas: hijos });
      else if (nd.tipo === 'recuadro') out.push({ e: 'recuadro', hijos });
      else if (nd.tipo === 'firma')
        out.push({ e: 'firma', o, lineas: hijos.map((h) => (h.e === 'p' ? h.r : [])) });
      else out.push(...hijos);
    }
  }
  return out;
}

const suprimida = (origen: string, destino: string) =>
  new AppError(
    500,
    'PLANTILLA_REFERENCIA_A_SUPRIMIDA',
    `La cláusula ${origen || '(fuera de cláusula)'} remite a ${destino}, que no se imprime`,
    { origen, destino },
  );

/** Texto de {P:} y {ref:}: ya se sabe qué cláusulas y parágrafos sobrevivieron. */
function numeral(r: Extract<R, { t: 'P' | 'ref' }>, x: Paso): string {
  if (r.t === 'P') {
    const ps = x.parrafos.get(r.cl)!;
    return ps.length === 1 ? 'PARÁGRAFO' : `PARÁGRAFO ${mayus(ordinal(ps.indexOf(r.id) + 1, 'o'))}`;
  }
  const destino = r.p ? `${r.cl}/${r.p}` : r.cl;
  const n = x.numero.get(r.cl);
  if (n === undefined) throw suprimida(r.origen, destino);
  let texto = `Cláusula ${titulo(ordinal(n))}`;
  if (r.p) {
    const ps = x.parrafos.get(r.cl)!;
    if (!ps.includes(r.p)) throw suprimida(r.origen, destino);
    const par =
      ps.length === 1 ? 'Parágrafo' : `Parágrafo ${titulo(ordinal(ps.indexOf(r.p) + 1, 'o'))}`;
    texto = r.corta ? par : `${par} de la ${texto}`;
  }
  x.refs.push({ origen: r.origen, destino, texto });
  return texto;
}

function corridas<T>(xs: T[], clave: (x: T) => string): T[][] {
  const out: T[][] = [];
  for (const x of xs) {
    const u = out[out.length - 1];
    if (u && clave(u[0]) === clave(x)) u.push(x);
    else out.push([x]);
  }
  return out;
}

function html(rs: R[], x: Paso): string {
  const piezas: { h: string; b: boolean; i: boolean; p: boolean }[] = [];
  let [b, i, p] = [false, false, false];
  for (const r of rs) {
    if (r.t === 'neg') b = !b;
    else if (r.t === 'cur') i = !i;
    else if (r.t === 'pend') p = r.on;
    else
      piezas.push({ h: r.t === 'html' ? r.v : esc(r.t === 'txt' ? r.v : numeral(r, x)), b, i, p });
  }
  return corridas(piezas, (z) => String(z.p))
    .map((g) => {
      const dentro = corridas(g, (z) => `${z.b}${z.i}`)
        .map((c) => {
          const h = c.map((z) => z.h).join('');
          const cur = c[0].i ? `<i>${h}</i>` : h;
          return c[0].b ? `<b>${cur}</b>` : cur;
        })
        .join('');
      return g[0].p ? `<span class="pendiente">${dentro}</span>` : dentro;
    })
    .join('');
}

function emitir(els: El[], x: Paso): string {
  return els
    .map((el) => {
      switch (el.e) {
        case 'p':
          return `<p class="k-${el.kind}${el.inicio ? ' inicio' : ''}" data-o="${esc(el.o)}">${html(el.r, x)}</p>`;
        case 'fila':
          return `<tr>${el.celdas.map((c) => `<td class="k-celda" data-o="${esc(el.o)}">${html(c, x)}</td>`).join('')}</tr>`;
        case 'tabla':
          return `<table class="${el.clase}">${emitir(el.filas, x)}</table>`;
        case 'recuadro':
          return `<div class="recuadro">${emitir(el.hijos, x)}</div>`;
        case 'firma':
          return `<p class="k-firma" data-o="${esc(el.o)}">${el.lineas.map((r) => html(r, x)).join('<br>')}</p>`;
      }
    })
    .join('\n');
}

/**
 * HTML del contrato. En modo 'fidelidad' (ctx null) toda condición es
 * verdadera, @cada corre una vez y todo campo imprime ▢. En modo 'final'
 * lanza PLANTILLA_TEXTO_PENDIENTE si queda algo pendiente y luego corre
 * verificarSinMarcadores (el control de "coarrendatari" se activa con la
 * condición coa en falso).
 */
export function renderizar(
  p: Plantilla,
  ctx: Contexto | null,
  o: { modo: Modo; adicionales?: Adicional[]; aprobados?: Record<string, { sha256: string }> },
): Resultado {
  if (!ctx && o.modo !== 'fidelidad')
    throw new AppError(
      500,
      'PLANTILLA_INVALIDA',
      'Sin contexto solo se renderiza en modo fidelidad',
    );
  const x: Paso = {
    p,
    modo: o.modo,
    ctx: o.modo === 'fidelidad' ? null : ctx,
    aprobados: o.aprobados ?? {},
    adicionales: o.adicionales ?? [],
    adicionalesPuestas: false,
    pendientes: new Map(),
    numero: new Map(),
    parrafos: new Map(),
    n: { clausula: 0, seccion: 0, item: 0, letra: 0 },
    clausula: null,
    cuadro: false,
    tabla: -1,
    total: false,
    parte: null,
    refs: [],
  };
  const doc = emitir(resolver(p.nodos, x), x);
  if (x.modo !== 'fidelidad' && x.adicionales.length && !x.adicionalesPuestas)
    throw new AppError(
      400,
      'PLANTILLA_NO_SOPORTA',
      'Esta plantilla no admite cláusulas adicionales',
    );
  const { lineas, origenes, asientos } = leerHtml(doc);
  const pendientes = [...x.pendientes.values()];
  if (o.modo === 'final') {
    if (pendientes.length)
      throw new AppError(
        422,
        'PLANTILLA_TEXTO_PENDIENTE',
        'El contrato tiene textos pendientes de aprobación',
        { pendientes },
      );
    verificarSinMarcadores(lineas, { sinCoarrendatario: ctx!.condiciones.coa === false });
  }
  return { html: doc, lineas, origenes, asientos, refs: x.refs, pendientes };
}

// ── Del HTML al texto (diseño §4.2.5) ──

type Seg = { t: string; b: boolean; i: boolean };

const ENTIDADES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
const decodificar = (s: string) =>
  s.replace(/&(#\d+|\w+);/g, (m, e: string) =>
    Object.hasOwn(ENTIDADES, e)
      ? ENTIDADES[e]
      : e.startsWith('#')
        ? String.fromCodePoint(Number(e.slice(1)))
        : m,
  );

const normalizar = (s: string) =>
  s
    .normalize('NFC')
    .replace(/\u00A0/g, ' ')
    .replace(/[Xx]{3,}|_{3,}/g, MARCA)
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Una línea desde tramos con formato (la usa también el extractor del Word):
 * el espacio no cambia de formato, los tramos iguales se unen, el espacio sale
 * de los marcadores ** / * y se normaliza (NFC, NBSP, XXX/___ → ▢, espacios).
 */
export function lineaDeSegmentos(kind: string, segs: Seg[]): Linea {
  const tramos: Seg[] = [];
  for (const s of segs) {
    if (!s.t) continue;
    const u = tramos[tramos.length - 1];
    if (u && (!s.t.trim() || (u.b === s.b && u.i === s.i))) u.t += s.t;
    else if (u && !u.t.trim()) Object.assign(u, { t: u.t + s.t, b: s.b, i: s.i });
    else tramos.push({ ...s });
  }
  const texto = tramos
    .map(({ t, b, i }) => {
      const [, antes, nucleo, despues] = /^(\s*)([\s\S]*?)(\s*)$/.exec(t)!;
      const m = b && i ? '***' : b ? '**' : i ? '*' : '';
      return nucleo ? antes + m + nucleo + m + despues : t;
    })
    .join('');
  return { kind, texto: normalizar(texto) };
}

/** Recorre el HTML que emite el motor: cada elemento k-* es una línea; los span data-campo, asientos. */
function leerHtml(doc: string): { lineas: Linea[]; origenes: string[]; asientos: Asiento[] } {
  const lineas: Linea[] = [];
  const origenes: string[] = [];
  const asientos: Asiento[] = [];
  const pila: ((() => void) | null)[] = [];
  let actual: { kind: string; o: string; segs: Seg[] } | null = null;
  let asiento: Asiento | null = null;
  let [b, i] = [0, 0];
  for (const [, cierre, tag, attrs, texto] of doc.matchAll(
    /<(\/?)([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g,
  )) {
    if (texto !== undefined) {
      const t = decodificar(texto);
      actual?.segs.push({ t, b: b > 0, i: i > 0 });
      if (asiento) asiento.texto += t;
      continue;
    }
    const nombre = tag.toLowerCase();
    if (nombre === 'br') actual?.segs.push({ t: ' ', b: b > 0, i: i > 0 });
    if (['br', 'img', 'meta', 'hr'].includes(nombre) || attrs.endsWith('/')) continue;
    if (cierre) {
      pila.pop()?.();
      continue;
    }
    const a: Record<string, string> = {};
    for (const [, k, v] of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) a[k] = decodificar(v);
    const kind = /(?:^|\s)k-([\w-]+)/.exec(a.class ?? '')?.[1];
    if (kind && !actual) {
      const l: { kind: string; o: string; segs: Seg[] } = { kind, o: a['data-o'] ?? '', segs: [] };
      actual = l;
      pila.push(() => {
        lineas.push(lineaDeSegmentos(l.kind, l.segs));
        origenes.push(l.o);
        actual = null;
      });
    } else if (a['data-campo'] && !asiento) {
      const s: Asiento = {
        campo: a['data-campo'],
        fmt: a['data-fmt'] ?? '',
        zona: a['data-zona'] as Asiento['zona'],
        texto: '',
        ...(a['data-tabla'] !== undefined && { tabla: Number(a['data-tabla']) }),
        ...(a['data-total'] !== undefined && { total: true }),
      };
      asiento = s;
      pila.push(() => {
        asientos.push(s);
        asiento = null;
      });
    } else if (nombre === 'b' || nombre === 'strong') {
      b++;
      pila.push(() => b--);
    } else if (nombre === 'i' || nombre === 'em') {
      i++;
      pila.push(() => i--);
    } else pila.push(null);
  }
  return { lineas, origenes, asientos };
}

/** Líneas (kind + texto con ** y *) de un HTML del motor: la única fuente de texto de las verificaciones. */
export function htmlATexto(doc: string): Linea[] {
  return leerHtml(doc).lineas;
}

/** El libro de cifras impresas de un HTML del motor (lo que lee verificarCoherencia). */
export function asientosDeHtml(doc: string): Asiento[] {
  return leerHtml(doc).asientos;
}

// ── Verificaciones (diseño §4.2.6–7) ──

const MARCADOR = /[Xx]{3,}|_{3,}|▢|⟦|[{}]|NO APLICA|\b(undefined|null|NaN)\b/;

export function verificarSinMarcadores(l: Linea[], o: { sinCoarrendatario: boolean }): void {
  for (const { kind, texto } of l) {
    const m = MARCADOR.exec(texto) ?? (o.sinCoarrendatario ? /coarrendatari/i.exec(texto) : null);
    if (m)
      throw new AppError(
        500,
        'PLANTILLA_MARCADOR',
        `Queda "${m[0]}" en el texto impreso: ${texto.slice(0, 120)}`,
        {
          marcador: m[0],
          kind,
          texto,
        },
      );
  }
}

const SIN_IMPRIMIR = Symbol('sin imprimir');

/**
 * Coherencia de las cifras IMPRESAS (422 CONTRATO_RESUMEN_INCOHERENTE):
 * cada campo se lee igual en todas partes; lo que muestra el resumen está en
 * una cláusula, se deriva o es un total; las derivadas cuadran con lo impreso
 * (si sus insumos están impresos); cada total de @dinero es la suma de sus filas.
 */
export function verificarCoherencia(
  a: Asiento[],
  derivadas: Record<string, (v: (c: string) => number) => number>,
): void {
  const incoherente = (campo: string, valores: unknown, msg: string) =>
    new AppError(422, 'CONTRATO_RESUMEN_INCOHERENTE', `${msg}: {${campo}}`, { campo, valores });
  const leer = (x: Asiento) => FORMATOS[x.fmt]?.inverso?.(x.texto);

  const valor = new Map<string, number>();
  for (const campo of new Set(a.map((x) => x.campo))) {
    const xs = a.filter((x) => x.campo === campo);
    const nums = [...new Set(xs.map(leer).filter((n): n is number => n !== undefined))];
    if (nums.length > 1 || nums.some(Number.isNaN))
      throw incoherente(
        campo,
        xs.map((x) => x.texto),
        'La misma cifra se imprime con valores distintos',
      );
    for (const x of xs) {
      if (FORMATOS[x.fmt]?.inverso) continue;
      // formatos sin inverso (letras, meses): tienen que decir lo mismo que la cifra, o entre sí
      const igual = nums.length
        ? (FORMATOS[x.fmt].fn as (v: number) => string)(nums[0]) === x.texto
        : xs.every((y) => y.fmt !== x.fmt || y.texto === x.texto);
      if (!igual)
        throw incoherente(
          campo,
          xs.map((y) => y.texto),
          'La cifra en letras no coincide con la cifra',
        );
    }
    if (nums.length) valor.set(campo, nums[0]);
  }

  const enClausula = new Set(a.filter((x) => x.zona === 'clausula').map((x) => x.campo));
  for (const x of a)
    if (
      x.zona === 'resumen' &&
      !x.total &&
      !enClausula.has(x.campo) &&
      !Object.hasOwn(derivadas, x.campo)
    )
      throw incoherente(
        x.campo,
        [x.texto],
        'El resumen muestra una cifra que no está en las cláusulas',
      );

  for (const [campo, f] of Object.entries(derivadas)) {
    const impreso = valor.get(campo);
    if (impreso === undefined) continue;
    let esperado: number;
    try {
      esperado = f((c) => {
        const n = valor.get(c);
        if (n === undefined) throw SIN_IMPRIMIR;
        return n;
      });
    } catch (e) {
      if (e === SIN_IMPRIMIR) continue;
      throw e;
    }
    if (esperado !== impreso)
      throw incoherente(campo, { impreso, esperado }, 'La cifra derivada no cuadra con lo impreso');
  }

  for (const t of new Set(a.filter((x) => x.tabla !== undefined).map((x) => x.tabla))) {
    const pesos = a.filter((x) => x.tabla === t && x.fmt === 'pesos');
    const suma = pesos.filter((x) => !x.total).reduce((s, x) => s + leer(x)!, 0);
    for (const x of pesos.filter((y) => y.total))
      if (leer(x) !== suma)
        throw incoherente(
          x.campo,
          { impreso: leer(x), suma },
          'El total no es la suma de sus filas',
        );
  }
}

/**
 * Todo lo que el motor puede quitar del texto Word, por condición (para la
 * lista autorizada §8.4): líneas "?c …" con su fuente; ámbitos y bloques
 * "?c @… (N líneas)"; tramos "[[texto Word]]" con alternativa vacía. Aparte,
 * "@cada <rol>": el contenido de cada bloque repetible, unido con " · ".
 */
export function inventarioSupresiones(p: Plantilla): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const anotar = (clave: string, s: string) => (out[clave] ??= []).push(s);
  const contar = (nds: Nodo[]): number =>
    nds.reduce((s, n) => s + (n.n === 'linea' || n.n === 'fila' ? 1 : contar(n.hijos)), 0);
  const describir = (n: Nodo): string => {
    if (n.n === 'linea' || n.n === 'fila') return n.fuente;
    if (n.tipo === 'cada') return n.hijos.map(describir).join(' · ');
    const k = contar(n.hijos);
    return `${n.fuente} (${k} ${k === 1 ? 'línea' : 'líneas'})`;
  };
  const vacias = (toks: Tok[]) => {
    for (const t of toks) if (t.t === 'alt' && t.alt.t === 'vacia') anotar(t.c, `[[${t.fuente}]]`);
  };
  const recorrer = (nds: Nodo[]) => {
    for (const n of nds) {
      if (!n.conds.some((c) => c.neg)) for (const c of n.conds) anotar(c.c, describir(n));
      if (n.n === 'linea') vacias(n.toks);
      else if (n.n === 'fila') n.celdas.forEach(vacias);
      else {
        if (n.n === 'caja' && n.tipo === 'cada') anotar(`@cada ${n.rol}`, describir(n));
        recorrer(n.hijos);
      }
    }
  };
  recorrer(p.nodos);
  return out;
}
