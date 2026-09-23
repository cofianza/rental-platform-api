/**
 * Escapa texto antes de interpolarlo en HTML (correos, plantillas). Todo lo que
 * escribe una persona (nombres, direcciones, notas, motivos, mensajes) pasa por
 * aquí: sin escapar, un `<a href>` tecleado por cualquiera saldría dentro de un
 * correo legítimo del dominio verificado de Cofianza — phishing con nuestra
 * propia marca. Los asuntos van en texto plano y no lo necesitan.
 */
export function escapeHtml(texto: string): string {
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
