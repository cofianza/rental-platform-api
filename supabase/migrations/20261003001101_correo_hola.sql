-- El correo de contacto público vuelve a hola@cofianza.co (2026-10-02): el
-- buzón ya existe. getCompany() lee el correo de configuracion_sistema ENCIMA
-- de src/config/company.ts, así que sin esto el pie de los correos, los
-- certificados y los mensajes de apelación siguen diciendo gerencia@.
-- gerencia@cofianza.co sigue siendo la cuenta de ingreso del administrador:
-- esto no la toca. Solo reemplaza texto; no toca contratos ya generados.

UPDATE configuracion_sistema
   SET valor = replace(valor, 'gerencia@cofianza.co', 'hola@cofianza.co')
 WHERE clave = 'empresa'
   AND valor LIKE '%gerencia@cofianza.co%';

UPDATE plantillas_contrato
   SET contenido_html = replace(contenido_html, 'gerencia@cofianza.co', 'hola@cofianza.co')
 WHERE contenido_html LIKE '%gerencia@cofianza.co%';

-- Comprobación: ambas deben dar 0.
SELECT
  (SELECT count(*) FROM configuracion_sistema WHERE clave = 'empresa' AND valor LIKE '%gerencia@cofianza.co%') AS empresa_con_gerencia,
  (SELECT count(*) FROM plantillas_contrato WHERE contenido_html LIKE '%gerencia@cofianza.co%') AS plantillas_con_gerencia;
