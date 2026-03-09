import multer from 'multer';
import type { Request } from 'express';
import { AppError } from '@/lib/errors';

const PDF_MAX_SIZE = 20 * 1024 * 1024; // 20 MB
const DOC_MAX_SIZE = 20 * 1024 * 1024; // 20 MB

const ALLOWED_DOC_MIMETYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
];

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

function docFileFilter(
  _req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback,
) {
  if (!ALLOWED_DOC_MIMETYPES.includes(file.mimetype)) {
    cb(new AppError(400, 'INVALID_FILE_TYPE', 'Solo se aceptan archivos PDF, JPEG, PNG o WebP'));
    return;
  }
  cb(null, true);
}

const uploadPdfMulter = multer({
  storage,
  limits: { fileSize: PDF_MAX_SIZE },
  fileFilter: pdfFileFilter,
});

const uploadDocMulter = multer({
  storage,
  limits: { fileSize: DOC_MAX_SIZE },
  fileFilter: docFileFilter,
});

/**
 * Middleware para recibir un solo archivo PDF en el campo "archivo".
 * El archivo queda disponible en req.file (buffer en memoria).
 */
export const uploadPdf = uploadPdfMulter.single('archivo');

/**
 * Middleware para recibir un solo documento (PDF, JPEG, PNG, WebP) en el campo "archivo".
 */
export const uploadDoc = uploadDocMulter.single('archivo');
