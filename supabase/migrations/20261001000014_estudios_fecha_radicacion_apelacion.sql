-- Política §11: la apelación del no aprobado se radica en 15 días hábiles desde
-- la notificación, y Cofianza responde en 10 desde la radicación. Hasta ahora la
-- radicación era la fecha del primer soporte subido: si el prospecto apelaba a
-- tiempo por correo y el analista subía el soporte después del día 15, quedaba
-- como tardía. El analista registra aquí el día en que el prospecto apeló (fecha
-- de Bogotá). NULL = vale el primer soporte, como antes. Idempotente; la API ya
-- desplegada funciona sin esta columna (la lee aparte y la trata como NULL).
ALTER TABLE public.estudios
  ADD COLUMN IF NOT EXISTS fecha_radicacion_apelacion DATE;

COMMENT ON COLUMN public.estudios.fecha_radicacion_apelacion IS
  'Día (Bogotá) en que el prospecto radicó la apelación por correo u otro canal, registrado por el analista (Política §11). NULL = cuenta el primer soporte subido.';
