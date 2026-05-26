const cloudinary = require('cloudinary').v2;
const fs = require('fs').promises;
require('dotenv').config();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Safe temp file deletion — never throws, just logs
const deleteTempFile = async (filePath) => {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // ENOENT means already deleted — that's fine, ignore it
      console.error('Error deleting temp file:', filePath, err.message);
    }
  }
};

const uploadToCloudinary = async (file, folder) => {
  try {
    const result = await cloudinary.uploader.upload(file.path, {
      folder: `swahili_marketplace/${folder}`,
      allowed_formats: ['jpg', 'png', 'jpeg', 'gif', 'webp'],
      transformation: [
        // All in one step — one transformation charge, cleaner pipeline
        {
          width: 500,
          height: 500,
          crop: 'limit',
          quality: 'auto:best',
          fetch_format: 'auto'
        }
      ]
    });
    return result.secure_url;
  } catch (error) {
    console.error('Cloudinary Upload Error:', error);
    throw new Error(`Image upload failed: ${error.message}`);
  }
};

// Upload with a concurrency limit to avoid rate-limit rejections
const uploadWithConcurrencyLimit = async (files, folder, concurrency = 3) => {
  const results = [];
  const errors = [];

  // Process in batches of `concurrency`
  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency);

    const batchResults = await Promise.allSettled(
      batch.map(async (file) => {
        try {
          const imageUrl = await uploadToCloudinary(file, folder);
          await deleteTempFile(file.path); // safe to call here now
          return {
            imageUrl,
            originalName: file.originalname,
            mimeType: file.mimetype,
            size: file.size
          };
        } catch (err) {
          await deleteTempFile(file.path); // clean up even on failure
          throw err;
        }
      })
    );

    batchResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        errors.push({
          file: batch[index].originalname,
          error: result.reason.message
        });
      }
    });
  }

  return { results, errors };
};

module.exports = {
  cloudinary,
  uploadToCloudinary,
  uploadWithConcurrencyLimit,
  deleteTempFile
};