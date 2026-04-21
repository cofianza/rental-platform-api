export const INMUEBLE_FIELD_LABELS: Record<string, string> = {
  direccion: 'Direccion',
  ciudad: 'Ciudad',
  barrio: 'Barrio',
  departamento: 'Departamento',
  tipo: 'Tipo de inmueble',
  uso: 'Uso',
  destinacion: 'Destinacion',
  estrato: 'Estrato',
  valor_arriendo: 'Valor de arriendo',
  valor_comercial: 'Valor comercial',
  administracion: 'Administracion',
  area_m2: 'Area (m2)',
  habitaciones: 'Habitaciones',
  banos: 'Banos',
  parqueadero: 'Parqueadero',
  parqueaderos: 'Cantidad de parqueaderos',
  piso: 'Piso',
  latitud: 'Latitud',
  longitud: 'Longitud',
  descripcion: 'Descripcion',
  notas_internas: 'Notas internas',
  estado: 'Estado',
  propietario_id: 'Propietario',
  visible_vitrina: 'Visible en vitrina',
  foto_fachada_url: 'Foto de fachada',
};

export function getFieldLabel(campo: string): string {
  return INMUEBLE_FIELD_LABELS[campo] || campo;
}
