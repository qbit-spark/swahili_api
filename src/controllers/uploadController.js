const { uploadToCloudinary, uploadWithConcurrencyLimit, deleteTempFile } = require('../config/cloudinary');

exports.uploadImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, data: null, errors: ['No file uploaded'] });
    }

    const imageUrl = await uploadToCloudinary(req.file, req.query.folder || 'general');
    await deleteTempFile(req.file.path);

    res.json({
      success: true,
      data: {
        imageUrl,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size
      },
      errors: []
    });
  } catch (err) {
    await deleteTempFile(req.file?.path);
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};

exports.uploadMultipleImages = async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, data: null, errors: ['No files uploaded'] });
    }

    const folder = req.query.folder || 'general';
    const { results, errors } = await uploadWithConcurrencyLimit(req.files, folder, 3);

    // Partial success — some uploaded, some failed
    if (errors.length > 0 && results.length > 0) {
      return res.status(207).json({
        success: true,
        data: { images: results },
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

    // All succeeded
    res.json({ success: true, data: { images: results }, errors: [] });

  } catch (err) {
    // Safety net — clean up any remaining temp files
    if (req.files) {
      await Promise.allSettled(req.files.map(f => deleteTempFile(f.path)));
    }
    res.status(500).json({ success: false, data: null, errors: [err.message] });
  }
};