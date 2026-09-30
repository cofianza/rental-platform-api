-- hola@cofianza.co no existe como buzón (2026-09-30): el canal real es
-- gerencia@cofianza.co. getCompany() lee el correo de configuracion_sistema
-- ENCIMA de src/config/company.ts, así que sin esto el pie de los correos,
-- los certificados y los mensajes de apelación siguen diciendo hola@.
-- Solo reemplaza el texto; no toca contratos ya generados.

UPDATE configuracion_sistema
   SET valor = replace(valor, 'hola@cofianza.co', 'gerencia@cofianza.co')
 WHERE clave = 'empresa'
   AND valor LIKE '%hola@cofianza.co%';

UPDATE plantillas_contrato
   SET contenido_html = replace(contenido_html, 'hola@cofianza.co', 'gerencia@cofianza.co')
 WHERE contenido_html LIKE '%hola@cofianza.co%';

-- Comprobación: ambas deben dar 0.
SELECT
  (SELECT count(*) FROM configuracion_sistema WHERE clave = 'empresa' AND valor LIKE '%hola@cofianza.co%') AS empresa_con_hola,
  (SELECT count(*) FROM plantillas_contrato WHERE contenido_html LIKE '%hola@cofianza.co%') AS plantillas_con_hola;
