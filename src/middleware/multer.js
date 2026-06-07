const multer = require('multer');
const path   = require('path');
const os     = require('os');

// ─── Disk storage ─────────────────────────────────────────────────────────────
// Files land in the OS temp dir, then your existing uploadToCloudinary()
// picks them up by file.path and deletes them after upload.
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, os.tmpdir()),
  filename:    (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});

// ─── File filters ─────────────────────────────────────────────────────────────
const imageFilter = (_req, file, cb) => {
  if (file.mimetype.startsWith('image/')) return cb(null, true);
  cb(new Error('Only image files are allowed'));
};

const videoFilter = (_req, file, cb) => {
  if (file.mimetype.startsWith('video/')) return cb(null, true);
  cb(new Error('Only video files are allowed'));
};

// ─── Multer instances ─────────────────────────────────────────────────────────
const IMAGE_LIMIT = 10  * 1024 * 1024;  // 10 MB
const VIDEO_LIMIT = 200 * 1024 * 1024;  // 200 MB

/** Single image — for posts, AMA cover, event banner */
const singleImage = multer({
  storage,
  limits:     { fileSize: IMAGE_LIMIT },
  fileFilter: imageFilter,
}).single('image');

/** Single video */
const singleVideo = multer({
  storage,
  limits:     { fileSize: VIDEO_LIMIT },
  fileFilter: videoFilter,
}).single('video');

// ─── Promise wrappers ─────────────────────────────────────────────────────────
// Keeps controllers clean — await parseImage(req, res) instead of callbacks.
// Multer errors surface as thrown exceptions that controllers catch normally.
const wrap = (middleware) => (req, res) =>
  new Promise((resolve, reject) =>
    middleware(req, res, (err) => (err ? reject(err) : resolve()))
  );

module.exports = {
  parseImage: wrap(singleImage),
  parseVideo: wrap(singleVideo),
};