import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { authMiddleware, roleGuard } from '@/middleware/auth';
import { uploadDoc } from '@/middleware/upload';
import { tipoParamsSchema } from './documentos-legales.schema';
import * as controller from './documentos-legales.controller';

const router = Router();

// Todas las rutas requieren auth. Solo inmobiliaria, propietario o
// administrador acceden a documentos legales propios. El admin tambien
// puede leer los de otros perfiles via ?perfilId= en download.
router.use(authMiddleware);
router.use(roleGuard(['administrador', 'inmobiliaria', 'propietario', 'operador_analista']));

// GET / — lista los 7 tipos con su estado para el perfil autenticado
router.get('/', controller.listMine);

// POST /:tipo — sube un documento (multipart con campo "archivo")
router.post(
  '/:tipo',
  validate({ params: tipoParamsSchema }),
  uploadDoc,
  controller.upload,
);

// GET /:tipo/download — devuelve URL firmada temporal de descarga
router.get(
  '/:tipo/download',
  validate({ params: tipoParamsSchema }),
  controller.download,
);

// DELETE /:tipo — elimina del storage y de la DB (idempotente)
router.delete(
  '/:tipo',
  validate({ params: tipoParamsSchema }),
  controller.remove,
);

export default router;
