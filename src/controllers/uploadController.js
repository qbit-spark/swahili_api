const {
  uploadToCloudinary,
  uploadWithConcurrencyLimit,
  deleteTempFile
} = require('../config/cloudinary');

const { formatFileSize } = require('../utils/formatFileSize');

/**
 * SINGLE IMAGE UPLOAD
 */
exports.uploadImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        data: null,
        errors: ['No file uploaded']
      });
    }

    const imageUrl = await uploadToCloudinary(
      req.file,
      req.query.folder || 'general'
    );

    await deleteTempFile(req.file.path);

    return res.json({
      success: true,
      data: {
        imageUrl,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,

        // raw machine-friendly value
        size: req.file.size,

        // human-friendly value
        readableSize: formatFileSize(req.file.size)
      },
      errors: []
    });

  } catch (err) {
    await deleteTempFile(req.file?.path);

    return res.status(500).json({
      success: false,
      data: null,
      errors: [err.message]
    });
  }
};

/**
 * MULTIPLE IMAGE UPLOAD
 */
exports.uploadMultipleImages = async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        data: null,
        errors: ['No files uploaded']
      });
    }

    const folder = req.query.folder || 'general';

    const { results, errors } = await uploadWithConcurrencyLimit(
      req.files,
      folder,
      3
    );

    // Add readable sizes to successful uploads
    const formattedResults = results.map((file) => ({
      ...file,
      readableSize: formatFileSize(file.size)
    }));

    // Partial success
    if (errors.length > 0 && results.length > 0) {
      return res.status(207).json({
        success: true,
        data: {
          images: formattedResults
        },
        errors: errors.map(e => `${e.file}: ${e.error}`)
      });
    }

    // Total failure
    if (errors.length > 0 && results.length === 0) {
      return res.status(500).json({
        success: false,
        data: null,
        errors: errors.map(e => `${e.file}: ${e.error}`)
      });
    }

    // Full success
    return res.json({
      success: true,
      data: {
        images: formattedResults
      },
      errors: []
    });

  } catch (err) {
    // Cleanup temp files safely
    if (req.files) {
      await Promise.allSettled(
        req.files.map(f => deleteTempFile(f.path))
      );
    }

    return res.status(500).json({
      success: false,
      data: null,
      errors: [err.message]
    });
  }
};