import { Router } from 'express';
import multer from 'multer';
import { authMiddleware, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { AppError } from '@/lib/errors';
import { updatePerfilArrendadorSchema } from './perfil-arrendador.schema';
import * as controller from './perfil-arrendador.controller';

const LOGO_MAX_SIZE = 2 * 1024 * 1024; // 2 MB
const ALLOWED_LOGO_MIMETYPES = ['image/png', 'image/jpeg', 'image/webp'];

const uploadLogoMulter = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LOGO_MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_LOGO_MIMETYPES.includes(file.mimetype)) {
      cb(new AppError(400, 'INVALID_FILE_TYPE', 'Solo PNG, JPG o WebP para el logo'));
      return;
    }
    cb(null, true);
  },
});

const router = Router();

router.use(authMiddleware);
router.use(roleGuard(['administrador', 'inmobiliaria', 'propietario']));

router.get('/me', controller.getMe);
router.get('/me/completitud', controller.getCompletitud);
router.put('/me', validate({ body: updatePerfilArrendadorSchema }), controller.updateMe);
router.post('/me/logo', uploadLogoMulter.single('logo'), controller.uploadLogo);
router.delete('/me/logo', controller.deleteLogo);

export default router;
