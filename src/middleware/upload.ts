import multer from 'multer';
import type { Request } from 'express';
import { AppError } from '@/lib/errors';

const PDF_MAX_SIZE = 20 * 1024 * 1024; // 20 MB

const storage = multer.memoryStorage();

function pdfFileFilter(
  _req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback,
) {
  if (file.mimetype !== 'application/pdf') {
    cb(new AppError(400, 'INVALID_FILE_TYPE', 'Solo se aceptan archivos PDF'));
    return;
  }
  cb(null, true);
}

const upload = multer({
  storage,
  limits: { fileSize: PDF_MAX_SIZE },
  fileFilter: pdfFileFilter,
});

/**
 * Middleware para recibir un solo archivo PDF en el campo "archivo".
 * El archivo queda disponible en req.file (buffer en memoria).
 */
export const uploadPdf = upload.single('archivo');
