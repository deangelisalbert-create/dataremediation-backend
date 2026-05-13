// services/cleanup.js — Suppression automatique des fichiers expirés
const fs = require('fs');
const { pool } = require('../config/database');
const { safeLog } = require('../middleware/errorHandler');

async function cleanupExpiredFiles() {
  let deletedCount = 0;

  try {
    // Récupérer les fichiers expirés
    const result = await pool.query(
      `SELECT id, file_path, tenant_id
       FROM audit_files
       WHERE expires_at < NOW() AND status != 'deleted'
       LIMIT 100`
    );

    for (const row of result.rows) {
      try {
        // Supprimer fichier physique s'il existe encore
        if (row.file_path && fs.existsSync(row.file_path)) {
          fs.unlinkSync(row.file_path);
        }

        // Marquer comme supprimé en base (ou supprimer complètement)
        await pool.query(
          `DELETE FROM audit_files WHERE id = $1`,
          [row.id]
        );

        deletedCount++;
      } catch (fileErr) {
        safeLog('warn', 'CLEANUP_FILE_ERROR', { tenantId: row.tenant_id });
      }
    }

    // Nettoyer aussi les refresh tokens expirés
    await pool.query(
      `DELETE FROM refresh_tokens WHERE expires_at < NOW() OR revoked = true`
    );

    return deletedCount;
  } catch (err) {
    safeLog('error', 'CLEANUP_ERROR', {});
    throw err;
  }
}

module.exports = { cleanupExpiredFiles };
