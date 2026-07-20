const mongoose = require('mongoose');

/**
 * Upload — a media file (image) stored in MongoDB rather than on disk.
 *
 * BotGuard's container has NO persistent filesystem (see DEPLOYMENT.md), so
 * anything written locally is wiped on redeploy. Storing bytes in Mongo means
 * uploads survive deploys with no volume config, consistent with the rest of
 * the app ("everything is in Mongo").
 *
 * Served at a WordPress-looking URL so links are clean and reinforce the WP
 * fingerprint:  /wp-content/uploads/<id>/<filename>
 */
const UploadSchema = new mongoose.Schema({
  workspace_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', index: true, required: true },
  filename: { type: String, required: true },   // sanitized original name, used in the URL
  mimetype: { type: String, required: true },   // image/png, image/jpeg, ...
  size: { type: Number, required: true },        // bytes

  // Which backend holds the bytes. Defaults to 'mongo' so uploads created
  // before this change (which have `data` and no `storage`) keep working.
  storage: { type: String, enum: ['mongo', 'local', 's3'], default: 'mongo' },
  data: { type: Buffer },            // bytes — ONLY for storage:'mongo'
  storage_key: { type: String },     // filesystem path (local) or object key (s3)

  created_at: { type: Date, default: Date.now, index: true },
});

UploadSchema.index({ workspace_id: 1, created_at: -1 });

module.exports = mongoose.model('Upload', UploadSchema);
