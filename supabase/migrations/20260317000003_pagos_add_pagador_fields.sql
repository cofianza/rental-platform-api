-- ============================================================
-- Migration: Add email_pagador and nombre_pagador to pagos
-- HP-348: Payment link creation with email notifications
-- ============================================================

ALTER TABLE pagos ADD COLUMN IF NOT EXISTS email_pagador VARCHAR(255);
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS nombre_pagador VARCHAR(200);
