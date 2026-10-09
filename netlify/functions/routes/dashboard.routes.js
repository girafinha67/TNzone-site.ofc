'use strict';

const express = require('express');
const db = require('../lib/db');
const { asyncHandler } = require('../lib/http-utils');

const router = express.Router();

router.get(
  '/admin/dashboard',
  asyncHandler(async (req, res) => {
    const totalProducts = (await db.get('SELECT COUNT(*) AS n FROM products')).n;
    const activeProducts = (await db.get('SELECT COUNT(*) AS n FROM products WHERE active = 1')).n;
    const outOfStock = (await db.get('SELECT COUNT(*) AS n FROM products WHERE stock <= 0')).n;
    const totalCategories = (await db.get('SELECT COUNT(*) AS n FROM categories')).n;
    const recentProducts = await db.all(
      'SELECT id, name, slug, price, active, created_at FROM products ORDER BY created_at DESC LIMIT 5'
    );
    const recentActivity = await db.all(
      `SELECT l.action, l.details, l.created_at, a.email AS admin_email
       FROM logs l LEFT JOIN admins a ON a.id = l.admin_id
       ORDER BY l.created_at DESC LIMIT 15`
    );

    res.status(200).json({
      totalProducts: Number(totalProducts),
      activeProducts: Number(activeProducts),
      outOfStock: Number(outOfStock),
      totalCategories: Number(totalCategories),
      recentProducts,
      recentActivity,
    });
  })
);

module.exports = router;
