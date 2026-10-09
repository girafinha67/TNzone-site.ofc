'use strict';

const express = require('express');
const { asyncHandler } = require('../lib/http-utils');
const { saveBase64Image } = require('../lib/upload');
const { log } = require('../lib/auth');

const router = express.Router();

// POST /api/admin/uploads — body: { image: "data:image/png;base64,..." }
router.post(
  '/admin/uploads',
  asyncHandler(async (req, res) => {
    const result = await saveBase64Image(req.body.image);
    await log(req.admin.id, 'image_upload', { publicId: result.publicId });
    res.status(201).json(result);
  })
);

module.exports = router;
